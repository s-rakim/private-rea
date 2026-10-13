"""WebSocket fan-out: pushes new messages, receipts, presence and typing to
every connected device, and relays call signalling between devices."""

from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable

from aiohttp import WSMsgType, web


class Socket:
    """One connected device. Outgoing frames go through a queue so events are
    delivered in order without the sender awaiting the network."""

    def __init__(self, ws: web.WebSocketResponse, user_id: str, device_id: str):
        self.ws = ws
        self.user_id = user_id
        self.device_id = device_id
        self.queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=5000)
        self.writer = asyncio.create_task(self._write())

    async def _write(self) -> None:
        while True:
            data = await self.queue.get()
            if data is None:
                return
            try:
                await self.ws.send_str(data)
            except (ConnectionError, RuntimeError):
                return

    def send(self, data: str) -> None:
        try:
            self.queue.put_nowait(data)
        except asyncio.QueueFull:
            # A client that stopped reading is dropped; it resyncs on reconnect.
            asyncio.create_task(self.ws.close(code=4008, message=b"too slow"))

    def stop(self) -> None:
        try:
            self.queue.put_nowait(None)
        except asyncio.QueueFull:
            self.writer.cancel()


class Hub:
    def __init__(self) -> None:
        self.by_user: dict[str, set[Socket]] = {}
        self.closed = False
        self.on_connect: Callable[[str], None] = lambda user_id: None
        self.on_disconnect: Callable[[str], None] = lambda user_id: None
        self.on_message: Callable[[Socket, dict], None] = lambda sock, msg: None
        self.on_socket_closed: Callable[[Socket], None] = lambda sock: None

    async def serve(self, request: web.Request, identity, authenticate: Callable[[str, object], Awaitable[dict]]):
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=256 * 1024)
        await ws.prepare(request)
        # The first frame must authenticate the device.
        try:
            first = await ws.receive(timeout=10)
            if first.type != WSMsgType.TEXT:
                raise ValueError("expected auth")
            msg = json.loads(first.data)
            if msg.get("type") != "auth":
                raise ValueError("expected auth")
            device = await authenticate(msg.get("token"), identity)
        except Exception:
            await ws.close(code=4003, message=b"auth failed")
            return ws

        sock = Socket(ws, device["user_id"], device["id"])
        sockets = self.by_user.setdefault(sock.user_id, set())
        first_socket = not sockets
        sockets.add(sock)
        sock.send(json.dumps({"type": "ready", "deviceId": sock.device_id}))
        if first_socket:
            self.on_connect(sock.user_id)
        try:
            async for frame in ws:
                if frame.type != WSMsgType.TEXT:
                    continue
                try:
                    msg = json.loads(frame.data)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                try:
                    self.on_message(sock, msg)
                except Exception as err:  # a bad frame must not kill the socket
                    sock.send(json.dumps({"type": "error", "message": str(err)}))
        finally:
            sockets.discard(sock)
            sock.stop()
            if not self.closed:
                self.on_socket_closed(sock)
                if not sockets:
                    self.on_disconnect(sock.user_id)
        return ws

    def is_online(self, user_id: str) -> bool:
        return bool(self.by_user.get(user_id))

    def send_to_user(self, user_id: str, event: dict, *, except_device: str | None = None, only_device: str | None = None) -> None:
        sockets = self.by_user.get(user_id)
        if not sockets:
            return
        data = json.dumps(event)
        for sock in list(sockets):
            if except_device and sock.device_id == except_device:
                continue
            if only_device and sock.device_id != only_device:
                continue
            sock.send(data)

    def send_to_users(self, user_ids, event: dict, **options) -> None:
        for user_id in dict.fromkeys(user_ids):
            self.send_to_user(user_id, event, **options)

    def revoke_device(self, device_id: str) -> None:
        for sockets in self.by_user.values():
            for sock in list(sockets):
                if sock.device_id == device_id:
                    asyncio.create_task(sock.ws.close(code=4003, message=b"device revoked"))

    async def close(self) -> None:
        self.closed = True
        for sockets in list(self.by_user.values()):
            for sock in list(sockets):
                await sock.ws.close(code=1001, message=b"server shutting down")
