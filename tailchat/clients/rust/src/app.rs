//! The commands: register, whoami, chats, send, text, watch, receive, history.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::{Chat, Client, Message};
use crate::crypto::{b64u, chat_aad, new_message_id, random_bytes, security_code, DeviceKey, Envelope, KeyRing, OpenError, PublicJwk};
use crate::error::{Context, Error, Result};
use crate::file::{decrypt_stream, encrypted_size, EncryptReader, FileKey};
use crate::media::{candidate_names, extension_for, guess_mime, kind_for, safe_file_name, unique_path};
use crate::progress::{human_bytes, Progress};
use crate::state::{self, State};

/// Where to find the server and the device state.
#[derive(Default, Clone, Debug)]
pub struct Options {
    pub server: Option<String>,
    pub dev_user: Option<String>,
    pub state: Option<PathBuf>,
    pub quiet: bool,
}

#[derive(Default, Clone, Debug)]
pub struct SendOptions {
    pub caption: Option<String>,
    /// Always send as `document` (no image/video/audio preview).
    pub as_document: bool,
}

#[derive(Clone, Debug)]
pub struct WatchOptions {
    pub interval: Duration,
    pub settle: Duration,
    pub once: bool,
    pub send: SendOptions,
}

/// An attachment as described in the message content (PROTOCOL.md §5).
#[derive(Debug, Clone, Deserialize)]
pub struct FileRef {
    pub id: String,
    pub key: String,
    pub prefix: String,
    pub size: u64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReceiveSummary {
    pub saved: usize,
    pub present: usize,
    pub failed: usize,
    pub unreadable: usize,
    pub view_once: usize,
}

fn normalize_server(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Work out the server, dev user and state file from flags, environment
/// and (if nothing else says) the one state file in the config directory.
pub fn resolve_profile(opts: &Options) -> Result<(String, Option<String>, PathBuf, Option<State>)> {
    let server = opts.server.clone().or_else(|| env_opt("TAILCHAT_SERVER")).map(|s| normalize_server(&s));
    let dev_user = opts.dev_user.clone().or_else(|| env_opt("TAILCHAT_DEV_USER"));
    let explicit_state = opts.state.clone().or_else(|| env_opt("TAILCHAT_DROP_STATE").map(PathBuf::from));

    let path = match (&explicit_state, &server) {
        (Some(p), _) => p.clone(),
        (None, Some(server)) => {
            let dir = state::config_dir().ok_or_else(|| Error::msg("cannot find a config directory; pass --state PATH"))?;
            dir.join(state::default_file_name(server, dev_user.as_deref()))
        }
        (None, None) => {
            let dir = state::config_dir();
            let found: Vec<PathBuf> = dir
                .as_ref()
                .and_then(|d| fs::read_dir(d).ok())
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok().map(|e| e.path()))
                        .filter(|p| p.extension().is_some_and(|x| x == "json") && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
                        .collect()
                })
                .unwrap_or_default();
            match found.as_slice() {
                [one] => one.clone(),
                [] => return Err(Error::msg("no server configured: pass --server https://<machine>.<tailnet>.ts.net (or set TAILCHAT_SERVER)")),
                _ => return Err(Error::msg("several servers are configured: pass --server URL (or --state PATH) to pick one")),
            }
        }
    };

    let existing = state::load(&path)?;
    let (server, dev_user) = match &existing {
        Some(st) => {
            if let Some(s) = &server {
                if normalize_server(&st.server) != *s {
                    return Err(Error::msg(format!(
                        "{} belongs to {}, not {s}; pass a different --state",
                        path.display(),
                        st.server
                    )));
                }
            }
            if let (Some(want), Some(have)) = (&dev_user, &st.dev_user) {
                if want != have {
                    return Err(Error::msg(format!("{} is the device of dev user {have}, not {want}", path.display())));
                }
            }
            (normalize_server(&st.server), dev_user.or_else(|| st.dev_user.clone()))
        }
        None => match server {
            Some(s) => (s, dev_user),
            None => return Err(Error::msg(format!("{} does not exist yet: pass --server URL to register", path.display()))),
        },
    };
    Ok((server, dev_user, path, existing))
}

