//! Command line for tailchat-drop.

use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use tailchat_drop::app::{Options, SendOptions, Session, WatchOptions};
use tailchat_drop::error::{Error, Result};

const USAGE: &str = "\
tailchat-drop - end-to-end encrypted file sharing over Tailchat

USAGE:
    tailchat-drop [OPTIONS] <COMMAND> [ARGS]

COMMANDS:
    send CHAT_OR_USER PATH...    encrypt and send files (streamed, 1 MiB chunks)
        [--caption TEXT] [--document]
    watch CHAT_OR_USER DIR       drop folder: send every new file once it stops
        [--interval SECS] [--settle SECS] [--once] [--document]
                                 growing, then move it to DIR/.sent/
    receive CHAT DIR             download and decrypt every file shared in CHAT,
                                 skipping ones already in DIR
    history CHAT [--limit N] [--json]
                                 show the latest messages
    text CHAT_OR_USER MESSAGE... send a text message (MESSAGE '-' reads stdin)
    chats                        list your chats
    whoami                       show this user, device and security code
    register [--name NAME] [--force]
                                 register this device (done automatically on
                                 first use; --force replaces it)

CHAT_OR_USER is a chat id, a group name, or a user id such as alice@example.com
(which opens your direct chat with them).

OPTIONS:
    --server URL       the Tailchat server, e.g. https://chat.tailnet-name.ts.net
                       (env TAILCHAT_SERVER; remembered in the state file)
    --state PATH       device state file (env TAILCHAT_DROP_STATE; default
                       ~/.config/tailchat-drop/<server>.json)
    --dev-user NAME    send X-Dev-User: NAME (only for a server in dev mode,
                       for local testing; env TAILCHAT_DEV_USER)
    -q, --quiet        no progress output
    -h, --help         show this help
    -V, --version      show the version
";

const VALUE_FLAGS: &[&str] = &["--server", "--state", "--dev-user", "--caption", "--name", "--limit", "--interval", "--settle"];
const BOOL_FLAGS: &[&str] = &["--quiet", "--document", "--once", "--force", "--json", "--help", "--version"];

