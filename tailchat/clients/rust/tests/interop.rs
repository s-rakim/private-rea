//! End-to-end tests against a real Tailchat server in dev mode, proving
//! interoperability both ways with the reference crypto in public/crypto.js.

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use common::{pattern, start_server, wait_for, Cli, Peer, TempDir};
use serde_json::{json, Value};

const MIB: usize = 1024 * 1024;

fn listing(dir: &Path) -> BTreeSet<String> {
    fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|s| s.to_string()).collect()
}

#[test]
fn interop_both_ways_with_reference_crypto() {
    let tmp = TempDir::new("interop");
    let server = start_server(&tmp);
    let mut js = Peer::start(&server);
    let js_reg = js.call("register", json!({ "user": "jsuser" }));
    assert_eq!(js_reg["userId"], "jsuser@dev");

    // First use registers the Rust device (0600 state file).
    let rust = Cli::new(&server, &tmp, "rusty");
    let who = rust.run(&["whoami"]);
    assert!(who.contains("user:          rusty@dev"), "{who}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&rust.state).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // A second run reuses the same device.
    let device_line = who.lines().find(|l| l.starts_with("device:")).unwrap().to_string();
    assert!(rust.run(&["whoami"]).contains(&device_line));

    // Security codes agree with securityCode() in crypto.js.
    let code = js.call("securityCode", json!({ "userId": "rusty@dev" }))["code"].as_str().unwrap().to_string();
    assert!(who.contains(&format!("security code: {code}")), "JS code {code}, Rust said:\n{who}");

    let chat_id = js.call("direct", json!({ "userId": "rusty@dev" }))["chatId"].as_str().unwrap().to_string();

    // ---- Rust -> JS: a text message ----
    let text = "hello from rust 🦀 \"quoted\" \u{2028} <tag>";
    let out = rust.run(&["text", "jsuser@dev", text]);
    let (sent_chat, _msg_id) = out.trim().split_once('\t').unwrap();
    assert_eq!(sent_chat, chat_id, "a user id opens the existing direct chat");
    let seen = js.call("messages", json!({ "chatId": chat_id }));
    let texts: Vec<&str> = seen.as_array().unwrap().iter().filter_map(|m| m["content"]["text"].as_str()).collect();
    assert_eq!(texts, [text], "JS decrypts the Rust envelope: {seen}");

    // ---- Rust -> JS: files, including a >2 MiB multi-chunk one ----
    let src = tmp.join("rust-src");
    fs::create_dir_all(&src).unwrap();
    let files: Vec<(&str, Vec<u8>)> = vec![
        ("big.bin", pattern(2 * MIB + 12_345, 1)),
        ("exact.bin", pattern(MIB, 2)),
        ("empty.txt", Vec::new()),
        ("photo.png", pattern(5000, 3)),
    ];
    let mut paths = Vec::new();
    for (name, data) in &files {
        fs::write(src.join(name), data).unwrap();
        paths.push(src.join(name).to_string_lossy().into_owned());
    }
    let mut args = vec!["send", chat_id.as_str(), "--caption", "from rust"];
    args.extend(paths.iter().map(String::as_str));
    let out = rust.run(&args);
    assert_eq!(out.lines().count(), files.len(), "{out}");

    let js_got = tmp.join("js-got");
    let saved = js.call("download", json!({ "chatId": chat_id, "outDir": js_got }));
    let saved = saved.as_array().unwrap();
    assert_eq!(saved.len(), files.len(), "{saved:?}");
    for (name, data) in &files {
        let got = fs::read(js_got.join(name)).unwrap();
        assert!(got == *data, "{name}: JS decryptFile() output differs ({} vs {} bytes)", got.len(), data.len());
        let meta = saved.iter().find(|s| s["name"] == *name).unwrap();
        assert_eq!(meta["size"], json!(data.len()));
        assert_eq!(meta["caption"], "from rust");
        let kind = if *name == "photo.png" { "image" } else { "document" };
        assert_eq!(meta["kind"], kind, "{name}");
    }

    // ---- JS -> Rust: a text message ----
    js.call("sendText", json!({ "chatId": chat_id, "text": "hello from js ✓" }));
    let history = rust.run(&["history", &chat_id, "--json", "--limit", "100"]);
    let lines: Vec<Value> = history.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    for l in &lines {
        assert!(l.get("error").is_none(), "Rust could not open a message: {l}");
    }
    let from_js: Vec<&Value> = lines.iter().filter(|l| l["senderId"] == "jsuser@dev").collect();
    assert_eq!(from_js.len(), 1);
    assert_eq!(from_js[0]["content"], json!({ "type": "text", "text": "hello from js ✓" }));
    // Rust can read its own messages (it wraps the key for itself too).
    assert!(lines.iter().any(|l| l["content"]["text"] == text));
    assert_eq!(lines.iter().filter(|l| l["content"]["type"] == "media").count(), files.len());
    let plain = rust.run(&["history", "jsuser", "--limit", "2"]);
    assert!(plain.lines().last().unwrap().ends_with("jsuser@dev: hello from js ✓"), "{plain}");

    // ---- JS -> Rust: files sealed with encryptFile() ----
    let js_src = tmp.join("js-src");
    fs::create_dir_all(&js_src).unwrap();
    let js_big = pattern(3 * MIB + 7, 4);
    fs::write(js_src.join("js-big.bin"), &js_big).unwrap();
    fs::write(js_src.join("note.txt"), "a note from js\n").unwrap();
    for (name, mime) in [("js-big.bin", "application/octet-stream"), ("note.txt", "text/plain")] {
        let file = js_src.join(name);
        js.call("sendFile", json!({ "chatId": chat_id, "file": file, "name": name, "mime": mime, "kind": "document" }));
    }

    let got = tmp.join("rust-got");
    let out = rust.run(&["receive", &chat_id, got.to_str().unwrap()]);
    assert_eq!(out.trim(), "6 saved, 0 already present", "{out}");
    assert_eq!(fs::read(got.join("js-big.bin")).unwrap(), js_big);
    assert_eq!(fs::read_to_string(got.join("note.txt")).unwrap(), "a note from js\n");
    for (name, data) in &files {
        assert!(fs::read(got.join(name)).unwrap() == *data, "{name} round trip through Rust");
    }
    let names = set(&["big.bin", "exact.bin", "empty.txt", "photo.png", "js-big.bin", "note.txt"]);
    assert_eq!(listing(&got), names, "no partial files left behind");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(got.join("note.txt")).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // Receiving again skips what is already there.
    let out = rust.run(&["receive", &chat_id, got.to_str().unwrap()]);
    assert_eq!(out.trim(), "0 saved, 6 already present", "{out}");
    assert_eq!(listing(&got), names);

    // A different local file with the same name is never overwritten.
    fs::write(got.join("note.txt"), "my own note!!!\n").unwrap();
    let out = rust.run(&["receive", &chat_id, got.to_str().unwrap()]);
    assert_eq!(out.trim(), "1 saved, 5 already present", "{out}");
    assert_eq!(fs::read_to_string(got.join("note.txt")).unwrap(), "my own note!!!\n");
    assert_eq!(fs::read_to_string(got.join("note (2).txt")).unwrap(), "a note from js\n");

    // A device that was registered later can't read older messages (like WhatsApp).
    let late = Cli { state: tmp.join("rusty-second.state.json"), ..Cli::new(&server, &tmp, "rusty") };
    let late_got = tmp.join("late-got");
    let out = late.run(&["receive", &chat_id, late_got.to_str().unwrap()]);
    assert!(out.starts_with("0 saved, 0 already present"), "{out}");
    assert!(out.contains("not encrypted for this device"), "{out}");
}

#[test]
fn watch_folder_sends_files_once_they_stop_growing() {
    let tmp = TempDir::new("watch");
    let server = start_server(&tmp);
    let mut js = Peer::start(&server);
    js.call("register", json!({ "user": "jswatch" }));
    let rust = Cli::new(&server, &tmp, "rustwatch");
    rust.run(&["whoami"]);
    let chat_id = js.call("direct", json!({ "userId": "rustwatch@dev" }))["chatId"].as_str().unwrap().to_string();

    let drop_dir = tmp.join("drop");
    fs::create_dir_all(&drop_dir).unwrap();
    // Not for sending: hidden files and partial downloads.
    fs::write(drop_dir.join(".hidden"), "x").unwrap();
    fs::write(drop_dir.join("movie.mkv.part"), "x").unwrap();
    // Present before the watcher starts.
    fs::write(drop_dir.join("early.txt"), "already here").unwrap();

    let log = fs::File::create(tmp.join("watch.log")).unwrap();
    let mut watcher = rust
        .command(&["watch", "jswatch@dev", drop_dir.to_str().unwrap(), "--interval", "0.1", "--settle", "1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .unwrap();
    let sent = drop_dir.join(".sent");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_for("early.txt to be sent", Duration::from_secs(30), || sent.join("early.txt").exists());

        // A file that grows in steps must only be sent once complete.
        let data = pattern(2 * MIB + 999, 9);
        let path = drop_dir.join("growing.bin");
        let mut f = fs::File::create(&path).unwrap();
        for part in data.chunks(MIB / 2) {
            f.write_all(part).unwrap();
            f.flush().unwrap();
            std::thread::sleep(Duration::from_millis(300));
        }
        drop(f);
        wait_for("growing.bin to be sent", Duration::from_secs(30), || sent.join("growing.bin").exists());

        // Same name again: sent too, and kept apart in .sent/.
        fs::write(drop_dir.join("early.txt"), "second version").unwrap();
        wait_for("early (2).txt in .sent", Duration::from_secs(30), || sent.join("early (2).txt").exists());
        data
    }));
    let _ = watcher.kill();
    let _ = watcher.wait();
    let data = match result {
        Ok(d) => d,
        Err(e) => {
            eprintln!("--- watch log ---\n{}", fs::read_to_string(tmp.join("watch.log")).unwrap_or_default());
            std::panic::resume_unwind(e);
        }
    };

    assert_eq!(listing(&drop_dir), set(&[".hidden", ".sent", "movie.mkv.part"]));
    assert_eq!(listing(&sent), set(&["early.txt", "early (2).txt", "growing.bin"]));

    let js_got = tmp.join("js-got");
    let saved = js.call("download", json!({ "chatId": chat_id, "outDir": js_got }));
    let names: Vec<&str> = saved.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["early.txt", "growing.bin", "early.txt"], "each file sent exactly once, in order");
    // The JS peer saved both early.txt versions to one name; the last one wins.
    assert_eq!(fs::read_to_string(js_got.join("early.txt")).unwrap(), "second version");
    assert!(fs::read(js_got.join("growing.bin")).unwrap() == data, "growing.bin was sent before it was complete");

    // --once: send what is there, then exit.
    let once_dir = tmp.join("once");
    fs::create_dir_all(&once_dir).unwrap();
    fs::write(once_dir.join("a.txt"), "a").unwrap();
    fs::write(once_dir.join("b.txt"), "b").unwrap();
    rust.run(&["watch", &chat_id, once_dir.to_str().unwrap(), "--once", "--settle", "0"]);
    assert_eq!(listing(&once_dir.join(".sent")), set(&["a.txt", "b.txt"]));
    assert_eq!(listing(&once_dir), set(&[".sent"]));
}

#[test]
fn cli_errors_are_clear() {
    let tmp = TempDir::new("errors");
    let server = start_server(&tmp);
    let rust = Cli::new(&server, &tmp, "erra");
    let out = rust.output(&["send", "nobody@dev", "/nonexistent"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("No such user"), "{}", String::from_utf8_lossy(&out.stderr));

    let other = Cli::new(&server, &tmp, "errb");
    other.run(&["whoami"]);
    let chat = rust.run(&["text", "errb@dev", "hi"]);
    let chat_id = chat.split('\t').next().unwrap();
    let out = rust.output(&["send", chat_id, "/nonexistent/file.bin"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("/nonexistent/file.bin"));

    // Using the device state with another dev user is refused before any request.
    let mismatch = Cli { user: "someoneelse".into(), ..Cli::new(&server, &tmp, "erra") };
    let out = mismatch.output(&["whoami"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("dev user erra"), "{}", String::from_utf8_lossy(&out.stderr));

    let usage = rust.output(&["send", chat_id]);
    assert_eq!(usage.status.code(), Some(2));
}
