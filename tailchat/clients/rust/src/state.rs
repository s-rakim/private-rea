//! The device's identity on disk: private key and bearer token, in a JSON
//! file only the owner can read (0600, written atomically).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::crypto::{random_bytes, PrivateJwk};
use crate::error::{Error, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub server: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_user: Option<String>,
    pub user_id: String,
    pub device_id: String,
    pub device_name: String,
    pub token: String,
    pub private_key: PrivateJwk,
    pub created_at: u64,
}

/// `$XDG_CONFIG_HOME/tailchat-drop` (or `~/.config/tailchat-drop`).
pub fn config_dir() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(x).join("tailchat-drop"));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(home).join(".config").join("tailchat-drop"));
    }
    std::env::var_os("APPDATA").filter(|v| !v.is_empty()).map(|a| PathBuf::from(a).join("tailchat-drop"))
}

/// One state file per server (and per dev user): `chat.example.ts.net.json`.
pub fn default_file_name(server: &str, dev_user: Option<&str>) -> String {
    let host = server.split_once("://").map_or(server, |(_, rest)| rest).trim_end_matches('/');
    let mut slug: String =
        host.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    if let Some(user) = dev_user {
        slug.push_str("+dev-");
        slug.extend(user.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }));
    }
    format!("{slug}.json")
}

pub fn load(path: &Path) -> Result<Option<State>> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::msg(format!("reading {}: {e}", path.display()))),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                eprintln!("warning: {} is readable by other users; restricting it to 0600", path.display());
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
        }
    }
    serde_json::from_str(&text).map(Some).map_err(|e| Error::msg(format!("{} is not a valid state file: {e}", path.display())))
}

pub fn save(path: &Path, state: &State) -> Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    create_private_dir(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state.json");
    let tmp = dir.join(format!(".{name}.{}.tmp", crate::crypto::b64u(&random_bytes::<6>())));
    let result = (|| -> std::io::Result<()> {
        let mut file = open_private(&tmp)?;
        file.write_all(serde_json::to_string_pretty(state).map_err(std::io::Error::other)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(Error::msg(format!("writing {}: {e}", path.display())));
    }
    Ok(())
}

fn create_private_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|e| Error::msg(format!("creating {}: {e}", dir.display())))
}

/// Create a new file readable and writable by the owner only.
pub fn open_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_per_server_and_dev_user() {
        assert_eq!(default_file_name("https://chat.tail1234.ts.net/", None), "chat.tail1234.ts.net.json");
        assert_eq!(default_file_name("http://127.0.0.1:8443", Some("alice")), "127.0.0.1_8443+dev-alice.json");
    }

    #[test]
    fn saves_with_owner_only_permissions() {
        let dir = std::env::temp_dir().join(format!("tailchat-drop-state-{}", crate::crypto::b64u(&random_bytes::<6>())));
        let path = dir.join("nested").join("state.json");
        let key = crate::crypto::DeviceKey::generate();
        let state = State {
            server: "http://127.0.0.1:1".into(),
            dev_user: Some("alice".into()),
            user_id: "alice@dev".into(),
            device_id: "dev1".into(),
            device_name: "test".into(),
            token: "dev1.secret".into(),
            private_key: key.to_jwk(),
            created_at: 1,
        };
        save(&path, &state).unwrap();
        save(&path, &state).unwrap(); // overwriting works too
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let back = load(&path).unwrap().unwrap();
        assert_eq!(back.token, "dev1.secret");
        assert_eq!(crate::crypto::DeviceKey::from_jwk(&back.private_key).unwrap().public_jwk(), key.public_jwk());
        assert!(load(&dir.join("missing.json")).unwrap().is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}