#[derive(Debug, Default)]
struct Args {
    positionals: Vec<String>,
    values: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Args {
    fn parse(raw: impl IntoIterator<Item = String>) -> Result<Self> {
        let mut args = Args::default();
        let mut it = raw.into_iter();
        let mut only_positionals = false;
        while let Some(arg) = it.next() {
            if only_positionals || arg == "-" || !arg.starts_with('-') {
                args.positionals.push(arg);
                continue;
            }
            if arg == "--" {
                only_positionals = true;
                continue;
            }
            let (name, inline) = match arg.split_once('=') {
                Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
                _ => (arg.clone(), None),
            };
            let name = match name.as_str() {
                "-q" => "--quiet".to_string(),
                "-h" => "--help".to_string(),
                "-V" => "--version".to_string(),
                _ => name,
            };
            if VALUE_FLAGS.contains(&name.as_str()) {
                let value = match inline {
                    Some(v) => v,
                    None => it.next().ok_or_else(|| Error::msg(format!("{name} needs a value")))?,
                };
                args.values.push((name, value));
            } else if BOOL_FLAGS.contains(&name.as_str()) && inline.is_none() {
                args.flags.push(name);
            } else {
                return Err(Error::msg(format!("unknown option {arg}")));
            }
        }
        Ok(args)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.values.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    /// Refuse options that mean nothing for this command.
    fn only(&self, command: &str, allowed: &[&str]) -> Result<()> {
        const GLOBAL: &[&str] = &["--server", "--state", "--dev-user", "--quiet"];
        for name in self.values.iter().map(|(n, _)| n).chain(self.flags.iter()) {
            if !GLOBAL.contains(&name.as_str()) && !allowed.contains(&name.as_str()) {
                return Err(Error::msg(format!("{name} does not apply to `{command}`")));
            }
        }
        Ok(())
    }

    fn seconds(&self, name: &str, default: f64) -> Result<Duration> {
        match self.value(name) {
            None => Ok(Duration::from_secs_f64(default)),
            Some(v) => v
                .parse::<f64>()
                .ok()
                .filter(|s| s.is_finite() && *s >= 0.0 && *s < 86_400.0)
                .map(Duration::from_secs_f64)
                .ok_or_else(|| Error::msg(format!("{name} must be a number of seconds, got {v:?}"))),
        }
    }
}

fn usage_error(text: &str) -> ExitCode {
    eprintln!("error: {text}\n\nRun `tailchat-drop --help` for usage.");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args = match Args::parse(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => return usage_error(&e.to_string()),
    };
    if args.flag("--help") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.flag("--version") {
        println!("tailchat-drop {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let Some(command) = args.positionals.first().cloned() else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };
    let rest = &args.positionals[1..];
    match run(&command, rest, &args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            if e.status() == Some(401) {
                eprintln!("hint: this device's token was refused; run `tailchat-drop register --force` to link it again");
            }
            ExitCode::FAILURE
        }
    }
}

fn run(command: &str, rest: &[String], args: &Args) -> Result<ExitCode> {
    let opts = Options {
        server: args.value("--server").map(str::to_string),
        dev_user: args.value("--dev-user").map(str::to_string),
        state: args.value("--state").map(PathBuf::from),
        quiet: args.flag("--quiet"),
    };
    let stdout = std::io::stdout();
    let send_options = || SendOptions { caption: args.value("--caption").map(str::to_string), as_document: args.flag("--document") };
    match command {
        "register" => {
            args.only(command, &["--name", "--force"])?;
            if !rest.is_empty() {
                return Err(Error::msg("register takes no arguments"));
            }
            let mut session = Session::reregister(&opts, args.value("--name"), args.flag("--force"))?;
            session.whoami(&mut stdout.lock())?;
        }
        "whoami" => {
            args.only(command, &[])?;
            Session::open(&opts)?.whoami(&mut stdout.lock())?;
        }
        "chats" => {
            args.only(command, &[])?;
            Session::open(&opts)?.list_chats(&mut stdout.lock())?;
        }
        "send" => {
            args.only(command, &["--caption", "--document"])?;
            let [target, paths @ ..] = rest else { return Ok(usage_error("usage: send CHAT_OR_USER PATH...")) };
            if paths.is_empty() {
                return Ok(usage_error("usage: send CHAT_OR_USER PATH..."));
            }
            let mut session = Session::open(&opts)?;
            let chat = session.resolve_chat(target)?;
            let options = send_options();
            let mut failed = 0;
            for path in paths {
                match session.send_file(&chat, PathBuf::from(path).as_path(), &options) {
                    Ok(m) => writeln!(stdout.lock(), "{}\t{}\t{}", chat.id, m.id, path)?,
                    Err(e) => {
                        eprintln!("error: {e}");
                        failed += 1;
                    }
                }
            }
            if failed > 0 {
                return Ok(ExitCode::FAILURE);
            }
        }
        "text" => {
            args.only(command, &[])?;
            let [target, words @ ..] = rest else { return Ok(usage_error("usage: text CHAT_OR_USER MESSAGE...")) };
            let text = if words.len() == 1 && words[0] == "-" {
                if std::io::stdin().is_terminal() {
                    eprintln!("Type the message, then Ctrl-D:");
                }
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s)?;
                s.trim_end_matches('\n').to_string()
            } else {
                words.join(" ")
            };
            if text.trim().is_empty() {
                return Ok(usage_error("the message is empty"));
            }
            let mut session = Session::open(&opts)?;
            let chat = session.resolve_chat(target)?;
            let m = session.send_text(&chat, &text)?;
            writeln!(stdout.lock(), "{}\t{}", chat.id, m.id)?;
        }
        "watch" => {
            args.only(command, &["--interval", "--settle", "--once", "--document", "--caption"])?;
            let [target, dir] = rest else { return Ok(usage_error("usage: watch CHAT_OR_USER DIR")) };
            let watch = WatchOptions {
                interval: args.seconds("--interval", 1.0)?.max(Duration::from_millis(50)),
                settle: args.seconds("--settle", 2.0)?,
                once: args.flag("--once"),
                send: send_options(),
            };
            let mut session = Session::open(&opts)?;
            let chat = session.resolve_chat(target)?;
            session.watch(&chat, PathBuf::from(dir).as_path(), &watch)?;
        }
        "receive" => {
            args.only(command, &[])?;
            let [target, dir] = rest else { return Ok(usage_error("usage: receive CHAT DIR")) };
            let mut session = Session::open(&opts)?;
            let chat = session.resolve_chat(target)?;
            let s = session.receive(&chat, PathBuf::from(dir).as_path())?;
            let mut line = format!("{} saved, {} already present", s.saved, s.present);
            if s.failed > 0 {
                line.push_str(&format!(", {} failed", s.failed));
            }
            if s.view_once > 0 {
                line.push_str(&format!(", {} view-once skipped", s.view_once));
            }
            if s.unreadable > 0 {
                line.push_str(&format!(", {} messages not encrypted for this device", s.unreadable));
            }
            writeln!(stdout.lock(), "{line}")?;
            if s.failed > 0 {
                return Ok(ExitCode::FAILURE);
            }
        }
        "history" => {
            args.only(command, &["--limit", "--json"])?;
            let [target] = rest else { return Ok(usage_error("usage: history CHAT [--limit N] [--json]")) };
            let limit = match args.value("--limit") {
                None => 30,
                Some(v) => match v.parse::<usize>() {
                    Ok(n) if n > 0 => n,
                    _ => return Ok(usage_error("--limit must be a positive number")),
                },
            };
            let mut session = Session::open(&opts)?;
            let chat = session.resolve_chat(target)?;
            session.history(&chat, limit, args.flag("--json"), &mut stdout.lock())?;
        }
        other => return Ok(usage_error(&format!("unknown command {other:?}"))),
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::Args;

    fn parse(list: &[&str]) -> Args {
        Args::parse(list.iter().map(|s| s.to_string())).unwrap()
    }

    #[test]
    fn options_anywhere() {
        let a = parse(&["send", "--server=http://x", "bob@x", "a.txt", "-q", "--caption", "hi", "--", "--weird-name"]);
        assert_eq!(a.positionals, ["send", "bob@x", "a.txt", "--weird-name"]);
        assert_eq!(a.value("--server"), Some("http://x"));
        assert_eq!(a.value("--caption"), Some("hi"));
        assert!(a.flag("--quiet"));
        assert!(a.only("send", &["--caption"]).is_ok());
        assert!(a.only("history", &["--limit"]).is_err());
    }

    #[test]
    fn bad_options() {
        assert!(Args::parse(["--bogus".to_string()]).is_err());
        assert!(Args::parse(["--server".to_string()]).is_err());
        assert!(Args::parse(["--json=1".to_string()]).is_err());
        assert!(parse(&["--settle", "x"]).seconds("--settle", 1.0).is_err());
        assert_eq!(parse(&["--settle", "0.5"]).seconds("--settle", 1.0).unwrap().as_millis(), 500);
    }
}
