"""Tailchat peer: text messages straight from one device to another over
Tailscale, with no server and no Docker.

Run it on every computer you want to chat from:  python tailchat_peer.py

  * It listens for messages on this device's Tailscale address (port 8766).
    Tailscale (WireGuard) encrypts everything between devices end to end and
    guarantees which device a packet came from, so the sender is the tailnet
    device that owns the connecting address. Nothing else is accepted.
  * Your chats are at http://127.0.0.1:8765 on this computer only, behind a
    random key in the link it opens for you.
  * A message to a device that is offline waits here and is sent once that
    device is back online and running Tailchat.

Only the Python standard library and the Tailscale app are needed.
"""

from __future__ import annotations

import http.client
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
UI_PORT = int(os.environ.get("TAILCHAT_PEER_UI_PORT", "8765"))
PEER_PORT = int(os.environ.get("TAILCHAT_PEER_PORT", "8766"))
DATA = Path(os.environ.get("TAILCHAT_PEER_DATA") or HERE / "data")
# Tests point this at a JSON file instead of running `tailscale status --json`.
STATUS_FILE = os.environ.get("TAILCHAT_PEER_STATUS_FILE")
MAX_TEXT = 10000
MAX_BODY = 64 * 1024
RETRY_S = 5

KNOWN_TAILSCALE = [
    r"C:\Program Files\Tailscale\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
]


def now_ms() -> int:
    return int(time.time() * 1000)


