"""Who is on the other end of a connection. Tailchat has no passwords: the
tailnet already knows who every device belongs to, so identity comes from
Tailscale.

  serve  - run behind `tailscale serve`. tailscaled terminates HTTPS with the
           machine's ts.net certificate and adds Tailscale-User-* headers.
           Only connections from loopback (tailscaled itself) are accepted.
  dev    - local testing only: pick a user at /dev/login. Loopback only.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from email.errors import HeaderParseError
from email.header import decode_header, make_header

from .config import Config

DEV_USER = re.compile(r"^[a-z0-9._-]{1,32}$")
TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


class IdentityError(Exception):
    def __init__(self, message: str, status: int = 403):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Identity:
    login: str
    name: str
    avatar_url: str | None


def _addr(raw: str | None):
    if not raw:
        return None
    try:
        ip = ipaddress.ip_address(raw.split("%")[0])
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        return ip.ipv4_mapped
    return ip


def is_loopback(raw: str | None) -> bool:
    ip = _addr(raw)
    return bool(ip and ip.is_loopback)


def is_tailnet_address(raw: str | None) -> bool:
    ip = _addr(raw)
    if ip is None:
        return False
    return ip in TAILNET_V4 if ip.version == 4 else ip in TAILNET_V6


LOGIN = re.compile(r"^[^\s\x00-\x1f\x7f/\\]{1,320}$")


def decode_header_word(value: str | None) -> str:
    """tailscaled RFC 2047 encodes Tailscale-User-Name and -Login when they
    aren't plain ASCII. A long value is split into several encoded words,
    and the whitespace between them isn't part of the text."""
    if not value:
        return ""
    try:
        text = str(make_header(decode_header(value)))
    except (HeaderParseError, LookupError, UnicodeError, ValueError):
        return value
    return "".join(ch for ch in text if ch.isprintable())


def https_url(value: str | None) -> str | None:
    return value if value and value.startswith("https://") and len(value) < 2048 else None


def host_name(value: str | None) -> str:
    """The name in a Host header, without the port."""
    value = (value or "").strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end > 0 else ""
    if value.count(":") == 1:
        value = value.split(":", 1)[0]
    return value.rstrip(".")


def allowed_host(value: str | None, config: Config) -> bool:
    """Whether a request's Host is a name for this server. A web page can
    point its own domain at a tailnet or loopback address (DNS rebinding);
    its requests then carry that domain as Host and are refused here."""
    name = host_name(value)
    if not name:
        return False
    if name in config.allowed_hosts or name == "localhost":
        return True
    ip = _addr(name)
    if ip is not None:
        return ip.is_loopback or (config.auth != "dev" and is_tailnet_address(name))
    return config.auth != "dev" and name.endswith(".ts.net")


def peer(request) -> tuple[str | None, int | None]:
    info = request.transport.get_extra_info("peername") if request.transport else None
    if not info:
        return None, None
    return info[0], info[1]


class IdentityResolver:
    def __init__(self, config: Config):
        self.config = config

    async def identify(self, request) -> Identity:
        addr, port = peer(request)
        mode = self.config.auth
        if not allowed_host(request.headers.get("Host"), self.config):
            raise IdentityError(
                "Open Tailchat at its https://<machine>.<tailnet>.ts.net address "
                "(add other names to TAILCHAT_ALLOWED_HOSTS).",
                421,
            )
        if mode == "serve":
            if not is_loopback(addr):
                raise IdentityError("Tailchat only accepts connections through `tailscale serve`.")
            # Funnel would put Tailchat on the public internet. tailscaled
            # marks those requests and never sends an identity with them.
            if "Tailscale-Funnel-Request" in request.headers:
                raise IdentityError("Tailchat is only for your tailnet. Turn off Funnel for it.")
            login = decode_header_word(request.headers.get("Tailscale-User-Login"))
            if not login:
                raise IdentityError(
                    "No Tailscale identity on this request. Open Tailchat at its https://<machine>.<tailnet>.ts.net "
                    "address from a device signed in to your tailnet (tagged devices have no user identity).",
                    401,
                )
            login = login.lower()
            if not LOGIN.match(login):
                raise IdentityError("Unexpected Tailscale login name.", 400)
            return Identity(
                login=login,
                name=(decode_header_word(request.headers.get("Tailscale-User-Name")) or login.split("@")[0])[:60],
                avatar_url=https_url(request.headers.get("Tailscale-User-Profile-Pic")),
            )
        # dev
        if not is_loopback(addr):
            raise IdentityError("Dev mode only accepts loopback connections.")
        user = request.cookies.get("tailchat_dev_user") or request.headers.get("X-Dev-User")
        if not user or not DEV_USER.match(user):
            raise IdentityError("Dev mode: pick a user at /dev/login", 401)
        return Identity(login=f"{user}@dev", name=user[0].upper() + user[1:], avatar_url=None)
