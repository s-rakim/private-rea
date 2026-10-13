"""Who is on the other end of a connection. Tailchat has no passwords: the
tailnet already knows who every device belongs to, so identity comes from
Tailscale.

  serve  - run behind `tailscale serve`. tailscaled terminates HTTPS with the
           machine's ts.net certificate and adds Tailscale-User-* headers.
           Only connections from loopback (tailscaled itself) are accepted.
  direct - listen on the Tailscale IP and ask the local tailscaled who owns
           the connecting address (LocalAPI whois).
  dev    - local testing only: pick a user at /dev/login. Loopback only.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import re
import time
from dataclasses import dataclass
from urllib.parse import quote

import aiohttp

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


_WORD = re.compile(r"=\?utf-8\?([qb])\?([^?]*)\?=", re.IGNORECASE)


def decode_header_word(value: str | None) -> str:
    """Tailscale-User-Name is RFC 2047 encoded when it is not plain ASCII."""
    if not value:
        return ""

    def repl(m: re.Match) -> str:
        enc, text = m.group(1).lower(), m.group(2)
        if enc == "b":
            return base64.b64decode(text + "=" * (-len(text) % 4)).decode("utf-8", "replace")
        raw = re.sub(r"=([0-9a-fA-F]{2})", lambda h: chr(int(h.group(1), 16)), text.replace("_", " "))
        return raw.encode("latin-1").decode("utf-8", "replace")

    return _WORD.sub(repl, value)


def peer(request) -> tuple[str | None, int | None]:
    info = request.transport.get_extra_info("peername") if request.transport else None
    if not info:
        return None, None
    return info[0], info[1]


class IdentityResolver:
    def __init__(self, config: Config):
        self.config = config
        self._whois_cache: dict[str, tuple[float, dict]] = {}

    async def _whois(self, addr: str, port: int) -> dict:
        host = f"[{addr}]" if ":" in addr else addr
        key = f"{host}:{port}"
        hit = self._whois_cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        connector = aiohttp.UnixConnector(path=self.config.tailscale_socket)
        try:
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=3)) as session:
                async with session.get(
                    f"http://local-tailscaled.sock/localapi/v0/whois?addr={quote(key)}",
                    headers={"Host": "local-tailscaled.sock"},
                ) as res:
                    if res.status != 200:
                        raise IdentityError(f"tailscaled whois failed ({res.status})")
                    info = json.loads(await res.text())
        except IdentityError:
            raise
        except Exception as err:  # socket missing, timeout, bad JSON
            raise IdentityError(f"cannot reach tailscaled: {err}", 503) from err
        self._whois_cache[key] = (time.monotonic() + 60, info)
        return info

    async def identify(self, request) -> Identity:
        addr, port = peer(request)
        mode = self.config.auth
        if mode == "serve":
            if not is_loopback(addr):
                raise IdentityError("Tailchat only accepts connections through `tailscale serve`.")
            login = request.headers.get("Tailscale-User-Login")
            if not login:
                raise IdentityError(
                    "No Tailscale identity on this request. Open Tailchat at its https://<machine>.<tailnet>.ts.net "
                    "address from a device signed in to your tailnet (tagged devices have no user identity).",
                    401,
                )
            login = login.lower()
            return Identity(
                login=login,
                name=decode_header_word(request.headers.get("Tailscale-User-Name")) or login.split("@")[0],
                avatar_url=request.headers.get("Tailscale-User-Profile-Pic") or None,
            )
        if mode == "direct":
            if not is_tailnet_address(addr):
                raise IdentityError("Tailchat only accepts connections from your tailnet.")
            info = await self._whois(str(_addr(addr)), port)
            profile = info.get("UserProfile") or {}
            node = info.get("Node") or {}
            login_name = profile.get("LoginName")
            if node.get("Tags") or not login_name or login_name == "tagged-devices":
                raise IdentityError("Tagged devices have no user identity, so they cannot use Tailchat.")
            return Identity(
                login=login_name.lower(),
                name=profile.get("DisplayName") or login_name.split("@")[0],
                avatar_url=profile.get("ProfilePicURL") or None,
            )
        # dev
        if not is_loopback(addr):
            raise IdentityError("Dev mode only accepts loopback connections.")
        user = request.cookies.get("tailchat_dev_user") or request.headers.get("X-Dev-User")
        if not user or not DEV_USER.match(user):
            raise IdentityError("Dev mode: pick a user at /dev/login", 401)
        return Identity(login=f"{user}@dev", name=user[0].upper() + user[1:], avatar_url=None)