pub fn hostname() -> String {
    let from_file = |p: &str| fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    from_file("/proc/sys/kernel/hostname")
        .or_else(|| from_file("/etc/hostname"))
        .or_else(|| env_opt("HOSTNAME"))
        .or_else(|| env_opt("COMPUTERNAME"))
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "this computer".into())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `2026-10-13 09:41:07Z` from milliseconds since the epoch (UTC).
pub fn format_time(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub struct Session {
    pub client: Client,
    pub state: State,
    pub state_path: PathBuf,
    pub ring: KeyRing,
    /// device id -> owning user id, for checking who sent what.
    device_users: HashMap<String, String>,
    max_upload: Option<Option<u64>>,
    pub quiet: bool,
}

impl Session {
    /// Load the device from the state file, registering a new one if needed.
    pub fn open(opts: &Options) -> Result<Self> {
        let (server, dev_user, path, existing) = resolve_profile(opts)?;
        match existing {
            Some(st) => Self::from_state(st, path, opts.quiet),
            None => Self::register(&server, dev_user, &path, None, opts.quiet),
        }
    }

    fn from_state(st: State, path: PathBuf, quiet: bool) -> Result<Self> {
        let key = DeviceKey::from_jwk(&st.private_key).ctx(path.display())?;
        let mut client = Client::new(&st.server, st.dev_user.clone())?;
        client.set_token(st.token.clone());
        let ring = KeyRing::new(st.device_id.clone(), key);
        let mut device_users = HashMap::new();
        device_users.insert(st.device_id.clone(), st.user_id.clone());
        Ok(Session { client, state: st, state_path: path, ring, device_users, max_upload: None, quiet })
    }

    /// Register a new device: a fresh P-256 key, then `POST /api/devices`.
    pub fn register(server: &str, dev_user: Option<String>, path: &Path, name: Option<&str>, quiet: bool) -> Result<Self> {
        let client = Client::new(server, dev_user.clone())?;
        let key = DeviceKey::generate();
        let name = name.map(str::to_string).unwrap_or_else(|| format!("tailchat-drop on {}", hostname()));
        let reg = client.register(&name, &key.public_jwk()).ctx(format!("registering with {server}"))?;
        if reg.device.public_key != key.public_jwk() {
            return Err(Error::msg("the server registered a different public key than ours"));
        }
        let st = State {
            server: server.to_string(),
            dev_user,
            user_id: reg.device.user_id.clone(),
            device_id: reg.device.id.clone(),
            device_name: name,
            token: reg.token,
            private_key: key.to_jwk(),
            created_at: now_ms(),
        };
        state::save(path, &st)?;
        if !quiet {
            eprintln!("Registered device {} for {} (state in {})", st.device_id, st.user_id, path.display());
        }
        Self::from_state(st, path.to_path_buf(), quiet)
    }

    /// `register [--name] [--force]`: replace this machine's device.
    pub fn reregister(opts: &Options, name: Option<&str>, force: bool) -> Result<Self> {
        let (server, dev_user, path, existing) = resolve_profile(opts)?;
        if let Some(st) = existing {
            if !force {
                if !opts.quiet {
                    eprintln!("Already registered as device {} of {} (use --force to replace it)", st.device_id, st.user_id);
                }
                return Self::from_state(st, path, opts.quiet);
            }
            // Best effort: log the old device out so nobody encrypts for it any more.
            if let Ok(old) = Self::from_state(st, path.clone(), true) {
                if let Err(e) = old.logout_self() {
                    if !opts.quiet {
                        eprintln!("note: could not log out the old device {}: {e}", old.state.device_id);
                    }
                }
            }
        }
        Self::register(&server, dev_user, &path, name, opts.quiet)
    }

    fn logout_self(&self) -> Result<()> {
        let path = format!("/api/devices/{}", crate::api::enc(&self.state.device_id));
        self.client.delete(&path)
    }

    // ---------- chats ----------

    /// A chat id, a group name, or a user id (opens the direct chat).
    pub fn resolve_chat(&self, target: &str) -> Result<Chat> {
        let target = target.trim();
        if target.contains('@') {
            return self.client.direct_chat(target).ctx(format!("opening a chat with {target}"));
        }
        let chats = self.client.chats()?;
        if let Some(c) = chats.iter().find(|c| c.id == target) {
            return Ok(c.clone());
        }
        let lower = target.to_lowercase();
        let matches: Vec<&Chat> = chats
            .iter()
            .filter(|c| {
                c.name.as_deref().is_some_and(|n| n.to_lowercase() == lower)
                    || (c.kind == "direct"
                        && c.members.iter().any(|m| m.user_id != self.state.user_id && m.user_id.split('@').next() == Some(target)))
            })
            .collect();
        match matches.as_slice() {
            [one] => Ok((*one).clone()),
            [] => self.client.chat(target).map_err(|_| {
                Error::msg(format!("no chat called {target:?}: use a chat id (see `tailchat-drop chats`), a group name or a user id like alice@example.com"))
            }),
            _ => Err(Error::msg(format!("{target:?} matches several chats; use the chat id (see `tailchat-drop chats`)"))),
        }
    }

    pub fn chat_label(&self, chat: &Chat) -> String {
        if chat.kind == "direct" {
            let other = chat.members.iter().find(|m| m.user_id != self.state.user_id).map(|m| m.user_id.as_str());
            other.unwrap_or(&self.state.user_id).to_string()
        } else {
            chat.name.clone().unwrap_or_else(|| chat.id.clone())
        }
    }

    // ---------- sending ----------

    /// Encrypt `content` for every device in the chat and post it.
    pub fn post_content(&mut self, chat_id: &str, content: &Value, files: &[String]) -> Result<Message> {
        let devices = self.client.chat_devices(chat_id)?;
        let mut recipients: Vec<(String, PublicJwk)> = Vec::with_capacity(devices.len());
        for d in devices {
            self.device_users.insert(d.id.clone(), d.user_id.clone());
            recipients.push((d.id, d.public_key));
        }
        let id = new_message_id();
        let payload = self.ring.seal(content, &chat_aad(chat_id, &id), &recipients)?;
        self.client.send_message(chat_id, &id, &payload, files)
    }

    pub fn send_text(&mut self, chat: &Chat, text: &str) -> Result<Message> {
        self.post_content(&chat.id, &json!({ "type": "text", "text": text }), &[])
    }

    fn max_upload(&mut self) -> Option<u64> {
        if self.max_upload.is_none() {
            self.max_upload = Some(self.client.me().ok().and_then(|me| me.limits).and_then(|l| l.max_upload_bytes));
        }
        self.max_upload.flatten()
    }

    /// Encrypt and upload one file as a stream, then send the media message.
    pub fn send_file(&mut self, chat: &Chat, path: &Path, opts: &SendOptions) -> Result<Message> {
        let file = fs::File::open(path).ctx(path.display())?;
        let meta = file.metadata().ctx(path.display())?;
        if !meta.is_file() {
            return Err(Error::msg(format!("{} is not a regular file", path.display())));
        }
        let size = meta.len();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        if let Some(max) = self.max_upload() {
            if encrypted_size(size) > max {
                return Err(Error::msg(format!("{name} is {}; the server accepts at most {}", human_bytes(size), human_bytes(max))));
            }
        }
        let mime = guess_mime(&name);
        let kind = if opts.as_document { "document" } else { kind_for(mime) };
        let key = FileKey::random();

        let mut progress = Progress::new(name.clone(), size, self.quiet);
        let mut reader = EncryptReader::new(file, size, &key).on_progress(|n| progress.update(n));
        let len = reader.encrypted_len();
        let uploaded = self.client.upload(&mut reader, len).and_then(|id| Ok((id, reader.sha256()?)));
        drop(reader);
        let (file_id, sha) = match uploaded {
            Ok(done) => {
                progress.finish("Uploaded");
                done
            }
            Err(e) => {
                progress.abandon();
                return Err(e.context(format!("uploading {name}")));
            }
        };
        let mut content = json!({
            "type": "media",
            "kind": kind,
            "file": {
                "id": file_id,
                "key": b64u(key.key.as_ref()),
                "prefix": b64u(&key.prefix),
                "size": size,
                "name": name,
                "mime": mime,
                "sha256": sha,
            },
        });
        if let Some(c) = opts.caption.as_deref().filter(|c| !c.trim().is_empty()) {
            content["caption"] = Value::from(c);
        }
        self.post_content(&chat.id, &content, std::slice::from_ref(&file_id)).ctx(format!("sending {name}"))
    }

    // ---------- reading ----------

    /// Fetch the public keys of all senders we don't know yet, in one go.
    fn prefetch_senders(&mut self, messages: &[Message]) -> Result<()> {
        let mut wanted: Vec<String> = Vec::new();
        for m in messages {
            if m.kind != "msg" {
                continue;
            }
            if let Some(env) = m.payload.as_deref().and_then(|p| Envelope::parse(p).ok()) {
                if !self.ring.has_public_key(&env.from) && !wanted.contains(&env.from) {
                    wanted.push(env.from);
                }
            }
        }
        for batch in wanted.chunks(100) {
            let ids: Vec<&str> = batch.iter().map(String::as_str).collect();
            for d in self.client.keys(&ids)? {
                self.device_users.insert(d.id.clone(), d.user_id.clone());
                if let Err(e) = self.ring.add_public_key(&d.id, &d.public_key) {
                    eprintln!("warning: ignoring device {}: {e}", d.id);
                }
            }
        }
        Ok(())
    }

    /// Decrypt one message's content.
    pub fn open_message(&mut self, m: &Message) -> Result<Value, OpenError> {
        let payload = m.payload.as_deref().ok_or_else(|| OpenError::Failed(Error::msg("message has no payload")))?;
        let env = Envelope::parse(payload).map_err(OpenError::Failed)?;
        if !self.ring.has_public_key(&env.from) {
            self.prefetch_senders(std::slice::from_ref(m)).map_err(OpenError::Failed)?;
        }
        match self.device_users.get(&env.from) {
            Some(owner) if *owner == m.sender_id => {}
            Some(owner) => {
                return Err(OpenError::Failed(Error::msg(format!(
                    "envelope is from a device of {owner}, but the message claims to be from {}",
                    m.sender_id
                ))))
            }
            None => return Err(OpenError::UnknownSender(env.from)),
        }
        self.ring.open(&env, &chat_aad(&m.chat_id, &m.id))
    }

    /// The last `limit` messages of a chat, oldest first.
    pub fn recent_messages(&self, chat_id: &str, limit: usize) -> Result<Vec<Message>> {
        let mut all: Vec<Message> = Vec::new();
        let mut before = None;
        while all.len() < limit {
            let want = (limit - all.len()).min(200) as u32;
            let (mut page, more) = self.client.messages(chat_id, before, want)?;
            let lowest = page.first().map(|m| m.seq);
            page.append(&mut all);
            all = page;
            match lowest {
                Some(seq) if more => before = Some(seq),
                _ => break,
            }
        }
        Ok(all)
    }

    pub fn history(&mut self, chat: &Chat, limit: usize, as_json: bool, out: &mut dyn Write) -> Result<()> {
        let messages = self.recent_messages(&chat.id, limit)?;
        self.prefetch_senders(&messages)?;
        for m in &messages {
            let (content, error) = if m.kind != "msg" || m.payload.is_none() {
                (None, None)
            } else {
                match self.open_message(m) {
                    Ok(c) => (Some(c), None),
                    Err(e) => (None, Some(e.to_string())),
                }
            };
            if as_json {
                let mut line = json!({
                    "id": m.id,
                    "seq": m.seq,
                    "senderId": m.sender_id,
                    "createdAt": m.created_at,
                    "kind": m.kind,
                    "content": content,
                });
                if m.kind == "system" {
                    line["event"] = m.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or(Value::Null);
                }
                if m.deleted_at.is_some() {
                    line["deleted"] = Value::from(true);
                }
                if let Some(e) = error {
                    line["error"] = Value::from(e);
                }
                writeln!(out, "{line}")?;
            } else {
                let body = if m.kind == "system" {
                    let event: Value = m.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or(Value::Null);
                    let users: Vec<&str> = event["users"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                    format!("* {} {} {}", m.sender_id, event["event"].as_str().unwrap_or("changed the chat"), users.join(", "))
                        .trim_end()
                        .to_string()
                } else if m.deleted_at.is_some() {
                    format!("{}: (message deleted)", m.sender_id)
                } else if m.payload.is_none() {
                    format!("{}: (view once, opened)", m.sender_id)
                } else {
                    match (&content, &error) {
                        (Some(c), _) => format!("{}: {}", m.sender_id, describe(c)),
                        (None, Some(e)) => format!("{}: (cannot decrypt: {e})", m.sender_id),
                        (None, None) => format!("{}: (empty)", m.sender_id),
                    }
                };
                writeln!(out, "{}  {body}", format_time(m.created_at))?;
            }
        }
        Ok(())
    }

    /// Download and decrypt every file shared in the chat into `dir`.
    pub fn receive(&mut self, chat: &Chat, dir: &Path) -> Result<ReceiveSummary> {
        fs::create_dir_all(dir).ctx(dir.display())?;
        let messages = self.client.all_messages(&chat.id)?;
        self.prefetch_senders(&messages)?;
        let mut summary = ReceiveSummary::default();
        for m in messages.iter().filter(|m| m.kind == "msg" && m.payload.is_some() && m.deleted_at.is_none()) {
            let content = match self.open_message(m) {
                Ok(c) => c,
                Err(OpenError::NoKey) => {
                    summary.unreadable += 1;
                    continue;
                }
                Err(e) => {
                    if !m.files.is_empty() {
                        eprintln!("skipping message {}: {e}", m.id);
                        summary.failed += 1;
                    }
                    continue;
                }
            };
            if content["type"] != "media" || !content["file"].is_object() {
                continue;
            }
            if m.view_once {
                summary.view_once += 1;
                continue;
            }
            let file: FileRef = match serde_json::from_value(content["file"].clone()) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("skipping message {}: bad file description: {e}", m.id);
                    summary.failed += 1;
                    continue;
                }
            };
            let kind = content["kind"].as_str().unwrap_or("file");
            let name = file.name.as_deref().and_then(safe_file_name).unwrap_or_else(|| {
                format!("{kind}-{}.{}", m.id, extension_for(file.mime.as_deref().unwrap_or("")))
            });
            match self.receive_file(dir, &name, &file, m.created_at) {
                Ok(Some(path)) => {
                    summary.saved += 1;
                    if self.quiet {
                        continue;
                    }
                    eprintln!("Saved {}", path.display());
                }
                Ok(None) => {
                    summary.present += 1;
                    if !self.quiet {
                        eprintln!("Already have {name}");
                    }
                }
                Err(e) => {
                    summary.failed += 1;
                    eprintln!("error: {name}: {e}");
                }
            }
        }
        Ok(summary)
    }

    /// Returns `None` if an identical file is already in `dir`.
    fn receive_file(&mut self, dir: &Path, name: &str, file: &FileRef, created_at: i64) -> Result<Option<PathBuf>> {
        let mut target = None;
        for candidate in candidate_names(dir, name) {
            match fs::metadata(&candidate) {
                Err(_) => {
                    target = Some(candidate);
                    break;
                }
                Ok(meta) if meta.is_file() && meta.len() == file.size => {
                    let same = match &file.sha256 {
                        Some(expected) => {
                            let f = fs::File::open(&candidate).ctx(candidate.display())?;
                            crate::file::chunked_sha256(BufReader::new(f)).map(|(_, sha)| sha == *expected).unwrap_or(false)
                        }
                        None => true,
                    };
                    if same {
                        return Ok(None);
                    }
                }
                Ok(_) => {}
            }
        }
        let target = target.expect("candidate_names never ends");
        let key = FileKey::from_b64u(&file.key, &file.prefix)?;
        let (declared, body) = self.client.download(&file.id)?;
        if let Some(len) = declared {
            if len != encrypted_size(file.size) {
                return Err(Error::msg(format!(
                    "the server has {len} bytes but a {}-byte file encrypts to {}",
                    file.size,
                    encrypted_size(file.size)
                )));
            }
        }
        let tmp = dir.join(format!(".{}.{}.part", name, b64u(&random_bytes::<6>())));
        let out = state::open_private(&tmp).ctx(tmp.display())?;
        let mut progress = Progress::new(name.to_string(), file.size, self.quiet);
        let result = (|| -> Result<()> {
            let mut writer = BufWriter::with_capacity(1 << 20, out);
            decrypt_stream(BufReader::with_capacity(1 << 18, body), &mut writer, &key, file.size, file.sha256.as_deref(), |n| {
                progress.update(n)
            })?;
            let out = writer.into_inner().map_err(|e| Error::msg(e.to_string()))?;
            if created_at > 0 {
                let _ = out.set_modified(UNIX_EPOCH + Duration::from_millis(created_at as u64));
            }
            out.sync_all()?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                // Someone may have created the name meanwhile: never overwrite.
                let target = if target.exists() { unique_path(dir, name) } else { target };
                fs::rename(&tmp, &target).ctx(target.display())?;
                progress.abandon();
                Ok(Some(target))
            }
            Err(e) => {
                progress.abandon();
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    // ---------- watch ----------

    pub fn watch(&mut self, chat: &Chat, dir: &Path, opts: &WatchOptions) -> Result<()> {
        fs::create_dir_all(dir).ctx(dir.display())?;
        let sent_dir = dir.join(".sent");
        if !self.quiet {
            eprintln!(
                "Watching {} -> {} (sent files move to {}){}",
                dir.display(),
                self.chat_label(chat),
                sent_dir.display(),
                if opts.once { "" } else { "; Ctrl-C to stop" }
            );
        }
        struct Pending {
            size: u64,
            mtime: Option<SystemTime>,
            stable_since: Instant,
            failures: u32,
            retry_at: Option<Instant>,
        }
        let mut pending: HashMap<String, Pending> = HashMap::new();
        // Files that were sent but could not be moved away: don't send again.
        let mut stuck: HashSet<(String, u64, Option<SystemTime>)> = HashSet::new();
        let mut failed_once = 0usize;
        loop {
            let now = Instant::now();
            let mut seen = HashSet::new();
            for entry in fs::read_dir(dir).ctx(dir.display())? {
                let Ok(entry) = entry else { continue };
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_droppable(&name) {
                    continue;
                }
                let Ok(meta) = fs::metadata(entry.path()) else { continue };
                if !meta.is_file() {
                    continue;
                }
                let (size, mtime) = (meta.len(), meta.modified().ok());
                if stuck.contains(&(name.clone(), size, mtime)) {
                    continue;
                }
                seen.insert(name.clone());
                let old_enough = mtime
                    .and_then(|t| SystemTime::now().duration_since(t).ok())
                    .is_some_and(|age| age >= opts.settle);
                let p = pending.entry(name.clone()).or_insert_with(|| Pending {
                    size,
                    mtime,
                    stable_since: if old_enough { now.checked_sub(opts.settle).unwrap_or(now) } else { now },
                    failures: 0,
                    retry_at: None,
                });
                if p.size != size || p.mtime != mtime {
                    p.size = size;
                    p.mtime = mtime;
                    p.stable_since = now;
                }
            }
            pending.retain(|name, _| seen.contains(name));

            let mut ready: Vec<String> = pending
                .iter()
                .filter(|(_, p)| now.duration_since(p.stable_since) >= opts.settle && p.retry_at.is_none_or(|t| now >= t))
                .map(|(n, _)| n.clone())
                .collect();
            ready.sort();
            for name in ready {
                let path = dir.join(&name);
                match self.send_file(chat, &path, &opts.send) {
                    Ok(_) => {
                        let p = pending.remove(&name).expect("ready names are pending");
                        let moved = fs::create_dir_all(&sent_dir).and_then(|()| fs::rename(&path, unique_path(&sent_dir, &name)));
                        if let Err(e) = moved {
                            eprintln!("warning: sent {name} but could not move it to {}: {e}", sent_dir.display());
                            stuck.insert((name, p.size, p.mtime));
                        }
                    }
                    Err(e) => {
                        eprintln!("error: {name}: {e}");
                        if opts.once {
                            failed_once += 1;
                            let p = pending.remove(&name).expect("ready names are pending");
                            stuck.insert((name, p.size, p.mtime));
                        } else if let Some(p) = pending.get_mut(&name) {
                            p.failures += 1;
                            let backoff = Duration::from_secs(5u64.saturating_mul(1 << p.failures.min(6)).min(300));
                            p.retry_at = Some(Instant::now() + backoff);
                        }
                    }
                }
            }
            if opts.once && pending.is_empty() {
                return if failed_once == 0 { Ok(()) } else { Err(Error::msg(format!("{failed_once} file(s) could not be sent"))) };
            }
            std::thread::sleep(opts.interval);
        }
    }

    // ---------- identity ----------

    pub fn whoami(&mut self, out: &mut dyn Write) -> Result<()> {
        let me = self.client.me()?;
        let devices = self.client.user_devices(&me.user.id)?;
        let keys: Vec<PublicJwk> = devices.iter().map(|d| d.public_key.clone()).collect();
        writeln!(out, "user:          {}{}", me.user.id, me.user.name.as_deref().map(|n| format!(" ({n})")).unwrap_or_default())?;
        writeln!(out, "device:        {} ({})", self.state.device_id, self.state.device_name)?;
        writeln!(out, "server:        {} (auth: {})", self.client.base(), me.auth_mode.as_deref().unwrap_or("?"))?;
        writeln!(out, "state file:    {}", self.state_path.display())?;
        writeln!(out, "devices:       {}", devices.len())?;
        writeln!(out, "security code: {}", security_code(&keys)?)?;
        Ok(())
    }

    pub fn list_chats(&self, out: &mut dyn Write) -> Result<()> {
        for c in self.client.chats()? {
            writeln!(out, "{}  {:<6}  {}", c.id, c.kind, self.chat_label(&c))?;
        }
        Ok(())
    }
}

/// Files a drop folder should pick up: no hidden files, no partial downloads.
pub fn is_droppable(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.starts_with('.')
        && ![".part", ".partial", ".crdownload", ".download", ".tmp", ".temp", "~"].iter().any(|s| lower.ends_with(s))
}

/// One line describing decrypted content, for `history`.
pub fn describe(c: &Value) -> String {
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut prefix = String::new();
    if c["forwarded"] == true {
        prefix.push_str("(forwarded) ");
    }
    if let Some(preview) = c["replyTo"]["preview"].as_str() {
        prefix.push_str(&format!("(reply to \"{preview}\") "));
    }
    let body = match c["type"].as_str().unwrap_or("") {
        "text" => s(&c["text"]),
        "media" => {
            let f = &c["file"];
            let mut d = format!("[{}] {}", c["kind"].as_str().unwrap_or("file"), f["name"].as_str().unwrap_or("(unnamed)"));
            if let Some(size) = f["size"].as_u64() {
                d.push_str(&format!(" ({})", human_bytes(size)));
            }
            if let Some(caption) = c["caption"].as_str() {
                d.push_str(&format!(" - {caption}"));
            }
            d
        }
        "location" => format!("[location] {}, {} {}", c["lat"], c["lon"], s(&c["name"])).trim_end().to_string(),
        "contact" => format!("[contact] {} ({})", s(&c["name"]), s(&c["userId"])),
        "poll" => {
            let options: Vec<String> = c["options"].as_array().map(|a| a.iter().map(s).collect()).unwrap_or_default();
            format!("[poll] {} ({})", s(&c["question"]), options.join(" / "))
        }
        "call" => format!("[{} call]", if c["video"] == true { "video" } else { "voice" }),
        other => format!("[{other}]"),
    };
    format!("{prefix}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_times() {
        assert_eq!(format_time(0), "1970-01-01 00:00:00Z");
        assert_eq!(format_time(1_700_000_000_000), "2023-11-14 22:13:20Z");
        assert_eq!(format_time(951_782_400_000), "2000-02-29 00:00:00Z");
        assert_eq!(format_time(-1000), "1969-12-31 23:59:59Z");
    }

    #[test]
    fn drop_folder_filter() {
        assert!(is_droppable("report.pdf"));
        assert!(!is_droppable(".DS_Store"));
        assert!(!is_droppable("movie.mkv.part"));
        assert!(!is_droppable("x.crdownload"));
        assert!(!is_droppable("notes.txt~"));
    }

    #[test]
    fn describes_content() {
        assert_eq!(describe(&json!({"type": "text", "text": "hi"})), "hi");
        assert_eq!(
            describe(&json!({"type": "media", "kind": "image", "file": {"name": "a.png", "size": 2048}, "caption": "look"})),
            "[image] a.png (2.0 KiB) - look"
        );
        assert_eq!(describe(&json!({"type": "text", "text": "x", "forwarded": true})), "(forwarded) x");
        assert_eq!(describe(&json!({"type": "poll", "question": "Lunch?", "options": ["a", "b"]})), "[poll] Lunch? (a / b)");
    }
}
