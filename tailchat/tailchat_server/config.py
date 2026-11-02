"""Runtime settings, all from environment variables, which docker-compose.yml
sets for the Tailchat container."""

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
    tailnet: str
    dev_tailnet: str
    list_self: bool
    max_upload_bytes: int
    status_hours: int
    edit_window_s: int
    delete_window_s: int
    sweep_interval_s: float
    # How long an unanswered call rings, and how long a device in a call may
    # be offline before it is dropped from it.
    ring_s: float = 45.0
    call_grace_s: float = 30.0


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
    if auth not in ("serve", "dev"):
        raise ValueError(f'TAILCHAT_AUTH must be serve or dev, got "{auth}"')
    # serve and dev only ever accept connections from this machine: in serve
    # mode tailscaled (the tailscale container) is the only client, and dev
    # mode must never be reachable from the network because anyone could pick
    # any identity.
    host = env.get("TAILCHAT_HOST", "127.0.0.1")
    if auth == "dev" and host not in LOOPBACK_HOSTS:
        raise ValueError("TAILCHAT_AUTH=dev only listens on loopback (set TAILCHAT_HOST=127.0.0.1)")
    tls_cert, tls_key = env.get("TAILCHAT_TLS_CERT", ""), env.get("TAILCHAT_TLS_KEY", "")
    if bool(tls_cert) != bool(tls_key):
        raise ValueError("Set both TAILCHAT_TLS_CERT and TAILCHAT_TLS_KEY, or neither")
    allowed = tuple(h.strip().lower().rstrip(".") for h in env.get("TAILCHAT_ALLOWED_HOSTS", "").split(",") if h.strip())
    # Where the list of your machines comes from (see machines.py).
    dev_tailnet = env.get("TAILCHAT_DEV_TAILNET", "")
    if dev_tailnet and auth != "dev":
        raise ValueError("TAILCHAT_DEV_TAILNET only works with TAILCHAT_AUTH=dev")
    tailnet = env.get("TAILCHAT_TAILNET") or ("localapi" if auth != "dev" else "dev" if dev_tailnet else "off")
    if tailnet not in ("localapi", "dev", "off") or (tailnet == "dev" and not (auth == "dev" and dev_tailnet)):
        raise ValueError("TAILCHAT_TAILNET must be localapi or off (dev needs TAILCHAT_AUTH=dev and TAILCHAT_DEV_TAILNET)")
    # The server is its own node in Docker, so by default its machine is not
    # one of yours.
    list_self = env.get("TAILCHAT_LIST_SELF", "0").lower() in ("1", "true", "yes")
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
        tailnet=tailnet,
        dev_tailnet=dev_tailnet,
        list_self=list_self,
        max_upload_bytes=_int(env, "TAILCHAT_MAX_UPLOAD_MB", 2048) * 1024 * 1024,
        status_hours=_int(env, "TAILCHAT_STATUS_HOURS", 24),
        edit_window_s=_int(env, "TAILCHAT_EDIT_WINDOW_S", 15 * 60),
        delete_window_s=_int(env, "TAILCHAT_DELETE_WINDOW_S", 2 * 24 * 3600),
        sweep_interval_s=_int(env, "TAILCHAT_SWEEP_INTERVAL_MS", 15000) / 1000,
        ring_s=_int(env, "TAILCHAT_RING_MS", 45000) / 1000,
        call_grace_s=_int(env, "TAILCHAT_CALL_GRACE_MS", 30000) / 1000,
    )
