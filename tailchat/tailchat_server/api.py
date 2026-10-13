"""REST API and realtime handlers. Every request is tied to a tailnet identity;
everything except registering a new device also needs that device's bearer
token."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import time
import unicodedata
from pathlib import Path

from aiohttp import web

from .config import Config
from .db import Database
from .hub import Hub, Socket
from .httputil import Context, HttpError, Router, fail, json_response, new_id, read_json, v_bool, v_int, v_str

MAX_PAYLOAD = 512 * 1024  # an encrypted message envelope, thumbnails included
MAX_GROUP = 1024
BIG = 2**53 - 1


def now() -> int:
    return int(time.time() * 1000)


def hash_token(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def is_emoji(text: str) -> bool:
    """A single emoji, including ZWJ sequences, skin tones, flags and keycaps."""
    if not text or len(text) > 16:
        return False
    has_symbol = False
    for i, ch in enumerate(text):
        cp = ord(ch)
        cat = unicodedata.category(ch)
        if cat == "So":
            has_symbol = True
        elif cat in ("Sk", "Mn", "Me") or cp == 0x200D or 0xE0020 <= cp <= 0xE007F:
            continue
        elif ch in "0123456789#*" and i == 0 and len(text) > 1 and text[-1] == "⃣":
            has_symbol = True  # keycap
        else:
            return False
    return has_symbol


class Api:
    def __init__(self, db: Database, hub: Hub, config: Config):
        self.db = db
        self.hub = hub
        self.config = config
        self.router = Router()
        self.calls: dict[str, dict] = {}
        self._register_routes()
        hub.on_connect = self.presence_changed
        hub.on_disconnect = self._on_disconnect
        hub.on_message = self._on_ws_message
        hub.on_socket_closed = lambda sock: self.drop_device_from_calls(sock.device_id)

    # ---------- helpers ----------

    def file_path(self, file_id: str) -> Path:
        return self.config.data_dir / "files" / file_id

    def all_user_ids(self) -> list[str]:
        return [r["id"] for r in self.db.all("SELECT id FROM users")]

    def upsert_user(self, identity) -> dict:
        db = self.db
        existing = db.get("SELECT * FROM users WHERE id = ?", identity.login)
        if existing:
            if identity.avatar_url and identity.avatar_url != existing["tailscale_avatar"]:
                db.run("UPDATE users SET tailscale_avatar = ? WHERE id = ?", identity.avatar_url, identity.login)
                existing["tailscale_avatar"] = identity.avatar_url
            return existing
        db.run(
            "INSERT INTO users (id, name, tailscale_avatar, created_at) VALUES (?, ?, ?, ?)",
            identity.login, identity.name[:60] or identity.login, identity.avatar_url, now(),
        )
        user = db.get("SELECT * FROM users WHERE id = ?", identity.login)
        for uid in self.all_user_ids():
            self.hub.send_to_user(uid, {"type": "user", "user": self.user_view(user, uid)})
        return user

    async def authenticate_token(self, token, identity) -> dict:
        if not isinstance(token, str):
            raise HttpError(401, "Missing device token")
        device_id, _, secret = token.partition(".")
        device = self.db.get("SELECT * FROM devices WHERE id = ?", device_id) if device_id else None
        if not device or not secret:
            raise HttpError(401, "Unknown device")
        if not hmac.compare_digest(device["token_hash"], hash_token(secret)):
            raise HttpError(401, "Unknown device")
        if device["revoked_at"]:
            raise HttpError(401, "This device was logged out")
        if device["user_id"] != identity.login:
            raise HttpError(403, "This device belongs to another tailnet user")
        self.db.run("UPDATE devices SET last_active = ? WHERE id = ?", now(), device["id"])
        return device

    def is_blocked(self, by: str, whom: str) -> bool:
        return bool(self.db.get("SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?", by, whom))

    def either_blocked(self, a: str, b: str) -> bool:
        return self.is_blocked(a, b) or self.is_blocked(b, a)

    def user_view(self, u: dict, viewer: str | None) -> dict:
        viewer_row = self.db.get("SELECT hide_last_seen FROM users WHERE id = ?", viewer) if viewer else None
        # Like WhatsApp: hiding your own last seen also hides everyone else's from you.
        hidden = viewer != u["id"] and bool(
            u["hide_last_seen"] or (viewer_row and viewer_row["hide_last_seen"]) or (viewer and self.either_blocked(u["id"], viewer))
        )
        view = {
            "id": u["id"],
            "name": u["name"],
            "about": u["about"],
            "avatar": f"/api/avatars/{u['avatar']}" if u["avatar"] else u["tailscale_avatar"],
            "online": None if hidden else self.hub.is_online(u["id"]),
            "lastSeen": None if hidden else u["last_seen"],
        }
        if viewer == u["id"]:
            view["hideLastSeen"] = bool(u["hide_last_seen"])
            view["readReceipts"] = bool(u["read_receipts"])
        elif viewer:
            view["blocked"] = self.is_blocked(viewer, u["id"])
        return view

    @staticmethod
    def device_view(d: dict) -> dict:
        return {
            "id": d["id"],
            "userId": d["user_id"],
            "name": d["name"],
            "publicKey": json.loads(d["public_key"]),
            "createdAt": d["created_at"],
            "lastActive": d["last_active"],
            "revokedAt": d["revoked_at"],
        }

    # ---------- chats ----------

    def active_member(self, chat_id: str, user_id: str) -> dict | None:
        m = self.db.get("SELECT * FROM members WHERE chat_id = ? AND user_id = ?", chat_id, user_id)
        return m if m and m["left_at"] is None else None

    def require_member(self, chat_id: str, user_id: str, *, allow_former: bool = False):
        chat = self.db.get("SELECT * FROM chats WHERE id = ?", chat_id)
        if not chat:
            fail(404, "No such chat")
        member = self.db.get("SELECT * FROM members WHERE chat_id = ? AND user_id = ?", chat_id, user_id)
        if not member or (member["left_at"] is not None and not allow_former):
            fail(403, "You are not in this chat")
        return chat, member

    def require_admin(self, chat_id: str, user_id: str):
        chat, member = self.require_member(chat_id, user_id)
        if chat["type"] != "group":
            fail(400, "Only groups have admins")
        if member["role"] != "admin":
            fail(403, "Only group admins can do that")
        return chat, member

    def get_chat(self, chat_id: str) -> dict:
        return self.db.get("SELECT * FROM chats WHERE id = ?", chat_id)

    def active_member_ids(self, chat_id: str) -> list[str]:
        return [r["user_id"] for r in self.db.all("SELECT user_id FROM members WHERE chat_id = ? AND left_at IS NULL", chat_id)]

    def ever_member_ids(self, chat_id: str) -> list[str]:
        return [r["user_id"] for r in self.db.all("SELECT user_id FROM members WHERE chat_id = ?", chat_id)]

    @staticmethod
    def visible_floor(m: dict) -> int:
        # Lowest seq a member may see; former members keep what they saw before leaving.
        return max(m["joined_seq"], m["cleared_seq"])

    def member_view(self, m: dict, chat: dict, viewer: str) -> dict:
        user = self.db.get("SELECT read_receipts FROM users WHERE id = ?", m["user_id"])
        viewer_user = self.db.get("SELECT read_receipts FROM users WHERE id = ?", viewer)
        # Turning read receipts off works both ways, as on WhatsApp, except in groups.
        hide_read = (
            chat["type"] == "direct"
            and m["user_id"] != viewer
            and (not (user and user["read_receipts"]) or not (viewer_user and viewer_user["read_receipts"]))
        )
        return {
            "userId": m["user_id"],
            "role": m["role"],
            "joinedAt": m["joined_at"],
            "joinedSeq": m["joined_seq"],
            "left": m["left_at"] is not None,
            "deliveredSeq": m["delivered_seq"],
            "readSeq": 0 if hide_read else m["read_seq"],
        }

    def chat_view(self, chat: dict, viewer: str) -> dict:
        db = self.db
        me = db.get("SELECT * FROM members WHERE chat_id = ? AND user_id = ?", chat["id"], viewer)
        members = db.all("SELECT * FROM members WHERE chat_id = ? ORDER BY joined_at", chat["id"])
        floor = self.visible_floor(me)
        ceiling = me["left_seq"] if me["left_seq"] is not None else BIG
        last = db.get(
            """SELECT * FROM messages WHERE chat_id = ? AND seq > ? AND seq <= ?
                 AND id NOT IN (SELECT message_id FROM hidden WHERE user_id = ?)
               ORDER BY seq DESC LIMIT 1""",
            chat["id"], floor, ceiling, viewer,
        )
        unread = db.get(
            """SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND kind = 'msg' AND sender_id != ?
                 AND deleted_at IS NULL AND seq > ? AND seq <= ?""",
            chat["id"], viewer, max(floor, me["read_seq"]), ceiling,
        )["n"]
        active = me["left_at"] is None
        return {
            "id": chat["id"],
            "type": chat["type"],
            "name": chat["name"],
            "description": chat["description"],
            "avatar": f"/api/avatars/{chat['avatar']}" if chat["avatar"] else None,
            "createdBy": chat["created_by"],
            "createdAt": chat["created_at"],
            "disappearing": chat["disappearing"],
            "adminsOnlySend": bool(chat["admins_only_send"]),
            "adminsOnlyEdit": bool(chat["admins_only_edit"]),
            "inviteCode": chat["invite_code"] if me["role"] == "admin" and active else None,
            "pinnedMessage": chat["pinned_message"],
            "lastSeq": chat["last_seq"],
            "members": [self.member_view(m, chat, viewer) for m in members],
            "me": {
                "role": me["role"],
                "left": not active,
                "joinedSeq": me["joined_seq"],
                "clearedSeq": me["cleared_seq"],
                "leftSeq": me["left_seq"],
                "readSeq": me["read_seq"],
                "pinnedAt": me["pinned_at"],
                "archived": bool(me["archived"]),
                "mutedUntil": me["muted_until"],
                "markedUnread": bool(me["marked_unread"]),
            },
            "unread": unread,
            "lastMessage": self.message_view(last, viewer) if last else None,
        }

    def opened_by(self, message_id: str) -> list[dict]:
        return self.db.all("SELECT user_id AS userId, at FROM view_once_opened WHERE message_id = ?", message_id)

    def message_view(self, m: dict, viewer: str) -> dict:
        db = self.db
        opened = bool(m["view_once"]) and bool(
            db.get("SELECT 1 FROM view_once_opened WHERE message_id = ? AND user_id = ?", m["id"], viewer)
        )
        mine = m["sender_id"] == viewer
        view = {
            "id": m["id"],
            "chatId": m["chat_id"],
            "seq": m["seq"],
            "senderId": m["sender_id"],
            "senderDevice": m["sender_device"],
            "kind": m["kind"],
            # A view-once message is gone for a recipient once they have opened it.
            "payload": None if m["deleted_at"] or (opened and not mine) else m["payload"],
            "files": json.loads(m["files"]),
            "viewOnce": bool(m["view_once"]),
            "createdAt": m["created_at"],
            "editedAt": m["edited_at"],
            "deletedAt": m["deleted_at"],
            "expiresAt": m["expires_at"],
            "reactions": db.all("SELECT user_id AS userId, emoji FROM reactions WHERE message_id = ? ORDER BY at", m["id"]),
            "votes": [
                {"userId": v["userId"], "options": json.loads(v["options"])}
                for v in db.all("SELECT user_id AS userId, options FROM poll_votes WHERE message_id = ?", m["id"])
            ],
            "starred": bool(db.get("SELECT 1 FROM stars WHERE user_id = ? AND message_id = ?", viewer, m["id"])),
        }
        if m["view_once"]:
            view["opened"] = self.opened_by(m["id"]) if mine else opened
        return view

    def broadcast_chat(self, chat_id: str, extra_user_ids=()) -> None:
        """Send each member their own view of the chat (unread counts and
        receipts differ per viewer)."""
        chat = self.get_chat(chat_id)
        for uid in dict.fromkeys([*self.ever_member_ids(chat_id), *extra_user_ids]):
            if not self.db.get("SELECT 1 FROM members WHERE chat_id = ? AND user_id = ?", chat_id, uid):
                continue
            self.hub.send_to_user(uid, {"type": "chat", "chat": self.chat_view(chat, uid)})

    def can_see_message(self, m: dict, user_id: str) -> bool:
        member = self.db.get("SELECT * FROM members WHERE chat_id = ? AND user_id = ?", m["chat_id"], user_id)
        if not member:
            return False
        return m["seq"] > self.visible_floor(member) and (member["left_seq"] is None or m["seq"] <= member["left_seq"])

    def broadcast_message(self, m: dict, kind: str = "message", **options) -> None:
        for uid in self.ever_member_ids(m["chat_id"]):
            if self.can_see_message(m, uid):
                self.hub.send_to_user(uid, {"type": kind, "message": self.message_view(m, uid)}, **options)

    def insert_message(self, chat: dict, *, id: str, sender_id: str, sender_device: str | None, kind: str,
                       payload: str | None, files=(), view_once: bool = False) -> dict:
        db = self.db
        with db.tx():
            seq = db.get("SELECT last_seq FROM chats WHERE id = ?", chat["id"])["last_seq"] + 1
            db.run("UPDATE chats SET last_seq = ? WHERE id = ?", seq, chat["id"])
            created = now()
            expires = created + chat["disappearing"] * 1000 if chat["disappearing"] and kind == "msg" else None
            db.run(
                """INSERT INTO messages (id, chat_id, seq, sender_id, sender_device, kind, payload, files, view_once, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                id, chat["id"], seq, sender_id, sender_device, kind, payload, json.dumps(list(files)),
                1 if view_once else 0, created, expires,
            )
            for f in files:
                db.run("INSERT INTO file_links (file_id, message_id) VALUES (?, ?)", f, id)
            if kind == "msg":
                # A sender has read everything up to their own message.
                db.run(
                    "UPDATE members SET read_seq = ?, delivered_seq = ?, marked_unread = 0 WHERE chat_id = ? AND user_id = ?",
                    seq, seq, chat["id"], sender_id,
                )
            db.run("UPDATE members SET removed = 0 WHERE chat_id = ?", chat["id"])
            return db.get("SELECT * FROM messages WHERE id = ?", id)

    def system_message(self, chat: dict, actor: str, event: dict) -> dict:
        m = self.insert_message(chat, id=new_id(), sender_id=actor, sender_device=None, kind="system", payload=json.dumps(event))
        self.broadcast_message(m)
        return m

    def add_members(self, chat: dict, actor: str, user_ids: list[str]) -> list[str]:
        db = self.db
        added: list[str] = []
        with db.tx():
            for uid in user_ids:
                if not db.get("SELECT 1 FROM users WHERE id = ?", uid):
                    fail(400, f"Unknown user {uid}")
                existing = db.get("SELECT * FROM members WHERE chat_id = ? AND user_id = ?", chat["id"], uid)
                if existing and existing["left_at"] is None:
                    continue
                seq = db.get("SELECT last_seq FROM chats WHERE id = ?", chat["id"])["last_seq"]
                if existing:
                    db.run(
                        """UPDATE members SET left_at = NULL, left_seq = NULL, role = 'member', joined_at = ?, joined_seq = ?,
                             cleared_seq = ?, read_seq = ?, delivered_seq = ?, removed = 0 WHERE chat_id = ? AND user_id = ?""",
                        now(), seq, seq, seq, seq, chat["id"], uid,
                    )
                else:
                    db.run(
                        """INSERT INTO members (chat_id, user_id, role, joined_at, joined_seq, read_seq, delivered_seq)
                           VALUES (?, ?, 'member', ?, ?, ?, ?)""",
                        chat["id"], uid, now(), seq, seq, seq,
                    )
                added.append(uid)
            count = db.get("SELECT COUNT(*) AS n FROM members WHERE chat_id = ? AND left_at IS NULL", chat["id"])["n"]
            if count > MAX_GROUP:
                fail(400, f"Groups are limited to {MAX_GROUP} members")
        if added:
            joined = len(added) == 1 and added[0] == actor
            self.system_message(chat, actor, {"event": "joined" if joined else "added", "users": added})
        return added

    def remove_member(self, chat: dict, actor: str, uid: str) -> None:
        db = self.db
        seq = db.get("SELECT last_seq FROM chats WHERE id = ?", chat["id"])["last_seq"]
        db.run(
            "UPDATE members SET left_at = ?, left_seq = ?, role = 'member' WHERE chat_id = ? AND user_id = ?",
            now(), seq, chat["id"], uid,
        )
        self.system_message(chat, actor, {"event": "left" if actor == uid else "removed", "users": [uid]})
        # Keep at least one admin, like WhatsApp: promote the longest-standing member.
        if not db.get("SELECT 1 FROM members WHERE chat_id = ? AND left_at IS NULL AND role = 'admin'", chat["id"]):
            nxt = db.get("SELECT user_id FROM members WHERE chat_id = ? AND left_at IS NULL ORDER BY joined_at LIMIT 1", chat["id"])
            if nxt:
                db.run("UPDATE members SET role = 'admin' WHERE chat_id = ? AND user_id = ?", chat["id"], nxt["user_id"])
        self.broadcast_chat(chat["id"], [uid])

    def notify_device_change(self, user_id: str) -> None:
        """Everyone who shares a chat with this user must encrypt for the new key set."""
        peers = [
            r["user_id"]
            for r in self.db.all(
                """SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.chat_id = m2.chat_id
                   WHERE m1.user_id = ? AND m2.left_at IS NULL""",
                user_id,
            )
        ]
        self.hub.send_to_users([user_id, *peers], {"type": "devices", "userId": user_id})

    def push_user_to(self, subject_id: str, viewer_id: str) -> None:
        u = self.db.get("SELECT * FROM users WHERE id = ?", subject_id)
        if u:
            self.hub.send_to_user(viewer_id, {"type": "user", "user": self.user_view(u, viewer_id)})

    # ---------- files ----------

    def can_read_file(self, file_id: str, user_id: str) -> dict | None:
        db = self.db
        f = db.get("SELECT * FROM files WHERE id = ?", file_id)
        if not f:
            return None
        if f["owner"] == user_id or f["public"]:
            return f
        for link in db.all("SELECT * FROM file_links WHERE file_id = ?", file_id):
            if link["message_id"]:
                m = db.get("SELECT * FROM messages WHERE id = ?", link["message_id"])
                if not m or m["deleted_at"] or not self.can_see_message(m, user_id):
                    continue
                if m["view_once"] and m["sender_id"] != user_id and db.get(
                    "SELECT 1 FROM view_once_opened WHERE message_id = ? AND user_id = ?", m["id"], user_id
                ):
                    continue
                return f
            if link["status_id"]:
                s = db.get("SELECT * FROM statuses WHERE id = ? AND expires_at > ?", link["status_id"], now())
                if s and not self.either_blocked(s["user_id"], user_id):
                    return f
        return None

    def check_files(self, files, user_id: str) -> list[str]:
        if not isinstance(files, list) or len(files) > 32:
            fail(400, "files must be a list of up to 32 file ids")
        for f in files:
            if not isinstance(f, str) or not self.can_read_file(f, user_id):
                fail(400, "Unknown file")
        return list(dict.fromkeys(files))

    def delete_orphan_files(self, ids) -> None:
        for fid in ids:
            if self.db.get("SELECT 1 FROM file_links WHERE file_id = ?", fid):
                continue
            f = self.db.get("SELECT public FROM files WHERE id = ?", fid)
            if not f or f["public"]:
                continue
            self.db.run("DELETE FROM files WHERE id = ?", fid)
            self.file_path(fid).unlink(missing_ok=True)

    def wipe_message(self, m: dict) -> None:
        files = json.loads(m["files"])
        self.db.run("DELETE FROM file_links WHERE message_id = ?", m["id"])
        self.db.run("DELETE FROM reactions WHERE message_id = ?", m["id"])
        self.db.run("DELETE FROM poll_votes WHERE message_id = ?", m["id"])
        self.delete_orphan_files(files)

    # ---------- periodic cleanup ----------

    def sweep(self) -> None:
        db = self.db
        t = now()
        for m in db.all("SELECT * FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?", t):
            self.wipe_message(m)
            for table in ("stars", "hidden", "view_once_opened"):
                db.run(f"DELETE FROM {table} WHERE message_id = ?", m["id"])
            db.run("DELETE FROM messages WHERE id = ?", m["id"])
            self.hub.send_to_users(self.ever_member_ids(m["chat_id"]), {"type": "message-gone", "chatId": m["chat_id"], "id": m["id"]})
        for s in db.all("SELECT * FROM statuses WHERE expires_at <= ?", t):
            self._delete_status(s)
        # Uploads that never made it into a message or status.
        stale = db.all(
            "SELECT id FROM files WHERE public = 0 AND created_at < ? AND id NOT IN (SELECT file_id FROM file_links)",
            t - 24 * 3600 * 1000,
        )
        self.delete_orphan_files([r["id"] for r in stale])

    def _delete_status(self, s: dict) -> None:
        self.db.run("DELETE FROM file_links WHERE status_id = ?", s["id"])
        self.db.run("DELETE FROM status_views WHERE status_id = ?", s["id"])
        self.db.run("DELETE FROM statuses WHERE id = ?", s["id"])
        self.delete_orphan_files(json.loads(s["files"]))
        self.hub.send_to_users(self.all_user_ids(), {"type": "status-gone", "id": s["id"]})

    def require_message(self, message_id: str, user_id: str) -> dict:
        m = self.db.get("SELECT * FROM messages WHERE id = ?", message_id)
        if not m or not self.can_see_message(m, user_id):
            fail(404, "No such message")
        return m

    def status_view(self, s: dict, viewer: str) -> dict:
        view = {
            "id": s["id"],
            "userId": s["user_id"],
            "payload": s["payload"],
            "files": json.loads(s["files"]),
            "createdAt": s["created_at"],
            "expiresAt": s["expires_at"],
            "seen": bool(self.db.get("SELECT 1 FROM status_views WHERE status_id = ? AND viewer_id = ?", s["id"], viewer)),
        }
        if s["user_id"] == viewer:
            view["viewers"] = self.db.all(
                "SELECT viewer_id AS userId, at FROM status_views WHERE status_id = ? ORDER BY at DESC", s["id"]
            )
        return view

    # ---------- routes ----------

    def _register_routes(self) -> None:  # noqa: C901 - one place for the whole API surface
        r = self.router
        db = self.db
        cfg = self.config
        hub = self.hub

        @r.add("GET", "/api/me", device="optional")
        async def me(ctx: Context):
            return {
                "user": self.user_view(ctx.user, ctx.user["id"]),
                "device": self.device_view(ctx.device) if ctx.device else None,
                "authMode": cfg.auth,
                "limits": {
                    "maxUploadBytes": cfg.max_upload_bytes,
                    "editWindowSeconds": cfg.edit_window_s,
                    "deleteWindowSeconds": cfg.delete_window_s,
                },
            }

        @r.add("PATCH", "/api/me")
        async def update_me(ctx: Context):
            body = await read_json(ctx.request)
            uid = ctx.user["id"]
            name = v_str(body.get("name"), "name", optional=True, min=1, max=60)
            about = v_str(body.get("about"), "about", optional=True, max=140)
            hide = v_bool(body.get("hideLastSeen"), "hideLastSeen")
            receipts = v_bool(body.get("readReceipts"), "readReceipts")
            if "avatar" in body:
                if body["avatar"] is not None and not db.get(
                    "SELECT 1 FROM files WHERE id = ? AND owner = ? AND public = 1", body["avatar"], uid
                ):
                    fail(400, "avatar must be a public image you uploaded")
                db.run("UPDATE users SET avatar = ? WHERE id = ?", body["avatar"], uid)
            if name is not None:
                db.run("UPDATE users SET name = ? WHERE id = ?", name, uid)
            if about is not None:
                db.run("UPDATE users SET about = ? WHERE id = ?", about, uid)
            if hide is not None:
                db.run("UPDATE users SET hide_last_seen = ? WHERE id = ?", int(hide), uid)
            if receipts is not None:
                db.run("UPDATE users SET read_receipts = ? WHERE id = ?", int(receipts), uid)
            user = db.get("SELECT * FROM users WHERE id = ?", uid)
            for other in self.all_user_ids():
                hub.send_to_user(other, {"type": "user", "user": self.user_view(user, other)})
            return {"user": self.user_view(user, uid)}

        @r.add("POST", "/api/devices", device=False)
        async def register_device(ctx: Context):
            body = await read_json(ctx.request)
            name = v_str(body.get("name"), "name", min=1, max=80)
            key = body.get("publicKey")
            if (
                not isinstance(key, dict) or key.get("kty") != "EC" or key.get("crv") != "P-256"
                or not isinstance(key.get("x"), str) or not isinstance(key.get("y"), str) or "d" in key
            ):
                fail(400, "publicKey must be a P-256 public JWK")
            device_id = new_id(12)
            secret = new_id(32)
            public_key = json.dumps({"kty": "EC", "crv": "P-256", "x": key["x"], "y": key["y"]})
            db.run(
                "INSERT INTO devices (id, user_id, name, public_key, token_hash, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
                device_id, ctx.user["id"], name, public_key, hash_token(secret), now(), now(),
            )
            self.notify_device_change(ctx.user["id"])
            device = db.get("SELECT * FROM devices WHERE id = ?", device_id)
            return {"device": self.device_view(device), "token": f"{device_id}.{secret}"}

        @r.add("GET", "/api/devices")
        async def list_devices(ctx: Context):
            rows = db.all("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at", ctx.user["id"])
            return {"devices": [self.device_view(d) for d in rows]}

        @r.add("DELETE", "/api/devices/:id")
        async def revoke_device(ctx: Context):
            d = db.get("SELECT * FROM devices WHERE id = ? AND user_id = ?", ctx.params["id"], ctx.user["id"])
            if not d:
                fail(404, "No such device")
            db.run("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now(), d["id"])
            hub.revoke_device(d["id"])
            self.notify_device_change(ctx.user["id"])
            return {"ok": True}

        # Public keys of any devices, including logged-out ones, so old
        # messages from them still decrypt.
        @r.add("GET", "/api/keys")
        async def keys(ctx: Context):
            ids = [i for i in ctx.query.get("ids", "").split(",") if i][:500]
            if not ids:
                return {"devices": []}
            rows = db.all(f"SELECT * FROM devices WHERE id IN ({','.join('?' * len(ids))})", *ids)
            return {"devices": [self.device_view(d) for d in rows]}

        @r.add("GET", "/api/users")
        async def users(ctx: Context):
            rows = db.all("SELECT * FROM users ORDER BY name COLLATE NOCASE")
            return {"users": [self.user_view(u, ctx.user["id"]) for u in rows]}

        @r.add("GET", "/api/users/:id/devices")
        async def user_devices(ctx: Context):
            rows = db.all("SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at", ctx.params["id"])
            return {"devices": [self.device_view(d) for d in rows]}

        @r.add("POST", "/api/blocks")
        async def block(ctx: Context):
            body = await read_json(ctx.request)
            target = v_str(body.get("userId"), "userId")
            if target == ctx.user["id"]:
                fail(400, "You cannot block yourself")
            if not db.get("SELECT 1 FROM users WHERE id = ?", target):
                fail(404, "No such user")
            db.run("INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)", ctx.user["id"], target)
            self.push_user_to(target, ctx.user["id"])
            self.push_user_to(ctx.user["id"], target)
            return {"ok": True}

        @r.add("DELETE", "/api/blocks/:id")
        async def unblock(ctx: Context):
            db.run("DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?", ctx.user["id"], ctx.params["id"])
            self.push_user_to(ctx.params["id"], ctx.user["id"])
            self.push_user_to(ctx.user["id"], ctx.params["id"])
            return {"ok": True}

        @r.add("GET", "/api/chats")
        async def chats(ctx: Context):
            rows = db.all(
                "SELECT c.* FROM chats c JOIN members m ON m.chat_id = c.id WHERE m.user_id = ? AND m.removed = 0",
                ctx.user["id"],
            )
            return {"chats": [self.chat_view(c, ctx.user["id"]) for c in rows]}

        @r.add("GET", "/api/chats/:id")
        async def chat(ctx: Context):
            chat, _ = self.require_member(ctx.params["id"], ctx.user["id"], allow_former=True)
            return {"chat": self.chat_view(chat, ctx.user["id"])}

        @r.add("POST", "/api/chats/direct")
        async def direct(ctx: Context):
            body = await read_json(ctx.request)
            other = v_str(body.get("userId"), "userId")
            if not db.get("SELECT 1 FROM users WHERE id = ?", other):
                fail(404, "No such user")
            key = "|".join(sorted([ctx.user["id"], other]))
            chat = db.get("SELECT * FROM chats WHERE direct_key = ?", key)
            if not chat:
                chat_id = new_id()
                with db.tx():
                    db.run(
                        "INSERT INTO chats (id, type, created_by, created_at, direct_key) VALUES (?, 'direct', ?, ?, ?)",
                        chat_id, ctx.user["id"], now(), key,
                    )
                    for uid in dict.fromkeys([ctx.user["id"], other]):
                        db.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", chat_id, uid, now())
                chat = self.get_chat(chat_id)
            db.run("UPDATE members SET removed = 0 WHERE chat_id = ? AND user_id = ?", chat["id"], ctx.user["id"])
            return {"chat": self.chat_view(chat, ctx.user["id"])}

        @r.add("POST", "/api/chats/group")
        async def group(ctx: Context):
            body = await read_json(ctx.request)
            name = v_str(body.get("name"), "name", min=1, max=100)
            description = v_str(body.get("description"), "description", optional=True, max=2048) or ""
            members = body.get("members")
            if not isinstance(members, list):
                fail(400, "members must be a list of user ids")
            others = list(dict.fromkeys(m for m in members if m != ctx.user["id"]))
            for uid in others:
                if not isinstance(uid, str) or not db.get("SELECT 1 FROM users WHERE id = ?", uid):
                    fail(400, "Unknown member")
            avatar = None
            if body.get("avatar"):
                row = db.get("SELECT id FROM files WHERE id = ? AND public = 1", body["avatar"])
                avatar = row["id"] if row else None
            chat_id = new_id()
            with db.tx():
                db.run(
                    "INSERT INTO chats (id, type, name, description, avatar, created_by, created_at) VALUES (?, 'group', ?, ?, ?, ?, ?)",
                    chat_id, name, description, avatar, ctx.user["id"], now(),
                )
                db.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)", chat_id, ctx.user["id"], now())
            chat = self.get_chat(chat_id)
            self.system_message(chat, ctx.user["id"], {"event": "created", "name": name})
            if others:
                self.add_members(chat, ctx.user["id"], others)
            self.broadcast_chat(chat_id)
            return {"chat": self.chat_view(self.get_chat(chat_id), ctx.user["id"])}

        @r.add("PATCH", "/api/chats/:id")
        async def update_chat(ctx: Context):
            body = await read_json(ctx.request)
            chat, member = self.require_member(ctx.params["id"], ctx.user["id"])
            is_admin = member["role"] == "admin"
            changes: list[dict] = []
            if any(k in body for k in ("name", "description", "avatar")):
                if chat["type"] != "group":
                    fail(400, "Only groups have a name, description and photo")
                if chat["admins_only_edit"] and not is_admin:
                    fail(403, "Only admins can edit this group's info")
            if ("adminsOnlySend" in body or "adminsOnlyEdit" in body) and not is_admin:
                fail(403, "Only admins can change group settings")
            if "name" in body:
                name = v_str(body["name"], "name", min=1, max=100)
                db.run("UPDATE chats SET name = ? WHERE id = ?", name, chat["id"])
                changes.append({"event": "renamed", "name": name})
            if "description" in body:
                db.run("UPDATE chats SET description = ? WHERE id = ?", v_str(body["description"], "description", max=2048), chat["id"])
                changes.append({"event": "description"})
            if "avatar" in body:
                avatar = None
                if body["avatar"] is not None:
                    row = db.get("SELECT id FROM files WHERE id = ? AND public = 1", body["avatar"])
                    if not row:
                        fail(400, "avatar must be a public image")
                    avatar = row["id"]
                db.run("UPDATE chats SET avatar = ? WHERE id = ?", avatar, chat["id"])
                changes.append({"event": "photo"})
            if "disappearing" in body:
                secs = v_int(body["disappearing"], "disappearing", max=90 * 86400)
                if chat["type"] == "group" and chat["admins_only_edit"] and not is_admin:
                    fail(403, "Only admins can change disappearing messages")
                db.run("UPDATE chats SET disappearing = ? WHERE id = ?", secs, chat["id"])
                changes.append({"event": "disappearing", "seconds": secs})
            for field, column in (("adminsOnlySend", "admins_only_send"), ("adminsOnlyEdit", "admins_only_edit")):
                if field not in body:
                    continue
                value = v_bool(body[field], field, optional=False)
                db.run(f"UPDATE chats SET {column} = ? WHERE id = ?", int(value), chat["id"])
                changes.append({"event": "settings", field: value})
            for event in changes:
                self.system_message(self.get_chat(chat["id"]), ctx.user["id"], event)
            self.broadcast_chat(chat["id"])
            return {"chat": self.chat_view(self.get_chat(chat["id"]), ctx.user["id"])}

        @r.add("PATCH", "/api/chats/:id/prefs")
        async def prefs(ctx: Context):
            body = await read_json(ctx.request)
            chat, _ = self.require_member(ctx.params["id"], ctx.user["id"], allow_former=True)
            uid = ctx.user["id"]

            def set_(column: str, value) -> None:
                db.run(f"UPDATE members SET {column} = ? WHERE chat_id = ? AND user_id = ?", value, chat["id"], uid)

            if "pinned" in body:
                if v_bool(body["pinned"], "pinned", optional=False):
                    pinned = db.get(
                        "SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND pinned_at IS NOT NULL AND chat_id != ?", uid, chat["id"]
                    )["n"]
                    if pinned >= 3:
                        fail(400, "You can only pin up to 3 chats")
                    set_("pinned_at", now())
                else:
                    set_("pinned_at", None)
            if "archived" in body:
                set_("archived", int(v_bool(body["archived"], "archived", optional=False)))
            if "mutedUntil" in body:
                set_("muted_until", v_int(body["mutedUntil"], "mutedUntil"))
            if "markedUnread" in body:
                set_("marked_unread", int(v_bool(body["markedUnread"], "markedUnread", optional=False)))
            view = self.chat_view(chat, uid)
            hub.send_to_user(uid, {"type": "chat", "chat": view})
            return {"chat": view}

        @r.add("POST", "/api/chats/:id/clear")
        async def clear(ctx: Context):
            chat, _ = self.require_member(ctx.params["id"], ctx.user["id"], allow_former=True)
            seq = self.get_chat(chat["id"])["last_seq"]
            db.run(
                "UPDATE members SET cleared_seq = ?, read_seq = MAX(read_seq, ?) WHERE chat_id = ? AND user_id = ?",
                seq, seq, chat["id"], ctx.user["id"],
            )
            view = self.chat_view(chat, ctx.user["id"])
            hub.send_to_user(ctx.user["id"], {"type": "chat", "chat": view})
            return {"chat": view}

        # "Delete chat": clears it and hides it until someone writes again. A
        # former group member's copy is removed for good.
        @r.add("DELETE", "/api/chats/:id")
        async def delete_chat(ctx: Context):
            chat, member = self.require_member(ctx.params["id"], ctx.user["id"], allow_former=True)
            if chat["type"] == "group" and member["left_at"] is None:
                fail(400, "Exit the group before deleting it")
            seq = chat["last_seq"]
            if member["left_at"] is not None:
                db.run("DELETE FROM members WHERE chat_id = ? AND user_id = ?", chat["id"], ctx.user["id"])
            else:
                db.run(
                    """UPDATE members SET cleared_seq = ?, read_seq = MAX(read_seq, ?), removed = 1, pinned_at = NULL
                       WHERE chat_id = ? AND user_id = ?""",
                    seq, seq, chat["id"], ctx.user["id"],
                )
            hub.send_to_user(ctx.user["id"], {"type": "chat-removed", "chatId": chat["id"]})
            return {"ok": True}

        @r.add("POST", "/api/chats/:id/members")
        async def add_members(ctx: Context):
            body = await read_json(ctx.request)
            chat, _ = self.require_admin(ctx.params["id"], ctx.user["id"])
            user_ids = body.get("userIds")
            if not isinstance(user_ids, list) or not user_ids:
                fail(400, "userIds must be a non-empty list")
            added = self.add_members(chat, ctx.user["id"], [u for u in user_ids if isinstance(u, str)])
            for uid in added:
                self.notify_device_change(uid)
            self.broadcast_chat(chat["id"])
            return {"added": added}

        @r.add("DELETE", "/api/chats/:id/members/:userId")
        async def remove_member(ctx: Context):
            target = ctx.params["userId"]
            if target == ctx.user["id"]:
                chat, _ = self.require_member(ctx.params["id"], ctx.user["id"])
            else:
                chat, _ = self.require_admin(ctx.params["id"], ctx.user["id"])
            if chat["type"] != "group":
                fail(400, "You can only leave groups")
            if not self.active_member(chat["id"], target):
                fail(404, "Not a member")
            self.remove_member(chat, ctx.user["id"], target)
            return {"ok": True}

        @r.add("POST", "/api/chats/:id/admins")
        async def admins(ctx: Context):
            body = await read_json(ctx.request)
            chat, _ = self.require_admin(ctx.params["id"], ctx.user["id"])
            target = v_str(body.get("userId"), "userId")
            admin = v_bool(body.get("admin"), "admin", optional=False)
            if not self.active_member(chat["id"], target):
                fail(404, "Not a member")
            if not admin and db.get(
                "SELECT COUNT(*) AS n FROM members WHERE chat_id = ? AND left_at IS NULL AND role = 'admin'", chat["id"]
            )["n"] <= 1:
                fail(400, "A group needs at least one admin")
            db.run("UPDATE members SET role = ? WHERE chat_id = ? AND user_id = ?", "admin" if admin else "member", chat["id"], target)
            self.system_message(chat, ctx.user["id"], {"event": "promoted" if admin else "demoted", "users": [target]})
            self.broadcast_chat(chat["id"])
            return {"ok": True}

        @r.add("POST", "/api/chats/:id/invite")
        async def new_invite(ctx: Context):
            chat, _ = self.require_admin(ctx.params["id"], ctx.user["id"])
            code = new_id(12)
            db.run("UPDATE chats SET invite_code = ? WHERE id = ?", code, chat["id"])
            self.broadcast_chat(chat["id"])
            return {"code": code}

        @r.add("DELETE", "/api/chats/:id/invite")
        async def reset_invite(ctx: Context):
            chat, _ = self.require_admin(ctx.params["id"], ctx.user["id"])
            db.run("UPDATE chats SET invite_code = NULL WHERE id = ?", chat["id"])
            self.broadcast_chat(chat["id"])
            return {"ok": True}

        @r.add("GET", "/api/invite/:code")
        async def invite_preview(ctx: Context):
            chat = db.get("SELECT * FROM chats WHERE invite_code = ?", ctx.params["code"])
            if not chat:
                fail(404, "This invite link was reset or never existed")
            return {
                "chat": {
                    "id": chat["id"],
                    "name": chat["name"],
                    "description": chat["description"],
                    "avatar": f"/api/avatars/{chat['avatar']}" if chat["avatar"] else None,
                    "memberCount": len(self.active_member_ids(chat["id"])),
                    "isMember": bool(self.active_member(chat["id"], ctx.user["id"])),
                }
            }

        @r.add("POST", "/api/invite/:code/join")
        async def invite_join(ctx: Context):
            chat = db.get("SELECT * FROM chats WHERE invite_code = ?", ctx.params["code"])
            if not chat:
                fail(404, "This invite link was reset or never existed")
            self.add_members(chat, ctx.user["id"], [ctx.user["id"]])
            self.notify_device_change(ctx.user["id"])
            self.broadcast_chat(chat["id"])
            return {"chat": self.chat_view(self.get_chat(chat["id"]), ctx.user["id"])}

        # Every logged-in device of every current member: the sender wraps the
        # message key once for each of them.
        @r.add("GET", "/api/chats/:id/devices")
        async def chat_devices(ctx: Context):
            chat, _ = self.require_member(ctx.params["id"], ctx.user["id"])
            rows = db.all(
                """SELECT d.* FROM devices d JOIN members m ON m.user_id = d.user_id
                   WHERE m.chat_id = ? AND m.left_at IS NULL AND d.revoked_at IS NULL""",
                chat["id"],
            )
            return {"devices": [self.device_view(d) for d in rows]}

        @r.add("GET", "/api/chats/:id/messages")
        async def messages(ctx: Context):
            chat, member = self.require_member(ctx.params["id"], ctx.user["id"], allow_former=True)

            def qint(name: str, default: int) -> int:
                try:
                    return int(ctx.query.get(name, default))
                except ValueError:
                    return default

            limit = min(max(qint("limit", 50), 1), 200)
            before = qint("before", 0)
            after = qint("after", 0)
            floor = max(self.visible_floor(member), after)
            ceiling = min(member["left_seq"] if member["left_seq"] is not None else BIG, before - 1 if before else BIG)
            order = "ASC" if after else "DESC"
            rows = db.all(
                f"""SELECT * FROM messages WHERE chat_id = ? AND seq > ? AND seq <= ?
                      AND id NOT IN (SELECT message_id FROM hidden WHERE user_id = ?)
                    ORDER BY seq {order} LIMIT ?""",
                chat["id"], floor, ceiling, ctx.user["id"], limit,
            )
            if order == "DESC":
                rows.reverse()
            return {"messages": [self.message_view(m, ctx.user["id"]) for m in rows], "hasMore": len(rows) == limit}

        @r.add("POST", "/api/chats/:id/messages")
        async def send(ctx: Context):
            body = await read_json(ctx.request, MAX_PAYLOAD + 64 * 1024)
            uid = ctx.user["id"]
            chat, member = self.require_member(ctx.params["id"], uid)
            if chat["type"] == "group" and chat["admins_only_send"] and member["role"] != "admin":
                fail(403, "Only admins can send messages to this group")
            if chat["type"] == "direct":
                other = next((u for u in self.active_member_ids(chat["id"]) if u != uid), None)
                if other and self.is_blocked(uid, other):
                    fail(403, "Unblock this contact to send a message")
                if other and self.is_blocked(other, uid):
                    fail(403, "You can't message this contact")
            payload = body.get("payload")
            if not isinstance(payload, str) or len(payload) > MAX_PAYLOAD:
                fail(400, "payload must be an encrypted envelope string")
            if "id" in body:
                message_id = v_str(body["id"], "id", min=16, max=32)
                if not all(c.isascii() and (c.isalnum() or c in "-_") for c in message_id):
                    fail(400, "id must be base64url")
            else:
                message_id = new_id()
            existing = db.get("SELECT * FROM messages WHERE id = ?", message_id)
            # Retrying a send after a dropped connection must not duplicate it.
            if existing:
                if existing["sender_id"] != uid:
                    fail(409, "Message id already in use")
                return {"message": self.message_view(existing, uid)}
            files = self.check_files(body.get("files") or [], uid)
            m = self.insert_message(
                chat, id=message_id, sender_id=uid, sender_device=ctx.device["id"], kind="msg",
                payload=payload, files=files, view_once=body.get("viewOnce") is True,
            )
            self.broadcast_message(m)
            self.broadcast_chat(chat["id"])
            return {"message": self.message_view(m, uid)}

        @r.add("GET", "/api/messages/:id")
        async def get_message(ctx: Context):
            m = self.require_message(ctx.params["id"], ctx.user["id"])
            if self.db.get("SELECT 1 FROM hidden WHERE user_id = ? AND message_id = ?", ctx.user["id"], m["id"]):
                fail(404, "No such message")
            return {"message": self.message_view(m, ctx.user["id"])}

        @r.add("PUT", "/api/messages/:id")
        async def edit(ctx: Context):
            body = await read_json(ctx.request, MAX_PAYLOAD + 64 * 1024)
            uid = ctx.user["id"]
            m = self.require_message(ctx.params["id"], uid)
            if m["sender_id"] != uid or m["kind"] != "msg":
                fail(403, "You can only edit your own messages")
            if m["deleted_at"]:
                fail(400, "This message was deleted")
            if now() - m["created_at"] > cfg.edit_window_s * 1000:
                fail(400, "Messages can only be edited for a short time after sending")
            if not self.active_member(m["chat_id"], uid):
                fail(403, "You are not in this chat")
            payload = body.get("payload")
            if not isinstance(payload, str) or len(payload) > MAX_PAYLOAD:
                fail(400, "payload must be an encrypted envelope string")
            db.run("UPDATE messages SET payload = ?, sender_device = ?, edited_at = ? WHERE id = ?", payload, ctx.device["id"], now(), m["id"])
            updated = db.get("SELECT * FROM messages WHERE id = ?", m["id"])
            self.broadcast_message(updated, "message-update")
            return {"message": self.message_view(updated, uid)}

        @r.add("DELETE", "/api/messages/:id")
        async def delete_message(ctx: Context):
            uid = ctx.user["id"]
            m = self.require_message(ctx.params["id"], uid)
            if ctx.query.get("for") == "everyone":
                chat = self.get_chat(m["chat_id"])
                member = self.active_member(m["chat_id"], uid)
                as_admin = chat["type"] == "group" and member and member["role"] == "admin"
                if m["kind"] != "msg" or (m["sender_id"] != uid and not as_admin):
                    fail(403, "You can only delete your own messages for everyone")
                if m["sender_id"] == uid and now() - m["created_at"] > cfg.delete_window_s * 1000:
                    fail(400, "This message is too old to delete for everyone")
                self.wipe_message(m)
                db.run("UPDATE messages SET payload = NULL, files = '[]', deleted_at = ? WHERE id = ?", now(), m["id"])
                if chat["pinned_message"] == m["id"]:
                    db.run("UPDATE chats SET pinned_message = NULL WHERE id = ?", chat["id"])
                self.broadcast_message(db.get("SELECT * FROM messages WHERE id = ?", m["id"]), "message-update")
                self.broadcast_chat(m["chat_id"])
            else:
                db.run("INSERT OR IGNORE INTO hidden (user_id, message_id) VALUES (?, ?)", uid, m["id"])
                hub.send_to_user(uid, {"type": "message-gone", "chatId": m["chat_id"], "id": m["id"]})
            return {"ok": True}

        @r.add("POST", "/api/messages/:id/react")
        async def react(ctx: Context):
            body = await read_json(ctx.request)
            uid = ctx.user["id"]
            m = self.require_message(ctx.params["id"], uid)
            if not self.active_member(m["chat_id"], uid):
                fail(403, "You are not in this chat")
            if m["kind"] != "msg" or m["deleted_at"]:
                fail(400, "You can't react to this message")
            if body.get("emoji") is None:
                db.run("DELETE FROM reactions WHERE message_id = ? AND user_id = ?", m["id"], uid)
            else:
                emoji = v_str(body["emoji"], "emoji", max=32)
                if not is_emoji(emoji):
                    fail(400, "emoji must be a single emoji")
                db.run(
                    """INSERT INTO reactions (message_id, user_id, emoji, at) VALUES (?, ?, ?, ?)
                       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = excluded.emoji, at = excluded.at""",
                    m["id"], uid, emoji, now(),
                )
            self.broadcast_message(m, "message-update")
            return {"ok": True}

        @r.add("POST", "/api/messages/:id/star")
        async def star(ctx: Context):
            body = await read_json(ctx.request)
            uid = ctx.user["id"]
            m = self.require_message(ctx.params["id"], uid)
            if v_bool(body.get("starred"), "starred", optional=False):
                db.run("INSERT OR IGNORE INTO stars (user_id, message_id, at) VALUES (?, ?, ?)", uid, m["id"], now())
            else:
                db.run("DELETE FROM stars WHERE user_id = ? AND message_id = ?", uid, m["id"])
            hub.send_to_user(uid, {"type": "message-update", "message": self.message_view(m, uid)})
            return {"ok": True}

        # Poll options are encrypted; the server only stores the chosen indices.
        @r.add("POST", "/api/messages/:id/vote")
        async def vote(ctx: Context):
            body = await read_json(ctx.request)
            uid = ctx.user["id"]
            m = self.require_message(ctx.params["id"], uid)
            if not self.active_member(m["chat_id"], uid):
                fail(403, "You are not in this chat")
            if m["kind"] != "msg" or m["deleted_at"]:
                fail(400, "This poll was deleted")
            options = body.get("options")
            if (
                not isinstance(options, list) or len(options) > 12
                or not all(isinstance(o, int) and not isinstance(o, bool) and 0 <= o < 12 for o in options)
            ):
                fail(400, "options must be a list of option indices")
            options = sorted(set(options))
            if options:
                db.run(
                    """INSERT INTO poll_votes (message_id, user_id, options, at) VALUES (?, ?, ?, ?)
                       ON CONFLICT (message_id, user_id) DO UPDATE SET options = excluded.options, at = excluded.at""",
                    m["id"], uid, json.dumps(options), now(),
                )
            else:
                db.run("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?", m["id"], uid)
            self.broadcast_message(m, "message-update")
            return {"ok": True}

        @r.add("POST", "/api/messages/:id/opened")
        async def opened(ctx: Context):
            uid = ctx.user["id"]
            m = self.require_message(ctx.params["id"], uid)
            if not m["view_once"] or m["sender_id"] == uid:
                fail(400, "Not a view-once message for you")
            db.run("INSERT OR IGNORE INTO view_once_opened (message_id, user_id, at) VALUES (?, ?, ?)", m["id"], uid, now())
            self.broadcast_message(m, "message-update")
            return {"ok": True}

        @r.add("POST", "/api/chats/:id/pin")
        async def pin(ctx: Context):
            body = await read_json(ctx.request)
            uid = ctx.user["id"]
            chat, member = self.require_member(ctx.params["id"], uid)
            if chat["type"] == "group" and chat["admins_only_edit"] and member["role"] != "admin":
                fail(403, "Only admins can pin messages")
            message_id = None
            if body.get("messageId") is not None:
                m = self.require_message(v_str(body["messageId"], "messageId"), uid)
                if m["chat_id"] != chat["id"] or m["kind"] != "msg" or m["deleted_at"]:
                    fail(400, "You can't pin that message")
                message_id = m["id"]
            db.run("UPDATE chats SET pinned_message = ? WHERE id = ?", message_id, chat["id"])
            self.system_message(chat, uid, {"event": "pinned" if message_id else "unpinned", "messageId": message_id})
            self.broadcast_chat(chat["id"])
            return {"ok": True}

        @r.add("POST", "/api/chats/:id/receipts")
        async def receipts(ctx: Context):
            body = await read_json(ctx.request)
            uid = ctx.user["id"]
            chat, member = self.require_member(ctx.params["id"], uid, allow_former=True)
            ceiling = min(chat["last_seq"], member["left_seq"] if member["left_seq"] is not None else BIG)
            delivered = min(v_int(body.get("delivered"), "delivered", optional=True) or 0, ceiling)
            read = min(v_int(body.get("read"), "read", optional=True) or 0, ceiling)
            next_delivered = max(member["delivered_seq"], delivered, read)
            next_read = max(member["read_seq"], read)
            if next_delivered == member["delivered_seq"] and next_read == member["read_seq"] and not (read and member["marked_unread"]):
                return {"ok": True}
            db.run(
                """UPDATE members SET delivered_seq = ?, read_seq = ?,
                     marked_unread = CASE WHEN ? > 0 THEN 0 ELSE marked_unread END
                   WHERE chat_id = ? AND user_id = ?""",
                next_delivered, next_read, read, chat["id"], uid,
            )
            fresh = db.get("SELECT * FROM members WHERE chat_id = ? AND user_id = ?", chat["id"], uid)
            for other in self.ever_member_ids(chat["id"]):
                hub.send_to_user(other, {"type": "receipt", "chatId": chat["id"], "member": self.member_view(fresh, chat, other)})
            hub.send_to_user(uid, {"type": "chat", "chat": self.chat_view(chat, uid)})
            return {"ok": True}

        @r.add("GET", "/api/starred")
        async def starred(ctx: Context):
            uid = ctx.user["id"]
            rows = db.all(
                "SELECT m.* FROM stars s JOIN messages m ON m.id = s.message_id WHERE s.user_id = ? ORDER BY s.at DESC LIMIT 500",
                uid,
            )
            return {"messages": [self.message_view(m, uid) for m in rows if self.can_see_message(m, uid)]}

        # Files are uploaded as raw bytes. Message attachments are encrypted on
        # the device first, so the server stores ciphertext; ?public=1 is for
        # profile and group photos, which everyone on the tailnet may see.
        @r.add("POST", "/api/files")
        async def upload(ctx: Context):
            request = ctx.request
            length = request.content_length
            if length is None:
                fail(411, "Content-Length is required")
            if length > cfg.max_upload_bytes:
                fail(413, f"Files are limited to {cfg.max_upload_bytes // 1048576} MB")
            is_public = ctx.query.get("public") == "1"
            if is_public and length > 5 * 1024 * 1024:
                fail(413, "Photos are limited to 5 MB")
            if request.headers.get("Content-Type") != "application/octet-stream":
                fail(415, "Upload files as application/octet-stream")
            file_id = new_id()
            final = self.file_path(file_id)
            tmp = final.with_name(final.name + ".part")
            received = 0
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as out:
                    async for chunk in request.content.iter_chunked(1 << 20):
                        received += len(chunk)
                        if received > length:
                            fail(400, "Body longer than Content-Length")
                        out.write(chunk)
                if received != length:
                    fail(400, "Upload was cut short")
                tmp.rename(final)
            except BaseException:
                tmp.unlink(missing_ok=True)
                raise
            db.run(
                "INSERT INTO files (id, owner, size, public, created_at) VALUES (?, ?, ?, ?, ?)",
                file_id, ctx.user["id"], length, int(is_public), now(),
            )
            return {"id": file_id, "size": length}

        @r.add("GET", "/api/files/:id")
        async def download(ctx: Context):
            f = self.can_read_file(ctx.params["id"], ctx.user["id"])
            if not f:
                fail(404, "No such file")
            return self.file_response(f, "application/octet-stream")

        # Profile and group photos are loaded by <img> tags, which can't send
        # the device token, so these only need a tailnet identity.
        @r.add("GET", "/api/avatars/:id", device=False)
        async def avatar(ctx: Context):
            f = db.get("SELECT * FROM files WHERE id = ? AND public = 1", ctx.params["id"])
            if not f:
                fail(404, "No such photo")
            return self.file_response(f, sniff_image(self.file_path(f["id"])))

        # ---------- status (stories) ----------

        @r.add("GET", "/api/status")
        async def statuses(ctx: Context):
            uid = ctx.user["id"]
            rows = db.all("SELECT * FROM statuses WHERE expires_at > ? ORDER BY created_at", now())
            return {
                "statuses": [
                    self.status_view(s, uid) for s in rows if s["user_id"] == uid or not self.either_blocked(s["user_id"], uid)
                ]
            }

        # Status updates are encrypted to every logged-in device on the server
        # (everyone on the tailnet who uses Tailchat), like "My contacts" on WhatsApp.
        @r.add("GET", "/api/status/devices")
        async def status_devices(ctx: Context):
            return {"devices": [self.device_view(d) for d in db.all("SELECT * FROM devices WHERE revoked_at IS NULL")]}

        @r.add("POST", "/api/status")
        async def post_status(ctx: Context):
            body = await read_json(ctx.request, MAX_PAYLOAD + 64 * 1024)
            uid = ctx.user["id"]
            payload = body.get("payload")
            if not isinstance(payload, str) or len(payload) > MAX_PAYLOAD:
                fail(400, "payload must be an encrypted envelope string")
            files = self.check_files(body.get("files") or [], uid)
            status_id = new_id()
            created = now()
            with db.tx():
                db.run(
                    "INSERT INTO statuses (id, user_id, payload, files, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                    status_id, uid, payload, json.dumps(files), created, created + cfg.status_hours * 3600 * 1000,
                )
                for f in files:
                    db.run("INSERT INTO file_links (file_id, status_id) VALUES (?, ?)", f, status_id)
            s = db.get("SELECT * FROM statuses WHERE id = ?", status_id)
            for other in self.all_user_ids():
                if other == uid or not self.either_blocked(other, uid):
                    hub.send_to_user(other, {"type": "status", "status": self.status_view(s, other)})
            return {"status": self.status_view(s, uid)}

        @r.add("DELETE", "/api/status/:id")
        async def delete_status(ctx: Context):
            s = db.get("SELECT * FROM statuses WHERE id = ? AND user_id = ?", ctx.params["id"], ctx.user["id"])
            if not s:
                fail(404, "No such status")
            self._delete_status(s)
            return {"ok": True}

        @r.add("POST", "/api/status/:id/view")
        async def view_status(ctx: Context):
            uid = ctx.user["id"]
            s = db.get("SELECT * FROM statuses WHERE id = ? AND expires_at > ?", ctx.params["id"], now())
            if not s or self.either_blocked(s["user_id"], uid):
                fail(404, "No such status")
            if s["user_id"] == uid:
                return {"ok": True}
            # With read receipts off, your views aren't recorded (WhatsApp behaves the same).
            if db.get("SELECT read_receipts FROM users WHERE id = ?", uid)["read_receipts"]:
                db.run("INSERT OR IGNORE INTO status_views (status_id, viewer_id, at) VALUES (?, ?, ?)", s["id"], uid, now())
                hub.send_to_user(s["user_id"], {"type": "status", "status": self.status_view(s, s["user_id"])})
            return {"ok": True}

        # ---------- calls ----------

        @r.add("GET", "/api/calls")
        async def call_log(ctx: Context):
            rows = db.all(
                """SELECT c.* FROM calls c JOIN members m ON m.chat_id = c.chat_id AND m.user_id = ?
                   ORDER BY c.started_at DESC LIMIT 200""",
                ctx.user["id"],
            )
            return {
                "calls": [
                    {
                        "id": c["id"],
                        "chatId": c["chat_id"],
                        "callerId": c["caller_id"],
                        "video": bool(c["video"]),
                        "startedAt": c["started_at"],
                        "answeredAt": c["answered_at"],
                        "endedAt": c["ended_at"],
                        "participants": json.loads(c["participants"]),
                    }
                    for c in rows
                ]
            }

    def file_response(self, f: dict, content_type: str) -> web.StreamResponse:
        return web.FileResponse(
            self.file_path(f["id"]),
            headers={
                "Content-Type": content_type,
                "Cache-Control": "private, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'",
            },
        )

    # ---------- realtime ----------

    def presence_changed(self, user_id: str) -> None:
        u = self.db.get("SELECT * FROM users WHERE id = ?", user_id)
        for uid in self.all_user_ids():
            if uid != user_id:
                self.hub.send_to_user(uid, {"type": "user", "user": self.user_view(u, uid)})

    def _on_disconnect(self, user_id: str) -> None:
        self.db.run("UPDATE users SET last_seen = ? WHERE id = ?", now(), user_id)
        self.presence_changed(user_id)

    def _on_ws_message(self, sock: Socket, msg: dict) -> None:
        if msg.get("type") == "typing":
            chat_id = str(msg.get("chatId") or "")
            if not self.active_member(chat_id, sock.user_id):
                return
            kind = "recording" if msg.get("kind") == "recording" else "typing"
            for uid in self.active_member_ids(chat_id):
                if uid != sock.user_id and not self.either_blocked(uid, sock.user_id):
                    self.hub.send_to_user(uid, {"type": "typing", "chatId": chat_id, "userId": sock.user_id, "on": bool(msg.get("on")), "kind": kind})
        elif msg.get("type") == "call":
            self.handle_call_signal(sock, msg)

    # Signalling arrives over the WebSocket. Media flows device to device over
    # WebRTC, directly across the tailnet.
    def handle_call_signal(self, sock: Socket, msg: dict) -> None:  # noqa: C901
        db, hub = self.db, self.hub
        call_id = msg.get("callId")
        if not isinstance(call_id, str) or not call_id:
            return
        call_id = call_id[:40]
        user_id = sock.user_id
        action = msg.get("action")

        if action == "ring":
            chat_id = str(msg.get("chatId") or "")
            if not self.active_member(chat_id, user_id) or call_id in self.calls:
                return
            chat = self.get_chat(chat_id)
            others = [u for u in self.active_member_ids(chat_id) if u != user_id and not self.either_blocked(u, user_id)]
            if chat["type"] == "group" and len(others) > 7:
                sock.send(json.dumps({"type": "call", "action": "error", "callId": call_id, "message": "Group calls are limited to 8 people"}))
                return
            video = bool(msg.get("video"))
            self.calls[call_id] = {"chatId": chat_id, "video": video, "participants": {sock.device_id: user_id}, "invited": set(others)}
            db.run(
                "INSERT INTO calls (id, chat_id, caller_id, video, started_at, participants) VALUES (?, ?, ?, ?, ?, ?)",
                call_id, chat_id, user_id, int(video), now(), json.dumps([user_id]),
            )
            hub.send_to_users(others, {"type": "call", "action": "ring", "callId": call_id, "chatId": chat_id, "from": user_id, "video": video})

            # Unanswered calls stop ringing after 45 seconds.
            def timeout() -> None:
                c = self.calls.get(call_id)
                row = db.get("SELECT answered_at FROM calls WHERE id = ?", call_id)
                if c and len(c["participants"]) <= 1 and row and not row["answered_at"]:
                    self.end_call(call_id, "missed")

            asyncio.get_running_loop().call_later(45, timeout)
            return

        call = self.calls.get(call_id)
        if not call:
            sock.send(json.dumps({"type": "call", "action": "ended", "callId": call_id}))
            return
        participants: dict = call["participants"]

        if action == "accept":
            if user_id not in call["invited"] and user_id not in participants.values():
                return
            existing = [{"deviceId": d, "userId": u} for d, u in participants.items()]
            participants[sock.device_id] = user_id
            row = db.get("SELECT * FROM calls WHERE id = ?", call_id)
            people = list(dict.fromkeys([*json.loads(row["participants"]), user_id]))
            db.run("UPDATE calls SET answered_at = COALESCE(answered_at, ?), participants = ? WHERE id = ?", now(), json.dumps(people), call_id)
            # The newcomer sends an offer to everyone already in the call.
            sock.send(json.dumps({"type": "call", "action": "joined", "callId": call_id, "peers": existing, "video": call["video"]}))
            for p in existing:
                hub.send_to_user(p["userId"], {"type": "call", "action": "peer-joined", "callId": call_id, "userId": user_id, "deviceId": sock.device_id}, only_device=p["deviceId"])
            # Stop ringing on the user's other devices.
            hub.send_to_user(user_id, {"type": "call", "action": "answered-elsewhere", "callId": call_id}, except_device=sock.device_id)
            return

        if action == "decline":
            call["invited"].discard(user_id)
            hub.send_to_user(user_id, {"type": "call", "action": "answered-elsewhere", "callId": call_id}, except_device=sock.device_id)
            for device_id, uid in participants.items():
                hub.send_to_user(uid, {"type": "call", "action": "declined", "callId": call_id, "userId": user_id}, only_device=device_id)
            if not call["invited"] and len(participants) <= 1:
                self.end_call(call_id, "declined")
            return

        if sock.device_id not in participants:
            return
        if action == "signal":
            to_device = str(msg.get("toDevice"))
            target = participants.get(to_device)
            if not target or not isinstance(msg.get("data"), dict):
                return
            hub.send_to_user(
                target,
                {"type": "call", "action": "signal", "callId": call_id, "fromDevice": sock.device_id, "from": user_id, "data": msg["data"]},
                only_device=to_device,
            )
        elif action == "hangup":
            self._leave_call(call_id, sock.device_id)

    def _leave_call(self, call_id: str, device_id: str) -> None:
        call = self.calls.get(call_id)
        if not call:
            return
        participants = call["participants"]
        participants.pop(device_id, None)
        for d, uid in participants.items():
            self.hub.send_to_user(uid, {"type": "call", "action": "peer-left", "callId": call_id, "deviceId": device_id}, only_device=d)
        if len(participants) <= 1:
            self.end_call(call_id, "ended")

    def end_call(self, call_id: str, reason: str) -> None:
        call = self.calls.pop(call_id, None)
        if not call:
            return
        self.db.run("UPDATE calls SET ended_at = ? WHERE id = ?", now(), call_id)
        self.hub.send_to_users(self.active_member_ids(call["chatId"]), {"type": "call", "action": "ended", "callId": call_id, "reason": reason})

    def drop_device_from_calls(self, device_id: str) -> None:
        for call_id, call in list(self.calls.items()):
            if device_id in call["participants"]:
                self._leave_call(call_id, device_id)


def sniff_image(path: Path) -> str:
    with open(path, "rb") as fh:
        head = fh.read(12)
    if head[:2] == b"\xff\xd8":
        return "image/jpeg"
    if head[:4] == b"\x89PNG":
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:3] == b"GIF":
        return "image/gif"
    return "application/octet-stream"
