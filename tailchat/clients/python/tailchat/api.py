"""REST client for a Tailchat server (PROTOCOL.md §1, §7)."""

from __future__ import annotations

import http.client
import json
import os
import ssl
from pathlib import Path
from typing import BinaryIO, Iterable, Iterator
from urllib.parse import quote, urlencode, urlsplit

from . import crypto
from .state import State
from .ws import WebSocket


class ApiError(Exception):
    def __init__(self, status: int, message: str, method: str = "", path: str = ""):
        super().__init__(f"{method} {path} -> {status} {message}".strip())
        self.status = status
        self.message = message


def normalize_server(server: str) -> str:
    server = server.strip().rstrip("/")
    if "://" not in server:
        server = "https://" + server
    parts = urlsplit(server)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"bad server address {server!r} (expected https://machine.tailnet.ts.net)")
    return f"{parts.scheme}://{parts.netloc}"


class Client:
    def __init__(self, server: str, token: str | None = None, dev_user: str | None = None,
                 timeout: float = 60, ssl_context: ssl.SSLContext | None = None):
        self.server = normalize_server(server)
        self.token = token
        self.dev_user = dev_user
        self.timeout = timeout
        parts = urlsplit(self.server)
        self._https = parts.scheme == "https"
        self._host = parts.hostname
        self._port = parts.port
        self._ssl = ssl_context or (ssl.create_default_context() if self._https else None)

    # ---------- transport ----------

    def _conn(self) -> http.client.HTTPConnection:
        if self._https:
            return http.client.HTTPSConnection(self._host, self._port, timeout=self.timeout, context=self._ssl)
        return http.client.HTTPConnection(self._host, self._port, timeout=self.timeout)

    def _headers(self, extra: dict | None = None) -> dict:
        h = {"Accept": "application/json", "User-Agent": "tailchat-python/0.1"}
        if self.dev_user:
            h["X-Dev-User"] = self.dev_user
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if extra:
            h.update(extra)
        return h

    def request(self, method: str, path: str, body=None, *, raw: bool = False):
        """JSON request. Returns parsed JSON (or an open response when raw=True)."""
        headers = self._headers()
        data = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn = self._conn()
        try:
            conn.request(method, path, body=data, headers=headers)
            res = conn.getresponse()
        except Exception:
            conn.close()
            raise
        if raw and 200 <= res.status < 300:
            res._tailchat_conn = conn  # keep the connection alive while streaming
            return res
        try:
            return self._finish(res, method, path)
        finally:
            conn.close()

    @staticmethod
    def _finish(res: http.client.HTTPResponse, method: str, path: str):
        payload = res.read()
        ctype = res.getheader("Content-Type") or ""
        value = None
        if "json" in ctype:
            try:
                value = json.loads(payload.decode("utf-8"))
            except ValueError:
                value = None
        if not 200 <= res.status < 300:
            msg = value.get("error") if isinstance(value, dict) else payload[:200].decode("utf-8", "replace")
            raise ApiError(res.status, msg or res.reason, method, path)
        return value if value is not None else payload

    def upload(self, chunks: Iterable[bytes], length: int, public: bool = False) -> dict:
        path = "/api/files" + ("?public=1" if public else "")
        headers = self._headers({"Content-Type": "application/octet-stream", "Content-Length": str(length)})
        conn = self._conn()
        try:
            conn.putrequest("POST", path, skip_accept_encoding=True)
            for k, v in headers.items():
                conn.putheader(k, v)
            conn.endheaders()
            sent = 0
            for chunk in chunks:
                conn.send(chunk)
                sent += len(chunk)
            if sent != length:
                raise ValueError(f"upload produced {sent} bytes, expected {length}")
            return self._finish(conn.getresponse(), "POST", path)
        finally:
            conn.close()

    # ---------- endpoints ----------

    def register_device(self, name: str, public_jwk: dict) -> dict:
        return self.request("POST", "/api/devices", {"name": name, "publicKey": public_jwk})

    def me(self) -> dict:
        return self.request("GET", "/api/me")

    def users(self) -> list[dict]:
        return self.request("GET", "/api/users")["users"]

    def user_devices(self, user_id: str) -> list[dict]:
        return self.request("GET", f"/api/users/{quote(user_id, safe='')}/devices")["devices"]

    def keys(self, ids: list[str]) -> list[dict]:
        if not ids:
            return []
        return self.request("GET", "/api/keys?" + urlencode({"ids": ",".join(ids)}))["devices"]

    def chats(self) -> list[dict]:
        return self.request("GET", "/api/chats")["chats"]

    def chat(self, chat_id: str) -> dict:
        return self.request("GET", f"/api/chats/{quote(chat_id, safe='')}")["chat"]

    def direct_chat(self, user_id: str) -> dict:
        return self.request("POST", "/api/chats/direct", {"userId": user_id})["chat"]

    def chat_devices(self, chat_id: str) -> list[dict]:
        return self.request("GET", f"/api/chats/{quote(chat_id, safe='')}/devices")["devices"]

    def messages(self, chat_id: str, limit: int = 50, before: int | None = None, after: int | None = None) -> dict:
        q = {"limit": str(limit)}
        if before:
            q["before"] = str(before)
        if after:
            q["after"] = str(after)
        return self.request("GET", f"/api/chats/{quote(chat_id, safe='')}/messages?" + urlencode(q))

    def post_message(self, chat_id: str, message_id: str, payload: str, files: list[str] | None = None,
                     view_once: bool = False) -> dict:
        body = {"id": message_id, "payload": payload}
        if files:
            body["files"] = files
        if view_once:
            body["viewOnce"] = True
        return self.request("POST", f"/api/chats/{quote(chat_id, safe='')}/messages", body)["message"]

    def receipts(self, chat_id: str, delivered: int | None = None, read: int | None = None) -> None:
        body = {}
        if delivered:
            body["delivered"] = delivered
        if read:
            body["read"] = read
        self.request("POST", f"/api/chats/{quote(chat_id, safe='')}/receipts", body)

    def file_response(self, file_id: str) -> http.client.HTTPResponse:
        return self.request("GET", f"/api/files/{quote(file_id, safe='')}", raw=True)

    def websocket(self) -> WebSocket:
        scheme = "wss" if self._https else "ws"
        headers = {"User-Agent": "tailchat-python/0.1"}
        if self.dev_user:
            headers["X-Dev-User"] = self.dev_user
        ws = WebSocket(f"{scheme}://{urlsplit(self.server).netloc}/ws", headers=headers,
                       timeout=self.timeout, ssl_context=self._ssl)
        ws.send(json.dumps({"type": "auth", "token": self.token}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("type") == "ready":
                return ws


class Session:
    """A registered device: API client plus key ring, with the end-to-end operations."""

    def __init__(self, state: State, client: Client | None = None):
        self.state = state
        self.client = client or Client(state.server, state.token, state.dev_user)
        self.ring = crypto.KeyRing(state.device_id, crypto.private_key_from_pem(state.private_key_pem), self.client.keys)

    @property
    def device_id(self) -> str:
        return self.state.device_id

    @property
    def user_id(self) -> str:
        return self.state.user_id

    @classmethod
    def register(cls, server: str, name: str, dev_user: str | None = None) -> "Session":
        key = crypto.generate_private_key()
        client = Client(server, dev_user=dev_user)
        reg = client.register_device(name, crypto.public_jwk(key))
        client.token = reg["token"]
        state = State(
            server=client.server, device_id=reg["device"]["id"], token=reg["token"],
            user_id=reg["device"]["userId"], private_key_pem=crypto.private_key_to_pem(key),
            dev_user=dev_user, device_name=name,
        )
        return cls(state, client)

    # ---------- chats ----------

    def resolve_chat(self, target: str) -> dict:
        """A chat id, or a user id (opens/creates the direct chat). A bare name matches a user id's local part."""
        if "@" not in target:
            for c in self.client.chats():
                if c["id"] == target:
                    return c
            matches = [u for u in self.client.users() if u["id"].split("@")[0] == target.lower()]
            if len(matches) == 1:
                target = matches[0]["id"]
            elif len(matches) > 1:
                raise ApiError(400, f"{target!r} is ambiguous: " + ", ".join(u["id"] for u in matches))
            else:
                try:
                    return self.client.chat(target)
                except ApiError as err:
                    raise ApiError(404, f"no chat or user called {target!r}") from err
        return self.client.direct_chat(target)

    def send_content(self, chat_id: str, content: dict, files: list[str] | None = None) -> dict:
        message_id = crypto.new_message_id()
        devices = self.client.chat_devices(chat_id)
        payload = self.ring.seal(content, crypto.chat_aad(chat_id, message_id), devices)
        return self.client.post_message(chat_id, message_id, payload, files)

    def send_text(self, chat_id: str, text: str) -> dict:
        return self.send_content(chat_id, {"type": "text", "text": text})

    def upload_file(self, stream: BinaryIO, size: int) -> dict:
        enc = crypto.FileEncryptor(stream, size)
        up = self.client.upload(iter(enc), enc.encrypted_size)
        return {"id": up["id"], **enc.file}

    def send_file(self, chat_id: str, path: str | os.PathLike, caption: str | None = None,
                  kind: str | None = None, mime: str | None = None) -> dict:
        path = Path(path)
        mime = mime or guess_mime(path)
        size = path.stat().st_size
        with open(path, "rb") as f:
            file = self.upload_file(f, size)
        file.update({"name": path.name, "mime": mime})
        content = {"type": "media", "kind": kind or media_kind(mime), "file": file}
        if caption:
            content["caption"] = caption
        return self.send_content(chat_id, content, files=[file["id"]])

    def decrypt_message(self, message: dict) -> dict:
        """Returns the content of a message dict from the server.

        System messages come back as {"type": "system", ...event}; deleted ones as
        {"type": "deleted"}. Raises crypto.CryptoError when it can't be decrypted.
        """
        if message.get("kind") == "system":
            try:
                event = json.loads(message.get("payload") or "{}")
            except ValueError:
                event = {}
            return {"type": "system", **(event if isinstance(event, dict) else {})}
        if message.get("payload") is None:
            return {"type": "deleted" if message.get("deletedAt") else "unavailable"}
        return self.ring.open(message["payload"], crypto.chat_aad(message["chatId"], message["id"]))

    def history(self, chat_id: str, limit: int = 50, before: int | None = None) -> list[tuple[dict, dict | None, str | None]]:
        out = []
        for m in self.client.messages(chat_id, limit=limit, before=before)["messages"]:
            try:
                out.append((m, self.decrypt_message(m), None))
            except Exception as err:
                out.append((m, None, str(err)))
        return out

    def find_message(self, message_id: str, chat_id: str | None = None) -> dict:
        """The server has no GET /api/messages/:id, so page through chat history."""
        chats = [chat_id] if chat_id else [c["id"] for c in self.client.chats()]
        for cid in chats:
            before = None
            while True:
                page = self.client.messages(cid, limit=200, before=before)
                for m in page["messages"]:
                    if m["id"] == message_id:
                        return m
                if not page.get("hasMore") or not page["messages"]:
                    break
                before = page["messages"][0]["seq"]
        raise ApiError(404, f"no message {message_id} in your chats")

    def download_file(self, file: dict, dest: str | os.PathLike) -> Path:
        """Downloads and decrypts a §5 file to `dest` (a directory or a file path).

        The plaintext only appears at its final name after every chunk and the
        chunked sha256 have been verified.
        """
        dest = Path(dest)
        if dest.is_dir() or str(dest).endswith(os.sep):
            dest.mkdir(parents=True, exist_ok=True)
            dest = unique_path(dest / safe_name(file.get("name") or file["id"]))
        res = self.client.file_response(file["id"])
        tmp = dest.with_name(f".{dest.name}.part")
        try:
            length = res.getheader("Content-Length")
            if length is not None and int(length) != crypto.encrypted_size(int(file["size"])):
                raise crypto.CryptoError("Encrypted file has the wrong size")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as out:
                crypto.decrypt_stream(res.read, file, out.write)
            os.replace(tmp, dest)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        finally:
            res.close()
            conn = getattr(res, "_tailchat_conn", None)
            if conn is not None:
                conn.close()
        return dest

    def security_code(self, user_id: str) -> str:
        return crypto.security_code(self.client.user_devices(user_id))

    # ---------- realtime ----------

    def events(self) -> Iterator[dict]:
        ws = self.client.websocket()
        ws.settimeout(None)
        try:
            while True:
                yield json.loads(ws.recv())
        finally:
            ws.close()


def guess_mime(path: Path) -> str:
    import mimetypes
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def media_kind(mime: str) -> str:
    if mime == "image/gif":
        return "gif"
    for prefix in ("image", "video", "audio"):
        if mime.startswith(prefix + "/"):
            return prefix
    return "document"


def safe_name(name: str) -> str:
    """A sender-chosen file name, reduced to a plain base name."""
    name = name.replace("\\", "/").split("/")[-1].strip().replace("\x00", "")
    name = "".join(ch for ch in name if ch.isprintable())
    if name in ("", ".", "..") or name.startswith("."):
        name = "file" + (name if name not in ("", ".", "..") else "")
    return name[:200]


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for i in range(1, 10000):
        candidate = path.with_name(f"{stem} ({i}){suffix}")
        if not candidate.exists():
            return candidate
    raise FileExistsError(path)
