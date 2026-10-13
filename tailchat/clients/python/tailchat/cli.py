"""Command line interface: python -m tailchat [options] COMMAND ..."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
from datetime import datetime
from pathlib import Path

from . import __version__, crypto
from .api import ApiError, Client, Session, normalize_server
from .state import State, default_state_path
from .ws import WebSocketClosed, WebSocketError


class CliError(Exception):
    pass


# ---------- session setup ----------

def open_session(args, *, register_only: bool = False) -> Session:
    path = Path(args.state).expanduser() if args.state else default_state_path()
    server = normalize_server(args.server) if args.server else None
    if path.exists():
        if register_only and not args.force:
            raise CliError(f"{path} already holds a registered device; use --force to replace it or --state for another one")
        if not register_only:
            state = State.load(path)
            if server and server != state.server:
                raise CliError(f"{path} belongs to {state.server}, not {server}; use --state to keep a second device")
            if args.dev_user and args.dev_user != state.dev_user:
                raise CliError(f"{path} belongs to dev user {state.dev_user!r}; use --state to keep a second device")
            return Session(state)
    if not server:
        raise CliError(f"no device registered yet ({path}); pass --server https://machine.tailnet.ts.net")
    name = args.name or f"tailchat-python on {socket.gethostname()}"
    session = Session.register(server, name, dev_user=args.dev_user)
    session.state.save(path)
    print(f"Registered device {session.device_id} for {session.user_id} (state: {path})", file=sys.stderr)
    return session


# ---------- formatting ----------

def fmt_time(ms: int | None) -> str:
    if not ms:
        return "?"
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")


def fmt_size(n: int) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def describe(content: dict | None, error: str | None = None) -> str:
    if error is not None:
        return f"(can't decrypt: {error})"
    t = content.get("type")
    if t == "text":
        s = content.get("text", "")
    elif t == "media":
        f = content.get("file") or {}
        s = f"[{content.get('kind', 'file')}] {f.get('name') or f.get('id')} ({fmt_size(int(f.get('size') or 0))})"
        if content.get("caption"):
            s += f" {content['caption']}"
    elif t == "location":
        s = f"[location] {content.get('name') or ''} {content.get('lat')},{content.get('lon')}".replace("  ", " ")
    elif t == "contact":
        s = f"[contact] {content.get('name')} <{content.get('userId')}>"
    elif t == "poll":
        s = f"[poll] {content.get('question')} " + " / ".join(map(str, content.get("options") or []))
    elif t == "call":
        s = f"[{'video ' if content.get('video') else ''}call] {content.get('duration', 0)}s"
    elif t == "system":
        users = ", ".join(content.get("users") or [])
        s = f"* {content.get('event', 'event')}" + (f" {users}" if users else "") + (f" {content['name']}" if content.get("name") else "")
    elif t == "deleted":
        s = "(deleted)"
    elif t == "unavailable":
        s = "(no longer available)"
    else:
        s = f"[{t}]"
    if content.get("forwarded"):
        s = "(forwarded) " + s
    if content.get("replyTo"):
        s = f"(reply to {content['replyTo'].get('senderId')}: {content['replyTo'].get('preview', '')!r}) " + s
    return s


def message_line(m: dict, content: dict | None, error: str | None, me: str, chat_label: str | None = None) -> str:
    who = "me" if m.get("senderId") == me else m.get("senderId")
    where = f"{chat_label} " if chat_label else ""
    edited = " (edited)" if m.get("editedAt") and m.get("payload") else ""
    return f"[{fmt_time(m.get('createdAt'))}] {where}#{m.get('seq')} {who}: {describe(content, error)}{edited}  ({m['id']})"


def message_json(m: dict, content: dict | None, error: str | None) -> dict:
    out = {k: m.get(k) for k in ("id", "chatId", "seq", "senderId", "senderDevice", "kind", "createdAt", "editedAt", "deletedAt")}
    out["content"] = content
    if error is not None:
        out["error"] = error
    return out


def chat_label(chat: dict, me: str) -> str:
    if chat.get("type") == "group":
        return chat.get("name") or chat["id"]
    others = [m["userId"] for m in chat.get("members", []) if m["userId"] != me]
    return others[0] if others else me


def emit(args, obj) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


# ---------- commands ----------

def cmd_register(args) -> int:
    session = open_session(args, register_only=True)
    if args.json:
        emit(args, {"userId": session.user_id, "deviceId": session.device_id, "server": session.state.server})
    else:
        print(f"{session.user_id} device {session.device_id} on {session.state.server}")
    return 0


def cmd_whoami(args) -> int:
    s = open_session(args)
    me = s.client.me()
    code = s.security_code(me["user"]["id"])
    if args.json:
        emit(args, {"user": me["user"], "device": me["device"], "server": s.state.server, "securityCode": code})
    else:
        u, d = me["user"], me["device"] or {}
        print(f"user:     {u['id']} ({u.get('name')})")
        print(f"device:   {d.get('id')} ({d.get('name')})")
        print(f"server:   {s.state.server} (auth: {me.get('authMode')})")
        print(f"security: {code}")
    return 0


def cmd_users(args) -> int:
    s = open_session(args)
    users = s.client.users()
    if args.json:
        emit(args, users)
        return 0
    for u in users:
        status = "online" if u.get("online") else (f"last seen {fmt_time(u['lastSeen'])}" if u.get("lastSeen") else "")
        flags = " (you)" if u["id"] == s.user_id else (" (blocked)" if u.get("blocked") else "")
        print(f"{u['id']:<32} {u.get('name') or '':<20} {status}{flags}")
    return 0


def cmd_chats(args) -> int:
    s = open_session(args)
    chats = s.client.chats()
    chats.sort(key=lambda c: (c.get("lastMessage") or {}).get("createdAt") or c.get("createdAt") or 0, reverse=True)
    out = []
    for c in chats:
        last = c.get("lastMessage")
        preview = None
        if last:
            try:
                preview = describe(s.decrypt_message(last))
            except Exception as err:
                preview = describe(None, str(err))
        if args.json:
            out.append({"id": c["id"], "type": c["type"], "label": chat_label(c, s.user_id), "unread": c.get("unread"),
                        "lastSeq": c.get("lastSeq"), "preview": preview})
        else:
            unread = f" [{c['unread']} unread]" if c.get("unread") else ""
            print(f"{c['id']}  {c['type']:<6} {chat_label(c, s.user_id)}{unread}")
            if preview:
                print(f"    {preview}")
    if args.json:
        emit(args, out)
    return 0


def cmd_send(args) -> int:
    s = open_session(args)
    chat = s.resolve_chat(args.target)
    text = args.text if args.text != "-" else sys.stdin.read()
    m = s.send_text(chat["id"], text)
    if args.json:
        emit(args, {"chatId": chat["id"], "message": message_json(m, {"type": "text", "text": text}, None)})
    else:
        print(f"sent {m['id']} to {chat_label(chat, s.user_id)} (chat {chat['id']}, #{m['seq']})")
    return 0


def cmd_send_file(args) -> int:
    s = open_session(args)
    path = Path(args.path)
    if not path.is_file():
        raise CliError(f"{path} is not a file")
    chat = s.resolve_chat(args.target)
    m = s.send_file(chat["id"], path, caption=args.caption, kind=args.kind, mime=args.mime)
    content = s.decrypt_message(m)
    if args.json:
        emit(args, {"chatId": chat["id"], "message": message_json(m, content, None)})
    else:
        print(f"sent {m['id']} to {chat_label(chat, s.user_id)}: {describe(content)}")
    return 0


def cmd_history(args) -> int:
    s = open_session(args)
    chat = s.resolve_chat(args.chat)
    rows = s.history(chat["id"], limit=args.limit, before=args.before)
    if args.json:
        emit(args, [message_json(m, c, e) for m, c, e in rows])
    else:
        for m, c, e in rows:
            print(message_line(m, c, e, s.user_id))
    if args.mark_read and rows:
        s.client.receipts(chat["id"], read=max(m["seq"] for m, _, _ in rows))
    return 0


def cmd_download(args) -> int:
    s = open_session(args)
    m = s.find_message(args.message_id, chat_id=s.resolve_chat(args.chat)["id"] if args.chat else None)
    content = s.decrypt_message(m)
    if content.get("type") != "media" or not isinstance(content.get("file"), dict):
        raise CliError(f"message {m['id']} has no attachment ({describe(content)})")
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    path = s.download_file(content["file"], outdir)
    if args.json:
        emit(args, {"path": str(path), "size": content["file"]["size"], "sha256": content["file"].get("sha256")})
    else:
        print(f"saved {path} ({fmt_size(int(content['file']['size']))}, checksum verified)")
    return 0


def cmd_code(args) -> int:
    s = open_session(args)
    target = args.user
    if "@" not in target:
        matches = [u["id"] for u in s.client.users() if u["id"].split("@")[0] == target.lower()]
        if len(matches) != 1:
            raise CliError(f"no single user matches {target!r}")
        target = matches[0]
    code = s.security_code(target)
    emit(args, {"userId": target, "securityCode": code}) if args.json else print(code)
    return 0


def cmd_listen(args) -> int:
    s = open_session(args)
    save_dir = Path(args.save_files) if args.save_files else None
    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)
    labels: dict[str, str] = {}
    last_seq: dict[str, int] = {}  # chat id -> highest seq seen, for catching up after a reconnect
    edits: dict[str, object] = {}
    count = 0
    backoff = 1.0

    def label(chat_id: str) -> str:
        if chat_id not in labels:
            try:
                labels[chat_id] = chat_label(s.client.chat(chat_id), s.user_id)
            except ApiError:
                labels[chat_id] = chat_id
        return labels[chat_id]

    def handle(m: dict, update: bool = False) -> bool:
        """Prints one message; returns True if it counts towards --count."""
        nonlocal count
        chat_id = m["chatId"]
        last_seq[chat_id] = max(last_seq.get(chat_id, 0), m.get("seq") or 0)
        if update:
            marker = (m.get("editedAt"), m.get("deletedAt"))
            if edits.get(m["id"]) == marker or not any(marker):
                edits[m["id"]] = marker
                return False  # a reaction, vote or star: nothing new to show
            edits[m["id"]] = marker
        else:
            edits[m["id"]] = (m.get("editedAt"), m.get("deletedAt"))
        if m.get("senderDevice") == s.device_id and not update:
            return False  # sent from this very device
        try:
            content, error = s.decrypt_message(m), None
        except Exception as err:
            content, error = None, str(err)
        saved = None
        if save_dir and content and content.get("type") == "media" and isinstance(content.get("file"), dict):
            try:
                saved = str(s.download_file(content["file"], save_dir))
            except Exception as err:  # keep listening
                print(f"could not save {content['file'].get('name')}: {err}", file=sys.stderr)
        if args.json:
            obj = message_json(m, content, error)
            obj["event"] = "update" if update else "message"
            if saved:
                obj["savedTo"] = saved
            emit(args, obj)
        else:
            prefix = "(update) " if update else ""
            print(prefix + message_line(m, content, error, s.user_id, label(chat_id)), flush=True)
            if saved:
                print(f"    saved to {saved}", flush=True)
        if not update and m.get("senderId") != s.user_id and m.get("kind") == "msg":
            try:
                s.client.receipts(chat_id, delivered=m["seq"])
            except ApiError as err:
                print(f"receipt failed: {err}", file=sys.stderr)
        if not update and m.get("kind") == "msg":
            count += 1
        return True

    def done() -> bool:
        return bool(args.count) and count >= args.count

    while True:
        try:
            ws = s.client.websocket()
        except (OSError, WebSocketError) as err:
            print(f"connect failed: {err}; retrying in {backoff:.0f}s", file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue
        ws.settimeout(None)
        backoff = 1.0
        if args.json:
            emit(args, {"event": "ready", "deviceId": s.device_id, "userId": s.user_id})
        else:
            print(f"listening as {s.user_id} (device {s.device_id}); Ctrl-C to stop", file=sys.stderr, flush=True)
        try:
            # Anything that arrived while we were disconnected.
            for chat_id, seq in list(last_seq.items()):
                for m in s.client.messages(chat_id, limit=200, after=seq)["messages"]:
                    handle(m)
                    if done():
                        return 0
            while not done():
                event = json.loads(ws.recv())
                kind = event.get("type")
                if kind == "message":
                    handle(event["message"])
                elif kind == "message-update":
                    handle(event["message"], update=True)
                elif kind == "message-gone" and args.json:
                    emit(args, {"event": "gone", "chatId": event.get("chatId"), "id": event.get("id")})
            return 0
        except WebSocketClosed as err:
            if err.code in (4001, 4003):
                raise CliError(f"server closed the connection: {err.reason or err.code} (device logged out?)")
            print(f"{err}; reconnecting", file=sys.stderr)
        except (OSError, WebSocketError) as err:
            print(f"connection lost ({err}); reconnecting", file=sys.stderr)
        finally:
            ws.close()
        time.sleep(backoff)


# ---------- argument parsing ----------

def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    S = argparse.SUPPRESS
    common.add_argument("--server", default=S, help="https://machine.tailnet.ts.net (needed the first time, to register)")
    common.add_argument("--state", default=S, help=f"device state file (default: $TAILCHAT_STATE or {default_state_path()})")
    common.add_argument("--dev-user", default=S, metavar="NAME", help="dev-mode servers only: send X-Dev-User: NAME")
    common.add_argument("--name", default=S, help="device name shown in linked devices (when registering)")
    common.add_argument("--json", action="store_true", default=S, help="machine-readable output")

    p = argparse.ArgumentParser(prog="tailchat", parents=[common],
                                description="End-to-end encrypted Tailchat client for your tailnet.")
    p.add_argument("--version", action="version", version=f"tailchat-python {__version__}")
    sub = p.add_subparsers(dest="command", required=True, metavar="COMMAND")

    def add(name, func, help):
        sp = sub.add_parser(name, parents=[common], help=help, description=help)
        sp.set_defaults(func=func)
        return sp

    sp = add("register", cmd_register, "register this device (an ECDH P-256 key pair) with the server")
    sp.add_argument("--force", action="store_true", help="replace an existing state file")
    add("whoami", cmd_whoami, "show your user, device and security code")
    add("users", cmd_users, "list people on the tailnet")
    add("chats", cmd_chats, "list your chats with decrypted previews")
    sp = add("send", cmd_send, "send a text message (to a chat id, or a user id to open the direct chat)")
    sp.add_argument("target", metavar="CHAT_OR_USER")
    sp.add_argument("text", metavar="TEXT", help="message text, or - to read stdin")
    sp = add("send-file", cmd_send_file, "encrypt, upload and send a file")
    sp.add_argument("target", metavar="CHAT_OR_USER")
    sp.add_argument("path", metavar="PATH")
    sp.add_argument("--caption")
    sp.add_argument("--kind", choices=["image", "video", "audio", "voice", "document", "sticker", "gif"])
    sp.add_argument("--mime", help="override the guessed MIME type")
    sp = add("history", cmd_history, "show a chat's decrypted messages")
    sp.add_argument("chat", metavar="CHAT_OR_USER")
    sp.add_argument("--limit", type=int, default=50)
    sp.add_argument("--before", type=int, help="only messages before this sequence number")
    sp.add_argument("--mark-read", action="store_true", help="send a read receipt for what was shown")
    sp = add("download", cmd_download, "download, decrypt and verify a message's attachment")
    sp.add_argument("message_id", metavar="MESSAGE_ID")
    sp.add_argument("outdir", metavar="OUTDIR")
    sp.add_argument("--chat", help="the chat to look in (faster)")
    sp = add("code", cmd_code, "show the security code for a contact's devices")
    sp.add_argument("user", metavar="USER")
    sp = add("listen", cmd_listen, "print incoming messages as they arrive and send delivered receipts")
    sp.add_argument("--save-files", metavar="DIR", help="download and decrypt attachments into DIR")
    sp.add_argument("--count", type=int, default=0, help="exit after N incoming messages")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    for key, default in (("server", None), ("state", None), ("dev_user", None), ("name", None), ("json", False)):
        if not hasattr(args, key):
            setattr(args, key, default)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except (CliError, ApiError, crypto.CryptoError, PermissionError, ValueError) as err:
        print(f"tailchat: {err}", file=sys.stderr)
        return 1
    except (OSError, WebSocketError) as err:
        print(f"tailchat: connection problem: {err}", file=sys.stderr)
        return 2
