"""Runtime settings, all from environment variables so the server can run as a
systemd unit next to tailscaled without a config file."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


@dataclass(frozen=True)
class Config:
    auth: str
    host: str
    port: int
    data_dir: Path
    public_dir: Path
    tls_cert: str
    tls_key: str
    allowed_hosts: tuple[str, ...]
    tailscale_socket: str
    max_upload_bytes: int
    status_hours: int
    edit_window_s: int
    delete_window_s: int
    sweep_interval_s: float


def _int(env: dict, name: str, fallback: int) -> int:
    raw = env.get(name)
    if raw in (None, ""):
        return fallback
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f'{name} must be a number, got "{raw}"') from None


def load_config(env: dict | None = None) -> Config:
    env = dict(os.environ if env is None else env)
    auth = env.get("TAILCHAT_AUTH") or "serve"
    if auth not in ("serve", "direct", "dev"):
        raise ValueError(f'TAILCHAT_AUTH must be serve, direct or dev, got "{auth}"')
    # serve and dev only ever accept connections from this machine: in serve
    # mode tailscaled is the only client, and dev mode must never be reachable
    # from the network because anyone could pick any identity.
    host = env.get("TAILCHAT_HOST", "" if auth == "direct" else "127.0.0.1")
    if auth == "dev" and host not in LOOPBACK_HOSTS:
        raise ValueError("TAILCHAT_AUTH=dev only listens on loopback (set TAILCHAT_HOST=127.0.0.1)")
    if auth == "direct" and not host:
        raise ValueError("TAILCHAT_AUTH=direct needs TAILCHAT_HOST set to this machine's Tailscale IP (tailscale ip -4)")
    tls_cert, tls_key = env.get("TAILCHAT_TLS_CERT", ""), env.get("TAILCHAT_TLS_KEY", "")
    if bool(tls_cert) != bool(tls_key):
        raise ValueError("Set both TAILCHAT_TLS_CERT and TAILCHAT_TLS_KEY, or neither")
    # Browsers only allow the web app's crypto over HTTPS, and plain HTTP on
    # the tailnet IP would let a web page rebind its own name to it.
    if auth == "direct" and not tls_cert:
        raise ValueError("TAILCHAT_AUTH=direct needs TAILCHAT_TLS_CERT and TAILCHAT_TLS_KEY (from `tailscale cert`)")
    allowed = tuple(h.strip().lower().rstrip(".") for h in env.get("TAILCHAT_ALLOWED_HOSTS", "").split(",") if h.strip())
    return Config(
        auth=auth,
        host=host,
        port=_int(env, "TAILCHAT_PORT", 8443),
        data_dir=Path(env.get("TAILCHAT_DATA") or ROOT / "data").resolve(),
        public_dir=ROOT / "public",
        tls_cert=tls_cert,
        tls_key=tls_key,
        allowed_hosts=allowed,
        tailscale_socket=env.get("TAILSCALE_SOCKET", "/var/run/tailscale/tailscaled.sock"),
        max_upload_bytes=_int(env, "TAILCHAT_MAX_UPLOAD_MB", 2048) * 1024 * 1024,
        status_hours=_int(env, "TAILCHAT_STATUS_HOURS", 24),
        edit_window_s=_int(env, "TAILCHAT_EDIT_WINDOW_S", 15 * 60),
        delete_window_s=_int(env, "TAILCHAT_DELETE_WINDOW_S", 2 * 24 * 3600),
        sweep_interval_s=_int(env, "TAILCHAT_SWEEP_INTERVAL_MS", 15000) / 1000,
    )
