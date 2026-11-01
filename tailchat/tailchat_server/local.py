"""Run Tailchat as a normal program next to the Tailscale app, without Docker:
python -m tailchat_server --tailscale

It checks that Tailscale is signed in with HTTPS certificates on, points
`tailscale serve` at the server through a secret path (see config.py), runs
the server and turns serve off again when it stops."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
from pathlib import Path

from .config import SECRET

KNOWN_PATHS = [
    r"C:\Program Files\Tailscale\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
]


class SetupError(Exception):
    pass


def find_tailscale() -> str:
    found = shutil.which("tailscale")
    if found:
        return found
    for path in KNOWN_PATHS:
        if os.path.isfile(path):
            return path
    raise SetupError("Can't find the tailscale command. Install Tailscale from https://tailscale.com/download and sign in.")


def tailnet_name(status: dict) -> str:
    """This machine's https name from `tailscale status --json`."""
    if status.get("BackendState") != "Running":
        raise SetupError("Tailscale isn't connected. Open the Tailscale app, sign in and connect, then try again.")
    domains = status.get("CertDomains") or []
    if not domains:
        raise SetupError(
            "HTTPS certificates are off for your tailnet. Turn on MagicDNS and HTTPS certificates at "
            "https://login.tailscale.com/admin/dns, then try again."
        )
    name = ((status.get("Self") or {}).get("DNSName") or "").rstrip(".")
    return name if name in domains else domains[0]


def load_secret(data_dir: Path) -> str:
    """The secret path segment, made once and kept with the data."""
    path = data_dir / "serve-secret"
    if path.is_file():
        secret = path.read_text().strip()
        if SECRET.match(secret):
            return secret
    data_dir.mkdir(parents=True, exist_ok=True)
    secret = secrets.token_urlsafe(32)
    path.write_text(secret)
    return secret


class TailscaleServe:
    def __init__(self, port: int, data_dir: Path):
        self.cli = find_tailscale()
        self.port = port
        self.data_dir = data_dir

    def _run(self, *args: str, capture: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run([self.cli, *args], capture_output=capture, text=True, timeout=30 if capture else None)

    def prepare(self) -> tuple[str, str]:
        """Returns (secret, https url) and points serve at the server."""
        res = self._run("status", "--json", capture=True)
        try:
            status = json.loads(res.stdout)
        except ValueError:
            raise SetupError(f"tailscale status failed: {(res.stderr or res.stdout).strip()}") from None
        name = tailnet_name(status)
        secret = load_secret(self.data_dir)
        # Not captured: the first time, tailscale may print a link to enable
        # Serve for the tailnet and wait until you have.
        target = f"http://127.0.0.1:{self.port}/{secret}"
        if self._run("serve", "--bg", "--https=443", target).returncode != 0:
            raise SetupError("`tailscale serve` failed (see above). Tailchat needs port 443 on this machine's tailnet name.")
        return secret, f"https://{name}"

    def stop(self) -> None:
        try:
            self._run("serve", "--https=443", "off", capture=True)
        except Exception:
            pass
