//! One error type for the whole tool: either an HTTP error answered by the
//! server (with its status, so callers can react to 401/404) or a message.

use std::fmt;

#[derive(Debug)]
pub enum Error {
    /// The server answered with an error status and `{"error": "..."}`.
    Http { status: u16, message: String },
    /// Anything else, already phrased for a human.
    Msg(String),
    /// Our stdout was closed (`tailchat-drop history x | head`).
    BrokenPipe,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn msg(text: impl Into<String>) -> Self {
        Error::Msg(text.into())
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Http { status, .. } => Some(*status),
            Error::Msg(_) | Error::BrokenPipe => None,
        }
    }

    /// Prefix the error with what we were doing ("reading foo.txt: ...").
    pub fn context(self, what: impl fmt::Display) -> Self {
        match self {
            Error::Http { status, message } => Error::Http { status, message: format!("{what}: {message}") },
            Error::Msg(m) => Error::Msg(format!("{what}: {m}")),
            Error::BrokenPipe => Error::BrokenPipe,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Http { status, message } => write!(f, "{message} (HTTP {status})"),
            Error::Msg(m) => f.write_str(m),
            Error::BrokenPipe => f.write_str("broken pipe"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::BrokenPipe {
            Error::BrokenPipe
        } else {
            Error::Msg(e.to_string())
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Msg(format!("bad JSON: {e}"))
    }
}

impl From<ureq::Error> for Error {
    fn from(e: ureq::Error) -> Self {
        match e {
            ureq::Error::Io(io) => Error::Msg(format!("network error: {io}")),
            other => Error::Msg(format!("network error: {other}")),
        }
    }
}

/// `result.ctx("doing x")?` adds context to any error convertible to ours.
pub trait Context<T> {
    fn ctx(self, what: impl fmt::Display) -> Result<T>;
}

impl<T, E: Into<Error>> Context<T> for std::result::Result<T, E> {
    fn ctx(self, what: impl fmt::Display) -> Result<T> {
        self.map_err(|e| e.into().context(what))
    }
}
