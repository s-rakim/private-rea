"""Small HTTP helpers: a path router, JSON bodies, typed errors and validation."""

from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from aiohttp import web


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def fail(status: int, message: str):
    raise HttpError(status, message)


def new_id(nbytes: int = 16) -> str:
    return secrets.token_urlsafe(nbytes)


def json_response(value: Any, status: int = 200) -> web.Response:
    return web.Response(
        status=status,
        text=json.dumps(value, ensure_ascii=False),
        content_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


async def read_json(request: web.Request, limit: int = 1024 * 1024) -> dict:
    # Requiring application/json means a cross-site form post can never reach
    # the API: browsers preflight it, and the server answers no preflights.
    if not request.headers.get("Content-Type", "").startswith("application/json"):
        fail(415, "Expected application/json")
    if request.content_length is not None and request.content_length > limit:
        fail(413, "Request body too large")
    raw = bytearray()
    async for chunk in request.content.iter_chunked(65536):
        raw += chunk
        if len(raw) > limit:
            fail(413, "Request body too large")
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        fail(400, "Malformed JSON")
    if not isinstance(value, dict):
        fail(400, "Expected a JSON object")
    return value


Handler = Callable[["Context"], Awaitable[Any]]


@dataclass
class Route:
    method: str
    regex: re.Pattern
    keys: list[str]
    handler: Handler
    device: Any = True  # True: token required, "optional", False: identity only


@dataclass
class Context:
    request: web.Request
    params: dict
    identity: Any
    user: dict
    device: dict | None = None
    extra: dict = field(default_factory=dict)

    @property
    def query(self):
        return self.request.query


class Router:
    def __init__(self) -> None:
        self.routes: list[Route] = []

    def add(self, method: str, pattern: str, device: Any = True):
        keys: list[str] = []

        def group(m: re.Match) -> str:
            keys.append(m.group(1))
            return "([^/]+)"

        regex = re.compile("^" + re.sub(r":([a-zA-Z]+)", group, pattern) + "$")

        def decorator(fn: Handler) -> Handler:
            self.routes.append(Route(method, regex, keys, fn, device))
            return fn

        return decorator

    def match(self, method: str, path: str):
        path_matched = False
        for route in self.routes:
            m = route.regex.match(path)
            if not m:
                continue
            path_matched = True
            if route.method != method:
                continue
            return route, dict(zip(route.keys, m.groups()))
        return ("method", None) if path_matched else (None, None)


# ---- validation ----

def v_str(value, name: str, *, max: int = 200, min: int = 0, optional: bool = False):
    if value is None:
        if optional:
            return None
        fail(400, f"{name} is required")
    if not isinstance(value, str):
        fail(400, f"{name} must be a string")
    value = value.strip()
    if len(value) < min:
        fail(400, f"{name} is too short")
    if len(value) > max:
        fail(400, f"{name} is too long (max {max})")
    return value


def v_int(value, name: str, *, min: int = 0, max: int = 2**53 - 1, optional: bool = False):
    if value is None:
        if optional:
            return None
        fail(400, f"{name} is required")
    if isinstance(value, bool) or not isinstance(value, int) or not min <= value <= max:
        fail(400, f"{name} must be an integer between {min} and {max}")
    return value


_MISSING = object()


def v_bool(value, name: str, *, optional: bool = True):
    if value is None or value is _MISSING:
        if optional:
            return None
        fail(400, f"{name} is required")
    if not isinstance(value, bool):
        fail(400, f"{name} must be true or false")
    return value
