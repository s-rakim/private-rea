//! Shared helpers for the integration tests: a real Tailchat server in dev
//! mode, a JavaScript peer built on public/crypto.js, and the CLI.
#![allow(dead_code)]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The `tailchat/` directory (this crate lives in tailchat/clients/rust).
pub fn tailchat_dir() -> PathBuf {
    manifest_dir().join("../..").canonicalize().expect("tailchat/ directory")
}

// ---------- temporary directories ----------

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        let name = format!("tailchat-drop-{label}-{}", tailchat_drop::crypto::b64u(&tailchat_drop::crypto::random_bytes::<6>()));
        let path = std::env::temp_dir().join(name);
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    pub fn join(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("(keeping {} for inspection)", self.0.display());
        } else {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

// ---------- the server ----------

static NPM: Mutex<()> = Mutex::new(());

fn ensure_node_modules(tailchat: &Path) {
    let _guard = NPM.lock().unwrap_or_else(|e| e.into_inner());
    if tailchat.join("node_modules").is_dir() {
        return;
    }
    let status = Command::new("npm")
        .args(["install", "--no-audit", "--no-fund"])
        .current_dir(tailchat)
        .status()
        .expect("running npm install");
    assert!(status.success(), "npm install failed in {}", tailchat.display());
}

/// How to start the server, decided in one place:
/// 1. `TAILCHAT_SERVER_CMD` (a shell command, run in tailchat/), if set;
/// 2. the Python port, `python3 -m tailchat_server`, if tailchat/tailchat_server/__main__.py exists;
/// 3. otherwise the Node server (`npm install` first if node_modules is missing).
pub fn server_command(tailchat: &Path) -> (Command, String) {
    let custom = std::env::var("TAILCHAT_SERVER_CMD").ok().filter(|c| !c.trim().is_empty());
    let (mut cmd, label) = if let Some(custom) = custom {
        let mut c = Command::new("sh");
        c.arg("-c").arg(format!("exec {custom}"));
        (c, custom)
    } else if tailchat.join("tailchat_server").join("__main__.py").is_file() {
        let mut c = Command::new("python3");
        c.args(["-m", "tailchat_server"]);
        (c, "python3 -m tailchat_server".to_string())
    } else {
        ensure_node_modules(tailchat);
        let mut c = Command::new("node");
        c.args(["--no-warnings=ExperimentalWarning", "server/index.js"]);
        (c, "node server/index.js".to_string())
    };
    cmd.current_dir(tailchat);
    (cmd, label)
}

pub struct Server {
    child: Child,
    pub base: String,
    log: PathBuf,
    pub label: String,
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// GET /api/me without credentials: a ready server answers 401.
fn answers_401(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /api/me HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    s.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.") && &head[9..12] == b"401"
}

pub fn start_server(tmp: &TempDir) -> Server {
    let tailchat = tailchat_dir();
    let port = free_port();
    let data = tmp.join("server-data");
    fs::create_dir_all(&data).unwrap();
    let log = tmp.join("server.log");
    let out = fs::File::create(&log).unwrap();
    let (mut cmd, label) = server_command(&tailchat);
    let child = cmd
        .env("TAILCHAT_AUTH", "dev")
        .env("TAILCHAT_HOST", "127.0.0.1")
        .env("TAILCHAT_PORT", port.to_string())
        .env("TAILCHAT_DATA", &data)
        .stdin(Stdio::null())
        .stdout(out.try_clone().unwrap())
        .stderr(out)
        .spawn()
        .unwrap_or_else(|e| panic!("starting the server ({label}): {e}"));
    let mut server = Server { child, base: format!("http://127.0.0.1:{port}"), log, label };
    let start = Instant::now();
    loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            panic!("the server ({}) exited with {status}:\n{}", server.label, fs::read_to_string(&server.log).unwrap_or_default());
        }
        if answers_401(port) {
            break;
        }
        if start.elapsed() > Duration::from_secs(60) {
            panic!("the server ({}) did not come up:\n{}", server.label, fs::read_to_string(&server.log).unwrap_or_default());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("server: {} at {}", server.label, server.base);
    server
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if std::thread::panicking() {
            eprintln!("--- server log ({}) ---\n{}", self.label, fs::read_to_string(&self.log).unwrap_or_default());
        }
    }
}

// ---------- the JavaScript peer ----------

pub struct Peer {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next: u64,
}

impl Peer {
    pub fn start(server: &Server) -> Peer {
        let script = manifest_dir().join("tests/js/peer.mjs");
        let mut child = Command::new("node")
            .arg(&script)
            .arg(&server.base)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("starting node (needed for the JS reference peer)");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Peer { child, stdin, lines: rx, next: 1 }
    }

    /// Run a command in the peer; panics if it fails.
    pub fn call(&mut self, cmd: &str, mut args: Value) -> Value {
        let id = self.next;
        self.next += 1;
        args["id"] = json!(id);
        args["cmd"] = json!(cmd);
        writeln!(self.stdin, "{args}").unwrap();
        self.stdin.flush().unwrap();
        let line = self
            .lines
            .recv_timeout(Duration::from_secs(120))
            .unwrap_or_else(|_| panic!("the JS peer did not answer {cmd}"));
        let reply: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("JS peer said: {line}"));
        assert_eq!(reply["id"], json!(id));
        assert!(reply["ok"] == json!(true), "JS peer {cmd} failed: {}", reply["error"].as_str().unwrap_or(&line));
        reply["result"].clone()
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, r#"{{"cmd":"quit"}}"#);
        std::thread::sleep(Duration::from_millis(50));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------- the CLI ----------

pub struct Cli {
    pub base: String,
    pub state: PathBuf,
    pub user: String,
    home: PathBuf,
}

impl Cli {
    pub fn new(server: &Server, tmp: &TempDir, user: &str) -> Cli {
        let home = tmp.join(&format!("home-{user}"));
        fs::create_dir_all(&home).unwrap();
        Cli { base: server.base.clone(), state: tmp.join(&format!("{user}.state.json")), user: user.to_string(), home }
    }

    pub fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_tailchat-drop"));
        cmd.arg("--server")
            .arg(&self.base)
            .arg("--dev-user")
            .arg(&self.user)
            .arg("--state")
            .arg(&self.state)
            .args(args)
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env_remove("TAILCHAT_SERVER")
            .env_remove("TAILCHAT_DEV_USER")
            .env_remove("TAILCHAT_DROP_STATE");
        cmd
    }

    pub fn output(&self, args: &[&str]) -> Output {
        self.command(args).stdin(Stdio::null()).output().expect("running tailchat-drop")
    }

    /// Run and return stdout; panics (showing stderr) on failure.
    pub fn run(&self, args: &[&str]) -> String {
        let out = self.output(args);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "tailchat-drop {args:?} failed ({}):\n{stderr}", out.status);
        String::from_utf8(out.stdout).unwrap()
    }
}

/// Deterministic pseudo-random bytes (xorshift), different per seed.
pub fn pattern(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 8) as u8
        })
        .collect()
}

pub fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(start.elapsed() < timeout, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}
