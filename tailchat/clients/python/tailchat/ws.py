"""A minimal RFC 6455 WebSocket client (text frames, ping/pong, close) on the stdlib."""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
from urllib.parse import urlsplit

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WebSocketError(Exception):
    pass


class WebSocketClosed(WebSocketError):
    def __init__(self, code: int | None, reason: str = ""):
        super().__init__(f"WebSocket closed ({code}{': ' + reason if reason else ''})")
        self.code = code
        self.reason = reason


class WebSocket:
    def __init__(self, url: str, headers: dict[str, str] | None = None, timeout: float | None = 30,
                 ssl_context: ssl.SSLContext | None = None, max_message: int = 64 * 1024 * 1024):
        parts = urlsplit(url)
        if parts.scheme not in ("ws", "wss"):
            raise WebSocketError(f"unsupported URL scheme {parts.scheme!r}")
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "wss" else 80)
        sock = socket.create_connection((host, port), timeout=timeout)
        if parts.scheme == "wss":
            sock = (ssl_context or ssl.create_default_context()).wrap_socket(sock, server_hostname=host)
        self.sock = sock
        self.max_message = max_message
        self._buf = b""
        self.closed = False
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = host if parts.port is None else f"{host}:{port}"
        if ":" in host and not host.startswith("["):
            host_header = f"[{host}]" + ("" if parts.port is None else f":{port}")
        lines = [
            f"GET {parts.path or '/'}{'?' + parts.query if parts.query else ''} HTTP/1.1",
            f"Host: {host_header}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        for k, v in (headers or {}).items():
            lines.append(f"{k}: {v}")
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        head = self._read_until(b"\r\n\r\n", limit=16384).decode("latin-1")
        status, *header_lines = head.split("\r\n")
        bits = status.split(" ", 2)
        if len(bits) < 2 or bits[1] != "101":
            self.sock.close()
            raise WebSocketError(f"WebSocket upgrade refused: {status.strip()}")
        got = {}
        for line in header_lines:
            if ":" in line:
                k, v = line.split(":", 1)
                got[k.strip().lower()] = v.strip()
        expect = base64.b64encode(hashlib.sha1(key.encode("ascii") + GUID).digest()).decode("ascii")
        if got.get("sec-websocket-accept") != expect:
            self.sock.close()
            raise WebSocketError("bad Sec-WebSocket-Accept from server")

    # ---------- low level ----------

    def _read_until(self, marker: bytes, limit: int) -> bytes:
        while marker not in self._buf:
            if len(self._buf) > limit:
                raise WebSocketError("handshake response too long")
            data = self.sock.recv(4096)
            if not data:
                raise WebSocketError("connection closed during handshake")
            self._buf += data
        head, self._buf = self._buf.split(marker, 1)
        return head

    def _read_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            data = self.sock.recv(max(65536, n - len(self._buf)))
            if not data:
                self.closed = True
                raise WebSocketClosed(1006, "connection lost")
            self._buf += data
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        # XOR with the repeating mask via big-int arithmetic (fast enough without numpy).
        if payload:
            m = (mask * (n // 4 + 1))[:n]
            masked = (int.from_bytes(payload, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")
        else:
            masked = b""
        self.sock.sendall(header + mask + masked)

    def _read_frame(self) -> tuple[bool, int, bytes]:
        b0, b1 = self._read_exact(2)
        fin, opcode = bool(b0 & 0x80), b0 & 0x0F
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack("!H", self._read_exact(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", self._read_exact(8))[0]
        if n > self.max_message:
            raise WebSocketError("frame too large")
        mask = self._read_exact(4) if b1 & 0x80 else None
        payload = self._read_exact(n)
        if mask:
            m = (mask * (n // 4 + 1))[:n]
            payload = (int.from_bytes(payload, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")
        return fin, opcode, payload

    # ---------- API ----------

    def send(self, text: str) -> None:
        self._send_frame(OP_TEXT, text.encode("utf-8"))

    def recv(self) -> str:
        """Returns the next text message. Answers pings; raises WebSocketClosed on close."""
        message, msg_op = b"", None
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                reason = payload[2:].decode("utf-8", "replace")
                if not self.closed:
                    try:
                        self._send_frame(OP_CLOSE, payload[:2])
                    except OSError:
                        pass
                self.closed = True
                self.sock.close()
                raise WebSocketClosed(code, reason)
            if opcode in (OP_TEXT, OP_BINARY):
                message, msg_op = payload, opcode
            elif opcode == OP_CONT and msg_op is not None:
                message += payload
            else:
                raise WebSocketError(f"unexpected opcode {opcode}")
            if len(message) > self.max_message:
                raise WebSocketError("message too large")
            if fin:
                return message.decode("utf-8") if msg_op == OP_TEXT else message.decode("utf-8", "replace")

    def settimeout(self, timeout: float | None) -> None:
        self.sock.settimeout(timeout)

    def close(self, code: int = 1000) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self._send_frame(OP_CLOSE, struct.pack("!H", code))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass
