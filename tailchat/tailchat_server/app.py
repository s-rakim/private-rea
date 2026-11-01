"""HTTP(S) server: static web app, REST API and the WebSocket endpoint."""

from __future__ import annotations

import asyncio
import logging
import re
import ssl
from urllib.parse import urlsplit

from aiohttp import web

from .api import Api
from .config import Config
from .db import Database
from .hub import Hub
from .httputil import Context, HttpError, json_response
from .tailnet import DEV_USER, IdentityError, IdentityResolver

log = logging.getLogger("tailchat")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}

SECURITY_HEADERS = {
    "Content-Security-Policy": "; ".join(
        [
            "default-src 'self'",
            "img-src 'self' blob: data: https:",
            "media-src 'self' blob:",
            "script-src 'self'",
            "style-src 'self'",
            "connect-src 'self'",
            "worker-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ]
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self), display-capture=(self)",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000",
}

DEV_LOGIN_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Tailchat dev login</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px">
<h1>Tailchat (dev mode)</h1><p>In production your identity comes from Tailscale. Pick a test user:</p>
<form><input name="user" placeholder="alice" pattern="[a-z0-9._-]{1,32}" required autofocus>
<input name="machine" placeholder="machine (optional)" pattern="[a-z0-9._-]{1,32}"> <button>Sign in</button></form>"""


def error_response(err: Exception) -> web.Response:
    status = getattr(err, "status", 500)
    if status == 500:
        log.exception("request failed", exc_info=err)
    return json_response({"error": "Internal error" if status == 500 else str(err)}, status)


def cross_origin(request: web.Request) -> bool:
    # Browsers send Origin with every WebSocket upgrade and every non-GET
    # fetch; it must be this site. Other clients send none.
    origin = request.headers.get("Origin")
    return origin is not None and urlsplit(origin).netloc != request.host


HOSTNAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$")


def calls_origin(request: web.Request, port: int) -> str | None:
    """The call service's origin: the same host Tailchat was reached on, on
    the calls port."""
    if not port:
        return None
    host = (urlsplit(f"//{request.host}").hostname or "").lower().rstrip(".")
    return f"https://{host}:{port}" if HOSTNAME.match(host) else None


def create_app(config: Config) -> web.Application:
    db = Database(config.data_dir)
    hub = Hub()
    api = Api(db, hub, config)
    resolver = IdentityResolver(config)
    public_dir = config.public_dir.resolve()
    # tailscale serve adds the secret in front of every path (see config.py).
    prefix = f"/{config.serve_secret}" if config.serve_secret else ""

    def local_path(request: web.Request) -> str:
        return request.path[len(prefix) :]

    async def handle_api(request: web.Request) -> web.StreamResponse:
        try:
            route, params = api.router.match(request.method, local_path(request))
            if route is None:
                return json_response({"error": "Not found"}, 404)
            if route == "method":
                return json_response({"error": "Method not allowed"}, 405)
            if request.method not in ("GET", "HEAD") and cross_origin(request):
                raise HttpError(403, "Cross-origin request refused")
            identity = await resolver.identify(request)
            user = api.upsert_user(identity)
            ctx = Context(request=request, params=params, identity=identity, user=user)
            auth = request.headers.get("Authorization", "")
            if route.device is not False and auth.startswith("Bearer "):
                ctx.device = await api.authenticate_token(auth[7:], identity)
                await api.find_machine(ctx)
            elif route.device is True:
                raise HttpError(401, "Missing device token")
            result = await route.handler(ctx)
            if isinstance(result, web.StreamResponse):
                return result
            return json_response(result if result is not None else {"ok": True})
        except (HttpError, IdentityError) as err:
            return error_response(err)
        except Exception as err:  # never leak internals to the client
            return error_response(err)

    async def handle_ws(request: web.Request) -> web.StreamResponse:
        try:
            if cross_origin(request):
                raise HttpError(403, "Cross-origin WebSocket refused")
            identity = await resolver.identify(request)
            api.upsert_user(identity)
        except (HttpError, IdentityError) as err:
            return error_response(err)
        return await hub.serve(request, identity, api.authenticate_token)

    async def dev_login(request: web.Request) -> web.StreamResponse:
        user = request.query.get("user", "").lower()
        if DEV_USER.match(user):
            res = web.HTTPFound("/")
            res.set_cookie("tailchat_dev_user", user, path="/", httponly=True, samesite="Strict")
            # Which machine of the dev tailnet (TAILCHAT_DEV_TAILNET) this
            # browser plays, so each can be a chat.
            machine = request.query.get("machine", "").lower()
            if DEV_USER.match(machine):
                res.set_cookie("tailchat_dev_machine", machine, path="/", httponly=True, samesite="Strict")
            else:
                res.del_cookie("tailchat_dev_machine", path="/")
            return res
        return web.Response(
            text=DEV_LOGIN_PAGE,
            content_type="text/html",
            headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"},
        )

    async def handle_static(request: web.Request) -> web.StreamResponse:
        path = local_path(request)
        try:
            # The app shell is only served to people on the tailnet, too.
            if path == "/" or path.startswith("/invite/"):
                try:
                    await resolver.identify(request)
                except IdentityError as err:
                    if config.auth == "dev" and err.status == 401:
                        raise web.HTTPFound("/dev/login") from None
                    return error_response(err)
                path = "/index.html"
            file = (public_dir / path.lstrip("/")).resolve()
            if public_dir not in file.parents or not file.is_file():
                return json_response({"error": "Not found"}, 404)
            return web.FileResponse(
                file,
                headers={
                    "Content-Type": MIME.get(file.suffix, "application/octet-stream"),
                    "Cache-Control": "no-cache",
                },
            )
        except web.HTTPException:
            raise
        except Exception as err:
            return error_response(err)

    async def sweeper(app: web.Application):
        async def loop() -> None:
            while True:
                await asyncio.sleep(config.sweep_interval_s)
                try:
                    api.sweep()
                except Exception:
                    log.exception("sweep failed")

        task = asyncio.create_task(loop())
        yield
        task.cancel()
        await hub.close()
        db.close()

    async def security_headers(request: web.Request, response: web.StreamResponse) -> None:
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        # The call screen embeds the call room, served on another port of
        # this host, so another origin: it can't read Tailchat's keys, and
        # only it may be framed and use the camera and microphone.
        origin = calls_origin(request, config.calls_port)
        if origin and response.headers.get("Content-Security-Policy") == SECURITY_HEADERS["Content-Security-Policy"]:
            response.headers["Content-Security-Policy"] += f"; frame-src {origin}"
            response.headers["Permissions-Policy"] = (
                f'camera=(self "{origin}"), microphone=(self "{origin}"), geolocation=(self), '
                f'display-capture=(self "{origin}"), fullscreen=(self "{origin}")'
            )

    app = web.Application(client_max_size=1024**2)
    app.on_response_prepare.append(security_headers)
    app["api"] = api
    app.router.add_route("*", prefix + "/api/{tail:.*}", handle_api)
    app.router.add_get(prefix + "/ws", handle_ws)
    if config.auth == "dev":
        app.router.add_get("/dev/login", dev_login)
    app.router.add_route("GET", prefix + "/{tail:.*}", handle_static)
    app.cleanup_ctx.append(sweeper)
    return app


def ssl_context(config: Config) -> ssl.SSLContext | None:
    if not config.tls_cert:
        return None
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(config.tls_cert, config.tls_key)
    return ctx
