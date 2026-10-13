//! A small blocking client for the Tailchat REST API (PROTOCOL.md §1, §7).

use std::io::Read;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ureq::{Agent, SendBody};

use crate::crypto::PublicJwk;
use crate::error::{Error, Result};

/// Largest JSON answer we accept (a page of messages can carry big envelopes).
const MAX_JSON: u64 = 256 * 1024 * 1024;

pub struct Client {
    base: String,
    agent: Agent,
    dev_user: Option<String>,
    token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub user_id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub public_key: PublicJwk,
    #[serde(default)]
    pub revoked_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub user: User,
    pub device: Option<Device>,
    #[serde(default)]
    pub auth_mode: Option<String>,
    #[serde(default)]
    pub limits: Option<Limits>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_upload_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    #[serde(default)]
    pub left: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub members: Vec<Member>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub chat_id: String,
    pub seq: i64,
    pub sender_id: String,
    #[serde(default)]
    pub sender_device: Option<String>,
    pub kind: String,
    pub payload: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub view_once: bool,
    pub created_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesPage {
    messages: Vec<Message>,
    #[serde(default)]
    has_more: bool,
}

#[derive(Debug, Deserialize)]
pub struct Registered {
    pub device: Device,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewMessage<'a> {
    id: &'a str,
    payload: &'a str,
    files: &'a [String],
}

/// Percent-encode a path segment or query value (keeps RFC 3986 unreserved).
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Client {
    pub fn new(server: &str, dev_user: Option<String>) -> Result<Self> {
        let base = server.trim_end_matches('/').to_string();
        if !(base.starts_with("https://") || base.starts_with("http://")) {
            return Err(Error::msg(format!("server URL must start with https:// or http://, got {server:?}")));
        }
        let config = Agent::config_builder()
            // Error bodies carry the server's explanation; read them ourselves.
            .http_status_as_error(false)
            // The tailnet is reached directly, never through an HTTP proxy.
            .proxy(None)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(300)))
            .timeout_recv_body(None)
            .user_agent(concat!("tailchat-drop/", env!("CARGO_PKG_VERSION")))
            .build();
        Ok(Client { base, agent: config.new_agent(), dev_user, token: None })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn set_token(&mut self, token: String) {
        self.token = Some(token);
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn decorate<B>(&self, mut req: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
        if let Some(user) = &self.dev_user {
            req = req.header("X-Dev-User", user);
        }
        if let Some(token) = &self.token {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        req
    }

    fn check(resp: ureq::http::Response<ureq::Body>, what: &str) -> Result<ureq::http::Response<ureq::Body>> {
        let status = resp.status().as_u16();
        if status < 400 {
            return Ok(resp);
        }
        let mut body = resp.into_body();
        let text = body.with_config().limit(64 * 1024).read_to_string().unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| if text.trim().is_empty() { format!("{what} failed") } else { text.trim().to_string() });
        Err(Error::Http { status, message })
    }

    fn json<T: DeserializeOwned>(resp: ureq::http::Response<ureq::Body>, what: &str) -> Result<T> {
        let mut resp = Self::check(resp, what)?;
        let text = resp.body_mut().with_config().limit(MAX_JSON).read_to_string()?;
        serde_json::from_str(&text).map_err(|e| Error::msg(format!("{what}: unexpected answer from the server: {e}")))
    }

    pub fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let resp = self.decorate(self.agent.get(self.url(path))).call()?;
        Self::json(resp, &format!("GET {path}"))
    }

