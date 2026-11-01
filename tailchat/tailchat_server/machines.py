"""Your machines on the tailnet, as tailscaled knows them, so that each one
can be a chat: which machine a request comes from, and every machine that
belongs to the same Tailscale user.

Where the server asks (TAILCHAT_TAILNET):

  localapi - tailscaled's LocalAPI socket, read-only calls only. With Docker
             the tailscale container shares it (see docker-compose.yml).
  dev      - a file in the format of `tailscale status --json`
             (TAILCHAT_DEV_TAILNET), for dev mode only.
  off      - no machine list. Devices that have opened Tailchat still get
             their chats.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
import time
from datetime import datetime
from pathlib import Path

import aiohttp

from .config import Config
from .tailnet import _addr, is_tailnet_address

log = logging.getLogger("tailchat.machines")

STATUS_TTL = 10.0
WHOIS_TTL = 300.0
FAILED = object()
FRACTION = re.compile(r"\.(\d+)")


def short_name(fqdn: str | None, fallback: str | None = None) -> str:
    """holysukuns.tail1234.ts.net. -> holysukuns"""
    name = (fqdn or "").rstrip(".").split(".")[0] or (fallback or "")
    return "".join(ch for ch in name if ch.isprintable())[:80]


def epoch_ms(value) -> int | None:
    """Go's RFC 3339 time (nanoseconds, Z) in ms; None for Go's zero time."""
    if not isinstance(value, str) or value.startswith("0001-"):
        return None
    # Older Pythons only read 3 or 6 digits of fractional seconds.
    value = FRACTION.sub(lambda m: "." + (m.group(1) + "000000")[:6], value.replace("Z", "+00:00"), count=1)
    try:
        return int(datetime.fromisoformat(value).timestamp() * 1000)
    except ValueError:
        return None


class Tailnet:
    def __init__(self, config: Config):
        self.config = config
        self.source = config.tailnet
        self._status: tuple[float, object] = (0.0, FAILED)
        self._whois: dict[str, tuple[float, object]] = {}

    async def _localapi(self, path: str) -> dict:
        connector = aiohttp.UnixConnector(path=self.config.tailscale_socket)
        async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=3)) as session:
            async with session.get(
                f"http://local-tailscaled.sock/localapi/v0/{path}", headers={"Host": "local-tailscaled.sock"}
            ) as res:
                if res.status != 200:
                    raise RuntimeError(f"tailscaled answered {res.status}")
                return json.loads(await res.text())

    async def status(self) -> dict | None:
        """`tailscale status --json`, cached for a few seconds. None when
        tailscaled can't be asked."""
        at, cached = self._status
        if time.monotonic() - at < STATUS_TTL:
            return None if cached is FAILED else cached
        try:
            if self.source == "localapi":
                status = await self._localapi("status")
            elif self.source == "dev":
                status = json.loads(Path(self.config.dev_tailnet).read_text())
            else:
                return None
            if not isinstance(status, dict):
                raise ValueError("status is not an object")
        except Exception as err:  # socket missing, not signed in, bad JSON
            log.info("can't list tailnet machines: %s", err)
            status = FAILED
        self._status = (time.monotonic(), status)
        return None if status is FAILED else status

    async def whois(self, ip: str) -> dict | None:
        hit = self._whois.get(ip)
        if hit and time.monotonic() - hit[0] < WHOIS_TTL:
            return None if hit[1] is FAILED else hit[1]
        try:
            if self.source == "localapi":
                info = await self._localapi(f"whois?addr={ip}")
            else:
                return None
            if not isinstance(info, dict):
                raise ValueError("whois is not an object")
        except Exception as err:
            log.info("can't look up %s: %s", ip, err)
            info = FAILED
        self._whois[ip] = (time.monotonic(), info)
        return None if info is FAILED else info

    async def machine_of(self, request, login: str) -> dict | None:
        """The machine of yours a request comes from, or None."""
        if self.source == "off":
            return None
        if self.config.auth == "dev":
            name = (request.cookies.get("tailchat_dev_machine") or request.headers.get("X-Dev-Machine") or "").lower()
            if not name:
                return None
            return next((m for m in await self.machines_of(login, include_self=True) or [] if m["name"] == name), None)
        # tailscale serve puts the visiting device's tailnet address here,
        # replacing whatever the browser sent. Only tailscaled reaches us.
        raw = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if not is_tailnet_address(raw):
            return None
        ip = str(_addr(raw))
        ipaddress.ip_address(ip)  # only ever a plain address reaches whois
        info = await self.whois(ip)
        if not info:
            return None
        node = info.get("Node") or {}
        profile = info.get("UserProfile") or {}
        owner = profile.get("LoginName")
        if node.get("Tags") or not isinstance(owner, str) or owner.lower() != login:
            return None
        stable = node.get("StableID")
        if not isinstance(stable, str) or not stable:
            return None
        hostinfo = node.get("Hostinfo") or {}
        return {
            "id": stable,
            "name": short_name(node.get("Name"), hostinfo.get("Hostname")),
            "os": hostinfo.get("OS") if isinstance(hostinfo.get("OS"), str) else None,
        }

    async def machines_of(self, login: str, *, include_self: bool | None = None) -> list[dict] | None:
        """Every machine that belongs to this Tailscale login, or None when
        the tailnet can't be asked. The server's own machine is left out
        unless it is one you use (see TAILCHAT_LIST_SELF)."""
        status = await self.status()
        if status is None:
            return None
        users = status.get("User") or {}
        nodes = [(n, False) for n in (status.get("Peer") or {}).values() if isinstance(n, dict)]
        me = status.get("Self")
        if isinstance(me, dict) and (self.config.list_self if include_self is None else include_self):
            nodes.append((me, True))
        found = []
        for node, is_self in nodes:
            if node.get("Tags"):
                continue
            owner = (users.get(str(node.get("UserID"))) or {}).get("LoginName")
            stable = node.get("ID")
            if not isinstance(owner, str) or owner.lower() != login or not isinstance(stable, str) or not stable:
                continue
            found.append({
                "id": stable,
                "name": short_name(node.get("DNSName"), node.get("HostName")),
                "os": node.get("OS") if isinstance(node.get("OS"), str) else None,
                "online": True if is_self else bool(node.get("Online")),
                "lastSeen": None if is_self else epoch_ms(node.get("LastSeen")),
            })
        return sorted(found, key=lambda m: m["name"].lower())
