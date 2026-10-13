"""The device's local state: server address, device id, bearer token and private key."""

from __future__ import annotations

import json
import os
import stat
from dataclasses import asdict, dataclass
from pathlib import Path


def default_state_path() -> Path:
    env = os.environ.get("TAILCHAT_STATE")
    if env:
        return Path(env).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return Path(base) / "tailchat" / "state.json"


@dataclass
class State:
    server: str
    device_id: str
    token: str
    user_id: str
    private_key_pem: str
    dev_user: str | None = None
    device_name: str = ""

    def save(self, path: Path) -> None:
        """Writes the file atomically, readable by the owner only (0600)."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_name(path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(asdict(self), f, indent=2)
                f.write("\n")
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: Path) -> "State":
        path = Path(path)
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise PermissionError(f"{path} is accessible by other users (mode {oct(mode)}); run: chmod 600 {path}")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return cls(**{k: data.get(k) for k in cls.__dataclass_fields__ if k in data})