    pub fn post<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        let resp = self.decorate(self.agent.post(self.url(path))).send_json(body)?;
        Self::json(resp, &format!("POST {path}"))
    }

    // ---------- endpoints ----------

    pub fn register(&self, name: &str, public_key: &PublicJwk) -> Result<Registered> {
        self.post("/api/devices", &serde_json::json!({ "name": name, "publicKey": public_key }))
    }

    pub fn me(&self) -> Result<Me> {
        self.get("/api/me")
    }

    pub fn user_devices(&self, user_id: &str) -> Result<Vec<Device>> {
        #[derive(Deserialize)]
        struct R {
            devices: Vec<Device>,
        }
        Ok(self.get::<R>(&format!("/api/users/{}/devices", enc(user_id)))?.devices)
    }

    /// Public keys by device id, logged-out devices included.
    pub fn keys(&self, ids: &[&str]) -> Result<Vec<Device>> {
        #[derive(Deserialize)]
        struct R {
            devices: Vec<Device>,
        }
        let joined: Vec<String> = ids.iter().map(|id| enc(id)).collect();
        Ok(self.get::<R>(&format!("/api/keys?ids={}", joined.join(",")))?.devices)
    }

    pub fn chats(&self) -> Result<Vec<Chat>> {
        #[derive(Deserialize)]
        struct R {
            chats: Vec<Chat>,
        }
        Ok(self.get::<R>("/api/chats")?.chats)
    }

    pub fn chat(&self, chat_id: &str) -> Result<Chat> {
        #[derive(Deserialize)]
        struct R {
            chat: Chat,
        }
        Ok(self.get::<R>(&format!("/api/chats/{}", enc(chat_id)))?.chat)
    }

    /// Opens (or creates) the direct chat with a user.
    pub fn direct_chat(&self, user_id: &str) -> Result<Chat> {
        #[derive(Deserialize)]
        struct R {
            chat: Chat,
        }
        Ok(self.post::<R>("/api/chats/direct", &serde_json::json!({ "userId": user_id }))?.chat)
    }

    /// Every logged-in device of every current member (including ours).
    pub fn chat_devices(&self, chat_id: &str) -> Result<Vec<Device>> {
        #[derive(Deserialize)]
        struct R {
            devices: Vec<Device>,
        }
        Ok(self.get::<R>(&format!("/api/chats/{}/devices", enc(chat_id)))?.devices)
    }

    /// One page of history, oldest first. `before` is an exclusive seq bound.
    pub fn messages(&self, chat_id: &str, before: Option<i64>, limit: u32) -> Result<(Vec<Message>, bool)> {
        let mut path = format!("/api/chats/{}/messages?limit={limit}", enc(chat_id));
        if let Some(b) = before {
            path.push_str(&format!("&before={b}"));
        }
        let page: MessagesPage = self.get(&path)?;
        Ok((page.messages, page.has_more))
    }

    /// The whole visible history of a chat, oldest first.
    pub fn all_messages(&self, chat_id: &str) -> Result<Vec<Message>> {
        let mut all: Vec<Message> = Vec::new();
        let mut before = None;
        loop {
            let (mut page, more) = self.messages(chat_id, before, 200)?;
            let lowest = page.first().map(|m| m.seq);
            page.append(&mut all);
            all = page;
            match lowest {
                Some(seq) if more && seq > 1 => before = Some(seq),
                _ => return Ok(all),
            }
        }
    }

    pub fn send_message(&self, chat_id: &str, id: &str, payload: &str, files: &[String]) -> Result<Message> {
        #[derive(Deserialize)]
        struct R {
            message: Message,
        }
        let body = NewMessage { id, payload, files };
        Ok(self.post::<R>(&format!("/api/chats/{}/messages", enc(chat_id)), &body)?.message)
    }

    /// Stream an upload of exactly `len` bytes; returns the file id.
    pub fn upload(&self, body: &mut dyn Read, len: u64) -> Result<String> {
        #[derive(Deserialize)]
        struct R {
            id: String,
        }
        let req = self
            .decorate(self.agent.post(self.url("/api/files")))
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", len.to_string());
        let resp = req.send(SendBody::from_reader(body))?;
        Ok(Self::json::<R>(resp, "upload")?.id)
    }

    /// Start a download; returns the declared length and a reader over the body.
    pub fn download(&self, file_id: &str) -> Result<(Option<u64>, impl Read)> {
        let resp = self.decorate(self.agent.get(self.url(&format!("/api/files/{}", enc(file_id))))).call()?;
        let resp = Self::check(resp, "download")?;
        let body = resp.into_body();
        Ok((body.content_length(), body.into_reader()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoding() {
        assert_eq!(enc("alice@example.com"), "alice%40example.com");
        assert_eq!(enc("Ab-_.~09"), "Ab-_.~09");
        assert_eq!(enc("a b/c,d"), "a%20b%2Fc%2Cd");
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(Client::new("ftp://x", None).is_err());
        assert!(Client::new("https://chat.example.ts.net/", None).is_ok());
    }
}