class Tailnet:
    """This device and the others on the tailnet, from `tailscale status`."""

    def __init__(self):
        self.lock = threading.Lock()
        self.me: dict = {}
        self.peers: dict[str, dict] = {}  # id (DNS name) -> peer
        self.by_ip: dict[str, str] = {}
        self.fetched = 0.0

    def _status(self) -> dict:
        if STATUS_FILE:
            return json.loads(Path(STATUS_FILE).read_text())
        cli = shutil.which("tailscale") or next((p for p in KNOWN_TAILSCALE if os.path.isfile(p)), None)
        if not cli:
            raise SystemExit("Can't find Tailscale. Install it from https://tailscale.com/download and sign in.")
        res = subprocess.run([cli, "status", "--json"], capture_output=True, text=True, timeout=15)
        try:
            return json.loads(res.stdout)
        except ValueError:
            raise RuntimeError(f"tailscale status failed: {(res.stderr or res.stdout).strip()}") from None

    def refresh(self, force: bool = False) -> None:
        with self.lock:
            if not force and time.monotonic() - self.fetched < 3:
                return
            status = self._status()
            if status.get("BackendState") != "Running":
                raise RuntimeError("Tailscale isn't connected. Open the Tailscale app and connect.")
            users = status.get("User") or {}

            def node(n: dict) -> dict:
                ips = [ip for ip in n.get("TailscaleIPs") or [] if "." in ip]
                user = users.get(str(n.get("UserID"))) or {}
                return {
                    "id": (n.get("DNSName") or n.get("HostName") or "").rstrip(".").lower(),
                    "name": n.get("HostName") or "",
                    "ip": ips[0] if ips else "",
                    "online": bool(n.get("Online", True)),
                    "os": n.get("OS") or "",
                    "user": user.get("LoginName") or "",
                }

            self.me = node(status.get("Self") or {})
            self.me["online"] = True
            self.peers = {}
            self.by_ip = {}
            for n in (status.get("Peer") or {}).values():
                p = node(n)
                if p["id"] and p["ip"]:
                    self.peers[p["id"]] = p
                    self.by_ip[p["ip"]] = p["id"]
            self.fetched = time.monotonic()

    def sender(self, ip: str) -> dict | None:
        self.refresh()
        if ip not in self.by_ip:
            self.refresh(force=True)
        pid = self.by_ip.get(ip)
        return self.peers.get(pid) if pid else None


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS messages (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 id TEXT NOT NULL UNIQUE,
                 peer TEXT NOT NULL,          -- the other device's DNS name
                 peer_name TEXT NOT NULL,
                 outgoing INTEGER NOT NULL,
                 text TEXT NOT NULL,
                 sent_at INTEGER NOT NULL,
                 status TEXT NOT NULL         -- waiting, sent, received
               )"""
        )
        self.db.commit()

    def add(self, msg: dict) -> bool:
        with self.lock:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO messages (id, peer, peer_name, outgoing, text, sent_at, status) VALUES (?,?,?,?,?,?,?)",
                (msg["id"], msg["peer"], msg["peer_name"], msg["outgoing"], msg["text"], msg["sent_at"], msg["status"]),
            )
            self.db.commit()
            return cur.rowcount == 1

    def since(self, seq: int) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT seq, id, peer, peer_name, outgoing, text, sent_at, status FROM messages WHERE seq > ? ORDER BY seq", (seq,)
            ).fetchall()
        keys = ["seq", "id", "peer", "peer_name", "outgoing", "text", "sent_at", "status"]
        return [dict(zip(keys, r)) for r in rows]

    def waiting(self) -> list[dict]:
        return [m for m in self.since(0) if m["status"] == "waiting"]

    def mark_sent(self, mid: str) -> None:
        with self.lock:
            # A new seq makes the change show up for the page's next poll.
            row = self.db.execute("SELECT id, peer, peer_name, outgoing, text, sent_at FROM messages WHERE id = ?", (mid,)).fetchone()
            self.db.execute("DELETE FROM messages WHERE id = ?", (mid,))
            self.db.execute(
                "INSERT INTO messages (id, peer, peer_name, outgoing, text, sent_at, status) VALUES (?,?,?,?,?,?, 'sent')", row
            )
            self.db.commit()


def load_key() -> str:
    path = DATA / "ui-key"
    if path.is_file():
        return path.read_text().strip()
    DATA.mkdir(parents=True, exist_ok=True)
    key = secrets.token_urlsafe(24)
    path.write_text(key)
    return key


class Peer:
    def __init__(self):
        os.umask(0o077)
        self.tailnet = Tailnet()
        self.store = Store(DATA / "messages.db")
        self.key = load_key()
        self.wake = threading.Event()

    # Sending -----------------------------------------------------------
    def deliver(self, msg: dict) -> bool:
        peer = self.tailnet.peers.get(msg["peer"])
        if not peer or not peer["online"]:
            return False
        body = json.dumps({"id": msg["id"], "text": msg["text"], "sent_at": msg["sent_at"]}).encode()
        # Plain HTTP is fine here: it only travels inside Tailscale's encrypted
        # tunnel, from this device's Tailscale address to the other one's.
        conn = http.client.HTTPConnection(peer["ip"], PEER_PORT, timeout=10, source_address=(self.tailnet.me["ip"], 0))
        try:
            conn.request("POST", "/inbox", body, {"Content-Type": "application/json"})
            return conn.getresponse().status == 200
        except Exception:
            return False
        finally:
            conn.close()

    def outbox_loop(self) -> None:
        while True:
            self.wake.wait(RETRY_S)
            self.wake.clear()
            try:
                self.tailnet.refresh()
                for msg in self.store.waiting():
                    if self.deliver(msg):
                        self.store.mark_sent(msg["id"])
            except Exception as err:
                print(f"tailchat: {err}", file=sys.stderr)

    # Receiving ---------------------------------------------------------
    def receive(self, ip: str, raw: bytes) -> int:
        try:
            sender = self.tailnet.sender(ip)
        except Exception:
            return 503
        if not sender:
            return 403
        try:
            data = json.loads(raw)
            mid, text, sent_at = data["id"], data["text"], int(data["sent_at"])
            uuid.UUID(mid)
        except (ValueError, KeyError, TypeError):
            return 400
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            return 400
        self.store.add(
            {
                "id": mid,
                "peer": sender["id"],
                "peer_name": sender["name"],
                "outgoing": 0,
                "text": text,
                "sent_at": sent_at,
                "status": "received",
            }
        )
        return 200

    # Local page --------------------------------------------------------
    def state(self, since: int) -> dict:
        self.tailnet.refresh()
        return {
            "me": self.tailnet.me,
            "peers": sorted(self.tailnet.peers.values(), key=lambda p: (not p["online"], p["name"].lower())),
            "messages": self.store.since(since),
        }

    def send(self, peer_id: str, text: str) -> dict:
        self.tailnet.refresh()
        peer = self.tailnet.peers.get(peer_id)
        if not peer:
            raise ValueError("No such device on your tailnet")
        if not text.strip() or len(text) > MAX_TEXT:
            raise ValueError("Message is empty or too long")
        msg = {
            "id": str(uuid.uuid4()),
            "peer": peer_id,
            "peer_name": peer["name"],
            "outgoing": 1,
            "text": text,
            "sent_at": now_ms(),
            "status": "waiting",
        }
        self.store.add(msg)
        self.wake.set()
        return msg


def make_inbox_handler(app: Peer):
    class Inbox(BaseHTTPRequestHandler):
        server_version = "tailchat-peer"

        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if self.path != "/inbox" or length <= 0 or length > MAX_BODY:
                return self._send(400)
            self._send(app.receive(self.client_address[0], self.rfile.read(length)))

        def _send(self, status: int):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return Inbox


def make_ui_handler(app: Peer):
    page = (HERE / "index.html").read_bytes()
    hosts = {f"127.0.0.1:{UI_PORT}", f"localhost:{UI_PORT}"}

    class Ui(BaseHTTPRequestHandler):
        server_version = "tailchat-peer"

        def log_message(self, *args):
            pass

        def _ok(self) -> bool:
            # Another web page can't point its own name here (DNS rebinding),
            # and can't add the key header without the key.
            if self.headers.get("Host") not in hosts:
                self._send(421, b"Open the link Tailchat printed.")
                return False
            return True

        def _api_ok(self) -> bool:
            if not self._ok():
                return False
            if not secrets.compare_digest(self.headers.get("X-Key", ""), app.key):
                self._send(403, b'{"error":"Open the link Tailchat printed"}', "application/json")
                return False
            return True

        def do_GET(self):
            if not self._ok():
                return
            if self.path == "/" or self.path.startswith("/?"):
                return self._send(200, page, "text/html; charset=utf-8")
            if self.path.startswith("/api/state") and self._api_ok():
                try:
                    since = int(self.path.partition("since=")[2] or 0)
                    self._json(200, app.state(since))
                except Exception as err:
                    self._json(503, {"error": str(err)})
                return
            if not self.path.startswith("/api/"):
                self._send(404, b"")

        def do_POST(self):
            if self.path != "/api/send" or not self._api_ok():
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self._json(400, {"error": "Bad request"})
            try:
                data = json.loads(self.rfile.read(length))
                self._json(200, app.send(str(data["peer"]), str(data["text"])))
            except (ValueError, KeyError, TypeError) as err:
                self._json(400, {"error": str(err)})

        def _json(self, status: int, obj) -> None:
            self._send(status, json.dumps(obj).encode(), "application/json")

        def _send(self, status: int, body: bytes, ctype: str = "text/plain") -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

    return Ui


def main() -> None:
    app = Peer()
    try:
        app.tailnet.refresh(force=True)
    except Exception as err:
        sys.exit(f"tailchat: {err}")
    me = app.tailnet.me
    if not me.get("ip"):
        sys.exit("tailchat: this device has no Tailscale address yet. Connect Tailscale and try again.")
    try:
        inbox = ThreadingHTTPServer((me["ip"], PEER_PORT), make_inbox_handler(app))
        ui = ThreadingHTTPServer(("127.0.0.1", UI_PORT), make_ui_handler(app))
    except OSError as err:
        sys.exit(f"tailchat: can't listen ({err}). Is Tailchat already running?")
    threading.Thread(target=inbox.serve_forever, daemon=True).start()
    threading.Thread(target=app.outbox_loop, daemon=True).start()
    link = f"http://127.0.0.1:{UI_PORT}/?key={app.key}"
    print(f"Tailchat is running on {me['name']} ({me['ip']}).", flush=True)
    print(f"Your chats: {link}", flush=True)
    print("Keep this window open to send and receive. Press Ctrl+C to stop.", flush=True)
    if not os.environ.get("TAILCHAT_PEER_NO_BROWSER"):
        webbrowser.open(link)
    try:
        ui.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
