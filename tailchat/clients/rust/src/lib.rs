//! tailchat-drop: end-to-end encrypted file sharing for Tailchat.
//!
//! The crypto (`crypto`, `file`) is byte-for-byte compatible with the
//! reference implementation in `public/crypto.js`; see PROTOCOL.md.

pub mod api;
pub mod app;
pub mod crypto;
pub mod error;
pub mod file;
pub mod media;
pub mod progress;
pub mod state;
