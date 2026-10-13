// REST API. Every request is tied to a tailnet identity; everything except
// registering a new device also needs that device's bearer token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, HttpError, fail, newId, sendJson, readJson, str, int, bool } from './http.js';

const MAX_PAYLOAD = 512 * 1024; // an encrypted message envelope, thumbnails included
const MAX_GROUP = 1024;
const EMOJI = /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Component}‍️]{0,15}$/u;
const hashToken = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

export function createApi({ db, hub, config }) {
  const router = new Router();
  const now = () => Date.now();
  const filePath = (id) => path.join(config.dataDir, 'files', id);
  const calls = new Map(); // callId -> { chatId, video, participants: Map<deviceId, userId> }

  // ---------- users & devices ----------

  function upsertUser(identity) {
    const existing = db.get('SELECT * FROM users WHERE id = ?', identity.login);
    if (existing) {
      if (identity.avatarUrl && identity.avatarUrl !== existing.tailscale_avatar) {
        db.run('UPDATE users SET tailscale_avatar = ? WHERE id = ?', identity.avatarUrl, identity.login);
        existing.tailscale_avatar = identity.avatarUrl;
      }
      return existing;
    }
    db.run(
      'INSERT INTO users (id, name, tailscale_avatar, created_at) VALUES (?, ?, ?, ?)',
      identity.login,
      identity.name.slice(0, 60) || identity.login,
      identity.avatarUrl,
      now(),
    );
    const user = db.get('SELECT * FROM users WHERE id = ?', identity.login);
    hub.sendToUsers(allUserIds(), { type: 'user', user: userView(user, null) });
    return user;
  }

  const allUserIds = () => db.all('SELECT id FROM users').map((r) => r.id);

  async function authenticateToken(token, identity) {
    if (typeof token !== 'string') throw new HttpError(401, 'Missing device token');
    const [deviceId, secret] = token.split('.');
    const device = deviceId && db.get('SELECT * FROM devices WHERE id = ?', deviceId);
    if (!device || !secret) throw new HttpError(401, 'Unknown device');
    const a = Buffer.from(device.token_hash, 'hex');
    const b = Buffer.from(hashToken(secret), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unknown device');
    if (device.revoked_at) throw new HttpError(401, 'This device was logged out');
    if (device.user_id !== identity.login) throw new HttpError(403, 'This device belongs to another tailnet user');
    db.run('UPDATE devices SET last_active = ? WHERE id = ?', now(), device.id);
    return device;
  }

  const isBlocked = (by, whom) => !!db.get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', by, whom);
  const eitherBlocked = (a, b) => isBlocked(a, b) || isBlocked(b, a);

  function userView(u, viewer) {
    const viewerRow = viewer && db.get('SELECT hide_last_seen FROM users WHERE id = ?', viewer);
    // Like WhatsApp: hiding your own last seen also hides everyone else's from you.
    const hidden = viewer !== u.id && (u.hide_last_seen || viewerRow?.hide_last_seen || (viewer && eitherBlocked(u.id, viewer)));
    return {
      id: u.id,
      name: u.name,
      about: u.about,
      avatar: u.avatar ? `/api/avatars/${u.avatar}` : u.tailscale_avatar,
      online: hidden ? null : hub.isOnline(u.id),
      lastSeen: hidden ? null : u.last_seen,
      ...(viewer === u.id ? { hideLastSeen: !!u.hide_last_seen, readReceipts: !!u.read_receipts } : {}),
      ...(viewer && viewer !== u.id ? { blocked: isBlocked(viewer, u.id) } : {}),
    };
  }

  const deviceView = (d) => ({
    id: d.id,
    userId: d.user_id,
    name: d.name,
    publicKey: JSON.parse(d.public_key),
    createdAt: d.created_at,
    lastActive: d.last_active,
    revokedAt: d.revoked_at,
  });

  // ---------- chats ----------

  function activeMember(chatId, userId) {
    const m = db.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', chatId, userId);
    return m && m.left_at === null ? m : null;
  }

  function requireMember(chatId, userId, { allowFormer = false } = {}) {
    const chat = db.get('SELECT * FROM chats WHERE id = ?', chatId);
    if (!chat) fail(404, 'No such chat');
    const member = db.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', chatId, userId);
    if (!member || (member.left_at !== null && !allowFormer)) fail(403, 'You are not in this chat');
    return { chat, member };
  }

  function requireAdmin(chatId, userId) {
    const ctx = requireMember(chatId, userId);
    if (ctx.chat.type !== 'group') fail(400, 'Only groups have admins');
    if (ctx.member.role !== 'admin') fail(403, 'Only group admins can do that');
    return ctx;
  }

  const activeMemberIds = (chatId) =>
    db.all('SELECT user_id FROM members WHERE chat_id = ? AND left_at IS NULL', chatId).map((r) => r.user_id);
  const everMemberIds = (chatId) => db.all('SELECT user_id FROM members WHERE chat_id = ?', chatId).map((r) => r.user_id);

  // Lowest seq a member may see, and the highest (former members keep what
  // they saw before leaving).
  const visibleFloor = (m) => Math.max(m.joined_seq, m.cleared_seq);

  function memberView(m, chat, viewer) {
    const user = db.get('SELECT read_receipts FROM users WHERE id = ?', m.user_id);
    const viewerUser = db.get('SELECT read_receipts FROM users WHERE id = ?', viewer);
    // Turning read receipts off works both ways, as on WhatsApp, except in groups.
    const hideRead = chat.type === 'direct' && m.user_id !== viewer && (!user?.read_receipts || !viewerUser?.read_receipts);
    return {
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      joinedSeq: m.joined_seq,
      left: m.left_at !== null,
      deliveredSeq: m.delivered_seq,
      readSeq: hideRead ? 0 : m.read_seq,
    };
  }

  function chatView(chat, viewer) {
    const me = db.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', chat.id, viewer);
    const members = db.all('SELECT * FROM members WHERE chat_id = ? ORDER BY joined_at', chat.id);
    const floor = visibleFloor(me);
    const ceiling = me.left_seq ?? Number.MAX_SAFE_INTEGER;
    const last = db.get(
      `SELECT * FROM messages WHERE chat_id = ? AND seq > ? AND seq <= ?
         AND id NOT IN (SELECT message_id FROM hidden WHERE user_id = ?)
       ORDER BY seq DESC LIMIT 1`,
      chat.id, floor, ceiling, viewer,
    );
    const unread = db.get(
      `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND kind = 'msg' AND sender_id != ?
         AND deleted_at IS NULL AND seq > ? AND seq <= ?`,
      chat.id, viewer, Math.max(floor, me.read_seq), ceiling,
    ).n;
    return {
      id: chat.id,
      type: chat.type,
      name: chat.name,
      description: chat.description,
      avatar: chat.avatar ? `/api/avatars/${chat.avatar}` : null,
      createdBy: chat.created_by,
      createdAt: chat.created_at,
      disappearing: chat.disappearing,
      adminsOnlySend: !!chat.admins_only_send,
      adminsOnlyEdit: !!chat.admins_only_edit,
      inviteCode: me.role === 'admin' && me.left_at === null ? chat.invite_code : null,
      pinnedMessage: chat.pinned_message,
      lastSeq: chat.last_seq,
      members: members.map((m) => memberView(m, chat, viewer)),
      me: {
        role: me.role,
        left: me.left_at !== null,
        joinedSeq: me.joined_seq,
        clearedSeq: me.cleared_seq,
        leftSeq: me.left_seq,
        readSeq: me.read_seq,
        pinnedAt: me.pinned_at,
        archived: !!me.archived,
        mutedUntil: me.muted_until,
        markedUnread: !!me.marked_unread,
      },
      unread,
      lastMessage: last ? messageView(last, viewer) : null,
    };
  }

  function messageView(m, viewer) {
    const opened = m.view_once && !!db.get('SELECT 1 FROM view_once_opened WHERE message_id = ? AND user_id = ?', m.id, viewer);
    return {
      id: m.id,
      chatId: m.chat_id,
      seq: m.seq,
      senderId: m.sender_id,
      senderDevice: m.sender_device,
      kind: m.kind,
      // A view-once message is gone for a recipient once they have opened it.
      payload: m.deleted_at || (opened && m.sender_id !== viewer) ? null : m.payload,
      files: JSON.parse(m.files),
      viewOnce: !!m.view_once,
      opened: m.view_once ? (m.sender_id === viewer ? openedBy(m.id) : opened) : undefined,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      expiresAt: m.expires_at,
      reactions: db.all('SELECT user_id AS userId, emoji FROM reactions WHERE message_id = ? ORDER BY at', m.id),
      votes: db.all('SELECT user_id AS userId, options FROM poll_votes WHERE message_id = ?', m.id).map((v) => ({
        userId: v.userId,
        options: JSON.parse(v.options),
      })),
      starred: !!db.get('SELECT 1 FROM stars WHERE user_id = ? AND message_id = ?', viewer, m.id),
    };
  }

  const openedBy = (messageId) =>
    db.all('SELECT user_id AS userId, at FROM view_once_opened WHERE message_id = ?', messageId);

  // Send each current member their own view of the chat (unread counts and
  // receipts differ per viewer).
  function broadcastChat(chatId, extraUserIds = []) {
    const chat = db.get('SELECT * FROM chats WHERE id = ?', chatId);
    for (const uid of new Set([...everMemberIds(chatId), ...extraUserIds])) {
      if (!db.get('SELECT 1 FROM members WHERE chat_id = ? AND user_id = ?', chatId, uid)) continue;
      hub.sendToUser(uid, { type: 'chat', chat: chatView(chat, uid) });
    }
  }

  function canSeeMessage(m, userId) {
    const member = db.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', m.chat_id, userId);
    if (!member) return false;
    return m.seq > visibleFloor(member) && (member.left_seq === null || m.seq <= member.left_seq);
  }

  function broadcastMessage(m, type = 'message', options = {}) {
    for (const uid of everMemberIds(m.chat_id)) {
      if (!canSeeMessage(m, uid)) continue;
      hub.sendToUser(uid, { type, message: messageView(m, uid) }, options);
    }
  }

  function insertMessage(chat, { id, senderId, senderDevice, kind, payload, files = [], viewOnce = false }) {
    return db.tx(() => {
      const seq = db.get('SELECT last_seq FROM chats WHERE id = ?', chat.id).last_seq + 1;
      db.run('UPDATE chats SET last_seq = ? WHERE id = ?', seq, chat.id);
      const created = now();
      const expires = chat.disappearing && kind === 'msg' ? created + chat.disappearing * 1000 : null;
      db.run(
        `INSERT INTO messages (id, chat_id, seq, sender_id, sender_device, kind, payload, files, view_once, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, chat.id, seq, senderId, senderDevice, kind, payload, JSON.stringify(files), viewOnce ? 1 : 0, created, expires,
      );
      for (const f of files) db.run('INSERT INTO file_links (file_id, message_id) VALUES (?, ?)', f, id);
      // A sender has read everything up to their own message.
      if (kind === 'msg') {
        db.run(
          'UPDATE members SET read_seq = ?, delivered_seq = ?, marked_unread = 0 WHERE chat_id = ? AND user_id = ?',
          seq, seq, chat.id, senderId,
        );
      }
      db.run('UPDATE members SET removed = 0 WHERE chat_id = ?', chat.id);
      return db.get('SELECT * FROM messages WHERE id = ?', id);
    });
  }

  function systemMessage(chat, actor, event) {
    const m = insertMessage(chat, { id: newId(), senderId: actor, senderDevice: null, kind: 'system', payload: JSON.stringify(event) });
    broadcastMessage(m);
    return m;
  }

  function addMembers(chat, actor, userIds) {
    const added = [];
    db.tx(() => {
      for (const uid of userIds) {
        if (!db.get('SELECT 1 FROM users WHERE id = ?', uid)) fail(400, `Unknown user ${uid}`);
        const existing = db.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', chat.id, uid);
        if (existing && existing.left_at === null) continue;
        const seq = db.get('SELECT last_seq FROM chats WHERE id = ?', chat.id).last_seq;
        if (existing) {
          db.run(
            `UPDATE members SET left_at = NULL, left_seq = NULL, role = 'member', joined_at = ?, joined_seq = ?,
               cleared_seq = ?, read_seq = ?, delivered_seq = ? WHERE chat_id = ? AND user_id = ?`,
            now(), seq, seq, seq, seq, chat.id, uid,
          );
        } else {
          db.run(
            `INSERT INTO members (chat_id, user_id, role, joined_at, joined_seq, read_seq, delivered_seq)
             VALUES (?, ?, 'member', ?, ?, ?, ?)`,
            chat.id, uid, now(), seq, seq, seq,
          );
        }
        added.push(uid);
      }
      const count = db.get('SELECT COUNT(*) AS n FROM members WHERE chat_id = ? AND left_at IS NULL', chat.id).n;
      if (count > MAX_GROUP) fail(400, `Groups are limited to ${MAX_GROUP} members`);
    });
    if (added.length) systemMessage(chat, actor, { event: actor === added[0] && added.length === 1 ? 'joined' : 'added', users: added });
    return added;
  }

  function removeMember(chat, actor, uid) {
    const seq = db.get('SELECT last_seq FROM chats WHERE id = ?', chat.id).last_seq;
    db.run('UPDATE members SET left_at = ?, left_seq = ?, role = ? WHERE chat_id = ? AND user_id = ?', now(), seq, 'member', chat.id, uid);
    systemMessage(chat, actor, { event: actor === uid ? 'left' : 'removed', users: [uid] });
    // Keep at least one admin, like WhatsApp: promote the longest-standing member.
    if (!db.get("SELECT 1 FROM members WHERE chat_id = ? AND left_at IS NULL AND role = 'admin'", chat.id)) {
      const next = db.get('SELECT user_id FROM members WHERE chat_id = ? AND left_at IS NULL ORDER BY joined_at LIMIT 1', chat.id);
      if (next) db.run("UPDATE members SET role = 'admin' WHERE chat_id = ? AND user_id = ?", chat.id, next.user_id);
    }
    broadcastChat(chat.id, [uid]);
  }

  // ---------- files ----------

  function canReadFile(fileId, userId) {
    const file = db.get('SELECT * FROM files WHERE id = ?', fileId);
    if (!file) return null;
    if (file.owner === userId || file.public) return file;
    for (const link of db.all('SELECT * FROM file_links WHERE file_id = ?', fileId)) {
      if (link.message_id) {
        const m = db.get('SELECT * FROM messages WHERE id = ?', link.message_id);
        if (!m || m.deleted_at || !canSeeMessage(m, userId)) continue;
        if (m.view_once && m.sender_id !== userId &&
            db.get('SELECT 1 FROM view_once_opened WHERE message_id = ? AND user_id = ?', m.id, userId)) continue;
        return file;
      }
      if (link.status_id) {
        const s = db.get('SELECT * FROM statuses WHERE id = ? AND expires_at > ?', link.status_id, now());
        if (s && !eitherBlocked(s.user_id, userId)) return file;
      }
    }
    return null;
  }

  function checkFiles(files, userId) {
    if (!Array.isArray(files) || files.length > 32) fail(400, 'files must be a list of up to 32 file ids');
    for (const f of files) {
      if (typeof f !== 'string' || !canReadFile(f, userId)) fail(400, 'Unknown file');
    }
    return [...new Set(files)];
  }

  function deleteOrphanFiles(ids) {
    for (const id of ids) {
      if (db.get('SELECT 1 FROM file_links WHERE file_id = ?', id)) continue;
      const f = db.get('SELECT public FROM files WHERE id = ?', id);
      if (!f || f.public) continue;
      db.run('DELETE FROM files WHERE id = ?', id);
      fs.rm(filePath(id), { force: true }, () => {});
    }
  }

  function wipeMessage(m) {
    const files = JSON.parse(m.files);
    db.run('DELETE FROM file_links WHERE message_id = ?', m.id);
    db.run('DELETE FROM reactions WHERE message_id = ?', m.id);
    db.run('DELETE FROM poll_votes WHERE message_id = ?', m.id);
    deleteOrphanFiles(files);
  }

  // ---------- periodic cleanup ----------

  function sweep() {
    const t = now();
    for (const m of db.all('SELECT * FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?', t)) {
      wipeMessage(m);
      db.run('DELETE FROM stars WHERE message_id = ?', m.id);
      db.run('DELETE FROM hidden WHERE message_id = ?', m.id);
      db.run('DELETE FROM view_once_opened WHERE message_id = ?', m.id);
      db.run('DELETE FROM messages WHERE id = ?', m.id);
      hub.sendToUsers(everMemberIds(m.chat_id), { type: 'message-gone', chatId: m.chat_id, id: m.id });
    }
    for (const s of db.all('SELECT * FROM statuses WHERE expires_at <= ?', t)) {
      db.run('DELETE FROM file_links WHERE status_id = ?', s.id);
      db.run('DELETE FROM status_views WHERE status_id = ?', s.id);
      db.run('DELETE FROM statuses WHERE id = ?', s.id);
      deleteOrphanFiles(JSON.parse(s.files));
      hub.sendToUsers(allUserIds(), { type: 'status-gone', id: s.id });
    }
    // Uploads that never made it into a message or status.
    const stale = db.all(
      'SELECT id FROM files WHERE public = 0 AND created_at < ? AND id NOT IN (SELECT file_id FROM file_links)',
      t - 24 * 3600 * 1000,
    );
    deleteOrphanFiles(stale.map((r) => r.id));
  }

  // ---------- routes ----------

  const route = (method, pattern, handler, options) => router.add(method, pattern, handler, options);
  const noDevice = { device: false };

  route('GET', '/api/me', async (ctx) => ({
    user: userView(ctx.user, ctx.user.id),
    device: ctx.device ? deviceView(ctx.device) : null,
    authMode: config.auth,
    limits: {
      maxUploadBytes: config.maxUploadBytes,
      editWindowSeconds: config.editWindowSeconds,
      deleteWindowSeconds: config.deleteWindowSeconds,
    },
  }), { device: 'optional' });

  route('PATCH', '/api/me', async (ctx) => {
    const body = await readJson(ctx.req);
    const name = str(body.name, 'name', { optional: true, min: 1, max: 60 });
    const about = str(body.about, 'about', { optional: true, max: 140 });
    const hide = bool(body.hideLastSeen, 'hideLastSeen');
    const receipts = bool(body.readReceipts, 'readReceipts');
    if (body.avatar !== undefined) {
      if (body.avatar !== null) {
        const f = db.get('SELECT * FROM files WHERE id = ? AND owner = ? AND public = 1', body.avatar, ctx.user.id);
        if (!f) fail(400, 'avatar must be a public image you uploaded');
      }
      db.run('UPDATE users SET avatar = ? WHERE id = ?', body.avatar, ctx.user.id);
    }
    if (name !== undefined) db.run('UPDATE users SET name = ? WHERE id = ?', name, ctx.user.id);
    if (about !== undefined) db.run('UPDATE users SET about = ? WHERE id = ?', about, ctx.user.id);
    if (hide !== undefined) db.run('UPDATE users SET hide_last_seen = ? WHERE id = ?', hide ? 1 : 0, ctx.user.id);
    if (receipts !== undefined) db.run('UPDATE users SET read_receipts = ? WHERE id = ?', receipts ? 1 : 0, ctx.user.id);
    const user = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    for (const uid of allUserIds()) hub.sendToUser(uid, { type: 'user', user: userView(user, uid) });
    return { user: userView(user, user.id) };
  });

  route('POST', '/api/devices', async (ctx) => {
    const body = await readJson(ctx.req);
    const name = str(body.name, 'name', { min: 1, max: 80 });
    const key = body.publicKey;
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || key.d) {
      fail(400, 'publicKey must be a P-256 public JWK');
    }
    const id = newId(12);
    const secret = newId(32);
    const publicKey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y });
    db.run(
      'INSERT INTO devices (id, user_id, name, public_key, token_hash, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, ctx.user.id, name, publicKey, hashToken(secret), now(), now(),
    );
    const device = db.get('SELECT * FROM devices WHERE id = ?', id);
    notifyDeviceChange(ctx.user.id);
    return { device: deviceView(device), token: `${id}.${secret}` };
  }, noDevice);

  function notifyDeviceChange(userId) {
    // Everyone who shares a chat with this user must encrypt for the new key set.
    const peers = db.all(
      `SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.chat_id = m2.chat_id
       WHERE m1.user_id = ? AND m2.left_at IS NULL`,
      userId,
    ).map((r) => r.user_id);
    hub.sendToUsers([userId, ...peers], { type: 'devices', userId });
  }

  route('GET', '/api/devices', async (ctx) => ({
    devices: db.all('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at', ctx.user.id).map(deviceView),
  }));

  route('DELETE', '/api/devices/:id', async (ctx) => {
    const d = db.get('SELECT * FROM devices WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
    if (!d) fail(404, 'No such device');
    db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), d.id);
    hub.revokeDevice(d.id);
    notifyDeviceChange(ctx.user.id);
    return { ok: true };
  });

  // Public keys of any devices, including logged-out ones, so old messages
  // from them still decrypt.
  route('GET', '/api/keys', async (ctx) => {
    const ids = (ctx.query.get('ids') || '').split(',').filter(Boolean).slice(0, 500);
    if (!ids.length) return { devices: [] };
    const rows = db.all(`SELECT * FROM devices WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    return { devices: rows.map(deviceView) };
  });

  route('GET', '/api/users', async (ctx) => ({
    users: db.all('SELECT * FROM users ORDER BY name COLLATE NOCASE').map((u) => userView(u, ctx.user.id)),
  }));

  route('GET', '/api/users/:id/devices', async (ctx) => ({
    devices: db.all('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at', ctx.params.id).map(deviceView),
  }));

  route('POST', '/api/blocks', async (ctx) => {
    const body = await readJson(ctx.req);
    const target = str(body.userId, 'userId');
    if (target === ctx.user.id) fail(400, 'You cannot block yourself');
    if (!db.get('SELECT 1 FROM users WHERE id = ?', target)) fail(404, 'No such user');
    db.run('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)', ctx.user.id, target);
    pushUserTo(target, ctx.user.id);
    pushUserTo(ctx.user.id, target);
    return { ok: true };
  });

  route('DELETE', '/api/blocks/:id', async (ctx) => {
    db.run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', ctx.user.id, ctx.params.id);
    pushUserTo(ctx.params.id, ctx.user.id);
    pushUserTo(ctx.user.id, ctx.params.id);
    return { ok: true };
  });

  function pushUserTo(subjectId, viewerId) {
    const u = db.get('SELECT * FROM users WHERE id = ?', subjectId);
    if (u) hub.sendToUser(viewerId, { type: 'user', user: userView(u, viewerId) });
  }

  route('GET', '/api/chats', async (ctx) => {
    const rows = db.all(
      `SELECT c.* FROM chats c JOIN members m ON m.chat_id = c.id WHERE m.user_id = ? AND m.removed = 0`,
      ctx.user.id,
    );
    return { chats: rows.map((c) => chatView(c, ctx.user.id)) };
  });

  route('GET', '/api/chats/:id', async (ctx) => {
    const { chat } = requireMember(ctx.params.id, ctx.user.id, { allowFormer: true });
    return { chat: chatView(chat, ctx.user.id) };
  });

  route('POST', '/api/chats/direct', async (ctx) => {
    const body = await readJson(ctx.req);
    const other = str(body.userId, 'userId');
    if (!db.get('SELECT 1 FROM users WHERE id = ?', other)) fail(404, 'No such user');
    const key = [ctx.user.id, other].sort().join('|');
    let chat = db.get('SELECT * FROM chats WHERE direct_key = ?', key);
    if (!chat) {
      const id = newId();
      db.tx(() => {
        db.run(
          "INSERT INTO chats (id, type, created_by, created_at, direct_key) VALUES (?, 'direct', ?, ?, ?)",
          id, ctx.user.id, now(), key,
        );
        for (const uid of new Set([ctx.user.id, other])) {
          db.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", id, uid, now());
        }
      });
      chat = db.get('SELECT * FROM chats WHERE id = ?', id);
    }
    db.run('UPDATE members SET removed = 0 WHERE chat_id = ? AND user_id = ?', chat.id, ctx.user.id);
    return { chat: chatView(chat, ctx.user.id) };
  });

  route('POST', '/api/chats/group', async (ctx) => {
    const body = await readJson(ctx.req);
    const name = str(body.name, 'name', { min: 1, max: 100 });
    const description = str(body.description, 'description', { optional: true, max: 2048 }) ?? '';
    if (!Array.isArray(body.members)) fail(400, 'members must be a list of user ids');
    const others = [...new Set(body.members.filter((m) => m !== ctx.user.id))];
    for (const uid of others) if (typeof uid !== 'string' || !db.get('SELECT 1 FROM users WHERE id = ?', uid)) fail(400, 'Unknown member');
    const avatar = body.avatar ? db.get('SELECT id FROM files WHERE id = ? AND public = 1', body.avatar)?.id : null;
    const id = newId();
    db.tx(() => {
      db.run(
        "INSERT INTO chats (id, type, name, description, avatar, created_by, created_at) VALUES (?, 'group', ?, ?, ?, ?, ?)",
        id, name, description, avatar, ctx.user.id, now(),
      );
      db.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)", id, ctx.user.id, now());
    });
    const chat = db.get('SELECT * FROM chats WHERE id = ?', id);
    systemMessage(chat, ctx.user.id, { event: 'created', name });
    if (others.length) addMembers(chat, ctx.user.id, others);
    broadcastChat(id);
    return { chat: chatView(db.get('SELECT * FROM chats WHERE id = ?', id), ctx.user.id) };
  });

  route('PATCH', '/api/chats/:id', async (ctx) => {
    const body = await readJson(ctx.req);
    const { chat, member } = requireMember(ctx.params.id, ctx.user.id);
    const isAdmin = member.role === 'admin';
    const changes = [];
    const groupInfo = body.name !== undefined || body.description !== undefined || body.avatar !== undefined;
    if (groupInfo) {
      if (chat.type !== 'group') fail(400, 'Only groups have a name, description and photo');
      if (chat.admins_only_edit && !isAdmin) fail(403, 'Only admins can edit this group\'s info');
    }
    if ((body.adminsOnlySend !== undefined || body.adminsOnlyEdit !== undefined) && !isAdmin) fail(403, 'Only admins can change group settings');
    if (body.name !== undefined) {
      db.run('UPDATE chats SET name = ? WHERE id = ?', str(body.name, 'name', { min: 1, max: 100 }), chat.id);
      changes.push({ event: 'renamed', name: body.name.trim() });
    }
    if (body.description !== undefined) {
      db.run('UPDATE chats SET description = ? WHERE id = ?', str(body.description, 'description', { max: 2048 }), chat.id);
      changes.push({ event: 'description' });
    }
    if (body.avatar !== undefined) {
      const avatar = body.avatar === null ? null : db.get('SELECT id FROM files WHERE id = ? AND public = 1', body.avatar)?.id;
      if (body.avatar !== null && !avatar) fail(400, 'avatar must be a public image');
      db.run('UPDATE chats SET avatar = ? WHERE id = ?', avatar, chat.id);
      changes.push({ event: 'photo' });
    }
    if (body.disappearing !== undefined) {
      const secs = int(body.disappearing, 'disappearing', { max: 90 * 86400 });
      if (chat.type === 'group' && chat.admins_only_edit && !isAdmin) fail(403, 'Only admins can change disappearing messages');
      db.run('UPDATE chats SET disappearing = ? WHERE id = ?', secs, chat.id);
      changes.push({ event: 'disappearing', seconds: secs });
    }
    for (const [field, column] of [['adminsOnlySend', 'admins_only_send'], ['adminsOnlyEdit', 'admins_only_edit']]) {
      if (body[field] === undefined) continue;
      const value = bool(body[field], field);
      db.run(`UPDATE chats SET ${column} = ? WHERE id = ?`, value ? 1 : 0, chat.id);
      changes.push({ event: 'settings', [field]: value });
    }
    for (const event of changes) systemMessage(db.get('SELECT * FROM chats WHERE id = ?', chat.id), ctx.user.id, event);
    broadcastChat(chat.id);
    return { chat: chatView(db.get('SELECT * FROM chats WHERE id = ?', chat.id), ctx.user.id) };
  });

  route('PATCH', '/api/chats/:id/prefs', async (ctx) => {
    const body = await readJson(ctx.req);
    const { chat } = requireMember(ctx.params.id, ctx.user.id, { allowFormer: true });
    const set = (column, value) => db.run(`UPDATE members SET ${column} = ? WHERE chat_id = ? AND user_id = ?`, value, chat.id, ctx.user.id);
    if (body.pinned !== undefined) {
      if (bool(body.pinned, 'pinned')) {
        const pinned = db.get('SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND pinned_at IS NOT NULL AND chat_id != ?', ctx.user.id, chat.id).n;
        if (pinned >= 3) fail(400, 'You can only pin up to 3 chats');
        set('pinned_at', now());
      } else set('pinned_at', null);
    }
    if (body.archived !== undefined) set('archived', bool(body.archived, 'archived') ? 1 : 0);
    if (body.mutedUntil !== undefined) set('muted_until', int(body.mutedUntil, 'mutedUntil'));
    if (body.markedUnread !== undefined) set('marked_unread', bool(body.markedUnread, 'markedUnread') ? 1 : 0);
    const view = chatView(chat, ctx.user.id);
    hub.sendToUser(ctx.user.id, { type: 'chat', chat: view });
    return { chat: view };
  });

  route('POST', '/api/chats/:id/clear', async (ctx) => {
    const { chat } = requireMember(ctx.params.id, ctx.user.id, { allowFormer: true });
    const seq = db.get('SELECT last_seq FROM chats WHERE id = ?', chat.id).last_seq;
    db.run('UPDATE members SET cleared_seq = ?, read_seq = MAX(read_seq, ?) WHERE chat_id = ? AND user_id = ?', seq, seq, chat.id, ctx.user.id);
    const view = chatView(chat, ctx.user.id);
    hub.sendToUser(ctx.user.id, { type: 'chat', chat: view });
    return { chat: view };
  });

  // "Delete chat": clears it and hides it until someone writes again. A
  // former group member's copy is removed for good.
  route('DELETE', '/api/chats/:id', async (ctx) => {
    const { chat, member } = requireMember(ctx.params.id, ctx.user.id, { allowFormer: true });
    if (chat.type === 'group' && member.left_at === null) fail(400, 'Exit the group before deleting it');
    const seq = db.get('SELECT last_seq FROM chats WHERE id = ?', chat.id).last_seq;
    if (member.left_at !== null) {
      db.run('DELETE FROM members WHERE chat_id = ? AND user_id = ?', chat.id, ctx.user.id);
    } else {
      db.run(
        'UPDATE members SET cleared_seq = ?, read_seq = MAX(read_seq, ?), removed = 1, pinned_at = NULL WHERE chat_id = ? AND user_id = ?',
        seq, seq, chat.id, ctx.user.id,
      );
    }
    hub.sendToUser(ctx.user.id, { type: 'chat-removed', chatId: chat.id });
    return { ok: true };
  });

  route('POST', '/api/chats/:id/members', async (ctx) => {
    const body = await readJson(ctx.req);
    const { chat } = requireAdmin(ctx.params.id, ctx.user.id);
    if (!Array.isArray(body.userIds) || !body.userIds.length) fail(400, 'userIds must be a non-empty list');
    const added = addMembers(chat, ctx.user.id, body.userIds.filter((u) => typeof u === 'string'));
    for (const uid of added) notifyDeviceChange(uid);
    broadcastChat(chat.id);
    return { added };
  });

  route('DELETE', '/api/chats/:id/members/:userId', async (ctx) => {
    const target = ctx.params.userId;
    const { chat } = target === ctx.user.id ? requireMember(ctx.params.id, ctx.user.id) : requireAdmin(ctx.params.id, ctx.user.id);
    if (chat.type !== 'group') fail(400, 'You can only leave groups');
    if (!activeMember(chat.id, target)) fail(404, 'Not a member');
    removeMember(chat, ctx.user.id, target);
    return { ok: true };
  });

  route('POST', '/api/chats/:id/admins', async (ctx) => {
    const body = await readJson(ctx.req);
    const { chat } = requireAdmin(ctx.params.id, ctx.user.id);
    const target = str(body.userId, 'userId');
    const admin = bool(body.admin, 'admin', { optional: false });
    if (!activeMember(chat.id, target)) fail(404, 'Not a member');
    if (!admin && db.get("SELECT COUNT(*) AS n FROM members WHERE chat_id = ? AND left_at IS NULL AND role = 'admin'", chat.id).n <= 1) {
      fail(400, 'A group needs at least one admin');
    }
    db.run('UPDATE members SET role = ? WHERE chat_id = ? AND user_id = ?', admin ? 'admin' : 'member', chat.id, target);
    systemMessage(chat, ctx.user.id, { event: admin ? 'promoted' : 'demoted', users: [target] });
    broadcastChat(chat.id);
    return { ok: true };
  });

  route('POST', '/api/chats/:id/invite', async (ctx) => {
    const { chat } = requireAdmin(ctx.params.id, ctx.user.id);
    const code = newId(12);
    db.run('UPDATE chats SET invite_code = ? WHERE id = ?', code, chat.id);
    broadcastChat(chat.id);
    return { code };
  });

  route('DELETE', '/api/chats/:id/invite', async (ctx) => {
    const { chat } = requireAdmin(ctx.params.id, ctx.user.id);
    db.run('UPDATE chats SET invite_code = NULL WHERE id = ?', chat.id);
    broadcastChat(chat.id);
    return { ok: true };
  });

  route('GET', '/api/invite/:code', async (ctx) => {
    const chat = db.get('SELECT * FROM chats WHERE invite_code = ?', ctx.params.code);
    if (!chat) fail(404, 'This invite link was reset or never existed');
    return {
      chat: {
        id: chat.id,
        name: chat.name,
        description: chat.description,
        avatar: chat.avatar ? `/api/avatars/${chat.avatar}` : null,
        memberCount: activeMemberIds(chat.id).length,
        isMember: !!activeMember(chat.id, ctx.user.id),
      },
    };
  });

  route('POST', '/api/invite/:code/join', async (ctx) => {
    const chat = db.get('SELECT * FROM chats WHERE invite_code = ?', ctx.params.code);
    if (!chat) fail(404, 'This invite link was reset or never existed');
    addMembers(chat, ctx.user.id, [ctx.user.id]);
    notifyDeviceChange(ctx.user.id);
    broadcastChat(chat.id);
    return { chat: chatView(chat, ctx.user.id) };
  });

  // Every logged-in device of every current member: the sender wraps the
  // message key once for each of them.
  route('GET', '/api/chats/:id/devices', async (ctx) => {
    const { chat } = requireMember(ctx.params.id, ctx.user.id);
    const rows = db.all(
      `SELECT d.* FROM devices d JOIN members m ON m.user_id = d.user_id
       WHERE m.chat_id = ? AND m.left_at IS NULL AND d.revoked_at IS NULL`,
      chat.id,
    );
    return { devices: rows.map(deviceView) };
  });

  route('GET', '/api/chats/:id/messages', async (ctx) => {
    const { chat, member } = requireMember(ctx.params.id, ctx.user.id, { allowFormer: true });
    const limit = Math.min(Number.parseInt(ctx.query.get('limit') || '50', 10) || 50, 200);
    const before = Number.parseInt(ctx.query.get('before') || '0', 10);
    const after = Number.parseInt(ctx.query.get('after') || '0', 10);
    const floor = Math.max(visibleFloor(member), after || 0);
    const ceiling = Math.min(member.left_seq ?? Number.MAX_SAFE_INTEGER, before ? before - 1 : Number.MAX_SAFE_INTEGER);
    const order = after ? 'ASC' : 'DESC';
    const rows = db.all(
      `SELECT * FROM messages WHERE chat_id = ? AND seq > ? AND seq <= ?
         AND id NOT IN (SELECT message_id FROM hidden WHERE user_id = ?)
       ORDER BY seq ${order} LIMIT ?`,
      chat.id, floor, ceiling, ctx.user.id, limit,
    );
    if (order === 'DESC') rows.reverse();
    return { messages: rows.map((m) => messageView(m, ctx.user.id)), hasMore: rows.length === limit };
  });

  route('POST', '/api/chats/:id/messages', async (ctx) => {
    const body = await readJson(ctx.req, MAX_PAYLOAD + 64 * 1024);
    const { chat, member } = requireMember(ctx.params.id, ctx.user.id);
    if (chat.type === 'group' && chat.admins_only_send && member.role !== 'admin') fail(403, 'Only admins can send messages to this group');
    if (chat.type === 'direct') {
      const other = activeMemberIds(chat.id).find((u) => u !== ctx.user.id);
      if (other && isBlocked(ctx.user.id, other)) fail(403, 'Unblock this contact to send a message');
      if (other && isBlocked(other, ctx.user.id)) fail(403, 'You can\'t message this contact');
    }
    if (typeof body.payload !== 'string' || body.payload.length > MAX_PAYLOAD) fail(400, 'payload must be an encrypted envelope string');
    const id = body.id === undefined ? newId() : str(body.id, 'id', { min: 16, max: 32 });
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(400, 'id must be base64url');
    const existing = db.get('SELECT * FROM messages WHERE id = ?', id);
    // Retrying a send after a dropped connection must not duplicate it.
    if (existing) {
      if (existing.sender_id !== ctx.user.id) fail(409, 'Message id already in use');
      return { message: messageView(existing, ctx.user.id) };
    }
    const files = checkFiles(body.files ?? [], ctx.user.id);
    const m = insertMessage(chat, {
      id,
      senderId: ctx.user.id,
      senderDevice: ctx.device.id,
      kind: 'msg',
      payload: body.payload,
      files,
      viewOnce: body.viewOnce === true,
    });
    broadcastMessage(m);
    broadcastChatSummary(chat.id);
    return { message: messageView(m, ctx.user.id) };
  });

  // Members' chat lists need fresh unread counts and previews.
  const broadcastChatSummary = (chatId) => broadcastChat(chatId);

  function requireMessage(id, userId) {
    const m = db.get('SELECT * FROM messages WHERE id = ?', id);
    if (!m || !canSeeMessage(m, userId)) fail(404, 'No such message');
    return m;
  }

  route('PUT', '/api/messages/:id', async (ctx) => {
    const body = await readJson(ctx.req, MAX_PAYLOAD + 64 * 1024);
    const m = requireMessage(ctx.params.id, ctx.user.id);
    if (m.sender_id !== ctx.user.id || m.kind !== 'msg') fail(403, 'You can only edit your own messages');
    if (m.deleted_at) fail(400, 'This message was deleted');
    if (now() - m.created_at > config.editWindowSeconds * 1000) fail(400, 'Messages can only be edited for a short time after sending');
    if (!activeMember(m.chat_id, ctx.user.id)) fail(403, 'You are not in this chat');
    if (typeof body.payload !== 'string' || body.payload.length > MAX_PAYLOAD) fail(400, 'payload must be an encrypted envelope string');
    db.run('UPDATE messages SET payload = ?, sender_device = ?, edited_at = ? WHERE id = ?', body.payload, ctx.device.id, now(), m.id);
    const updated = db.get('SELECT * FROM messages WHERE id = ?', m.id);
    broadcastMessage(updated, 'message-update');
    return { message: messageView(updated, ctx.user.id) };
  });

  route('DELETE', '/api/messages/:id', async (ctx) => {
    const m = requireMessage(ctx.params.id, ctx.user.id);
    if (ctx.query.get('for') === 'everyone') {
      const chat = db.get('SELECT * FROM chats WHERE id = ?', m.chat_id);
      const member = activeMember(m.chat_id, ctx.user.id);
      const asAdmin = chat.type === 'group' && member?.role === 'admin';
      if (m.kind !== 'msg' || (m.sender_id !== ctx.user.id && !asAdmin)) fail(403, 'You can only delete your own messages for everyone');
      if (m.sender_id === ctx.user.id && now() - m.created_at > config.deleteWindowSeconds * 1000) {
        fail(400, 'This message is too old to delete for everyone');
      }
      wipeMessage(m);
      db.run('UPDATE messages SET payload = NULL, files = ?, deleted_at = ? WHERE id = ?', '[]', now(), m.id);
      if (chat.pinned_message === m.id) db.run('UPDATE chats SET pinned_message = NULL WHERE id = ?', chat.id);
      const updated = db.get('SELECT * FROM messages WHERE id = ?', m.id);
      broadcastMessage({ ...updated, deleted_by: ctx.user.id }, 'message-update');
      broadcastChatSummary(m.chat_id);
    } else {
      db.run('INSERT OR IGNORE INTO hidden (user_id, message_id) VALUES (?, ?)', ctx.user.id, m.id);
      hub.sendToUser(ctx.user.id, { type: 'message-gone', chatId: m.chat_id, id: m.id });
    }
    return { ok: true };
  });

  route('POST', '/api/messages/:id/react', async (ctx) => {
    const body = await readJson(ctx.req);
    const m = requireMessage(ctx.params.id, ctx.user.id);
    if (!activeMember(m.chat_id, ctx.user.id)) fail(403, 'You are not in this chat');
    if (m.kind !== 'msg' || m.deleted_at) fail(400, 'You can\'t react to this message');
    if (body.emoji === null) {
      db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ?', m.id, ctx.user.id);
    } else {
      const emoji = str(body.emoji, 'emoji', { max: 32 });
      if (!EMOJI.test(emoji)) fail(400, 'emoji must be a single emoji');
      db.run(
        'INSERT INTO reactions (message_id, user_id, emoji, at) VALUES (?, ?, ?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = excluded.emoji, at = excluded.at',
        m.id, ctx.user.id, emoji, now(),
      );
    }
    broadcastMessage(m, 'message-update');
    return { ok: true };
  });

  route('POST', '/api/messages/:id/star', async (ctx) => {
    const body = await readJson(ctx.req);
    const m = requireMessage(ctx.params.id, ctx.user.id);
    if (bool(body.starred, 'starred', { optional: false })) {
      db.run('INSERT OR IGNORE INTO stars (user_id, message_id, at) VALUES (?, ?, ?)', ctx.user.id, m.id, now());
    } else {
      db.run('DELETE FROM stars WHERE user_id = ? AND message_id = ?', ctx.user.id, m.id);
    }
    hub.sendToUser(ctx.user.id, { type: 'message-update', message: messageView(m, ctx.user.id) });
    return { ok: true };
  });

  // Poll options are encrypted; the server only stores the chosen indices.
  route('POST', '/api/messages/:id/vote', async (ctx) => {
    const body = await readJson(ctx.req);
    const m = requireMessage(ctx.params.id, ctx.user.id);
    if (!activeMember(m.chat_id, ctx.user.id)) fail(403, 'You are not in this chat');
    if (m.kind !== 'msg' || m.deleted_at) fail(400, 'This poll was deleted');
    if (!Array.isArray(body.options) || body.options.length > 12 || !body.options.every((o) => Number.isInteger(o) && o >= 0 && o < 12)) {
      fail(400, 'options must be a list of option indices');
    }
    const options = [...new Set(body.options)].sort((a, b) => a - b);
    if (options.length) {
      db.run(
        'INSERT INTO poll_votes (message_id, user_id, options, at) VALUES (?, ?, ?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET options = excluded.options, at = excluded.at',
        m.id, ctx.user.id, JSON.stringify(options), now(),
      );
    } else {
      db.run('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?', m.id, ctx.user.id);
    }
    broadcastMessage(m, 'message-update');
    return { ok: true };
  });

  route('POST', '/api/messages/:id/opened', async (ctx) => {
    const m = requireMessage(ctx.params.id, ctx.user.id);
    if (!m.view_once || m.sender_id === ctx.user.id) fail(400, 'Not a view-once message for you');
    db.run('INSERT OR IGNORE INTO view_once_opened (message_id, user_id, at) VALUES (?, ?, ?)', m.id, ctx.user.id, now());
    broadcastMessage(m, 'message-update');
    return { ok: true };
  });

  route('POST', '/api/chats/:id/pin', async (ctx) => {
    const body = await readJson(ctx.req);
    const { chat, member } = requireMember(ctx.params.id, ctx.user.id);
    if (chat.type === 'group' && chat.admins_only_edit && member.role !== 'admin') fail(403, 'Only admins can pin messages');
    let messageId = null;
    if (body.messageId !== null) {
      const m = requireMessage(str(body.messageId, 'messageId'), ctx.user.id);
      if (m.chat_id !== chat.id || m.kind !== 'msg' || m.deleted_at) fail(400, 'You can\'t pin that message');
      messageId = m.id;
    }
    db.run('UPDATE chats SET pinned_message = ? WHERE id = ?', messageId, chat.id);
    systemMessage(chat, ctx.user.id, { event: messageId ? 'pinned' : 'unpinned', messageId });
    broadcastChat(chat.id);
    return { ok: true };
  });

  route('POST', '/api/chats/:id/receipts', async (ctx) => {
    const body = await readJson(ctx.req);
    const { chat, member } = requireMember(ctx.params.id, ctx.user.id, { allowFormer: true });
    const ceiling = Math.min(chat.last_seq, member.left_seq ?? Number.MAX_SAFE_INTEGER);
    const delivered = Math.min(int(body.delivered, 'delivered', { optional: true }) ?? 0, ceiling);
    const read = Math.min(int(body.read, 'read', { optional: true }) ?? 0, ceiling);
    const nextDelivered = Math.max(member.delivered_seq, delivered, read);
    const nextRead = Math.max(member.read_seq, read);
    if (nextDelivered === member.delivered_seq && nextRead === member.read_seq && !(read && member.marked_unread)) return { ok: true };
    db.run(
      'UPDATE members SET delivered_seq = ?, read_seq = ?, marked_unread = CASE WHEN ? > 0 THEN 0 ELSE marked_unread END WHERE chat_id = ? AND user_id = ?',
      nextDelivered, nextRead, read, chat.id, ctx.user.id,
    );
    const fresh = db.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', chat.id, ctx.user.id);
    for (const uid of everMemberIds(chat.id)) {
      hub.sendToUser(uid, { type: 'receipt', chatId: chat.id, member: memberView(fresh, chat, uid) });
    }
    hub.sendToUser(ctx.user.id, { type: 'chat', chat: chatView(chat, ctx.user.id) });
    return { ok: true };
  });

  route('GET', '/api/starred', async (ctx) => {
    const rows = db.all(
      'SELECT m.* FROM stars s JOIN messages m ON m.id = s.message_id WHERE s.user_id = ? ORDER BY s.at DESC LIMIT 500',
      ctx.user.id,
    );
    return { messages: rows.filter((m) => canSeeMessage(m, ctx.user.id)).map((m) => messageView(m, ctx.user.id)) };
  });

  // Files are uploaded as raw bytes. Message attachments are encrypted in the
  // browser first, so the server stores ciphertext; ?public=1 is for profile
  // and group photos, which everyone on the tailnet may see.
  route('POST', '/api/files', async (ctx) => {
    const length = Number.parseInt(ctx.req.headers['content-length'] || '', 10);
    if (!Number.isFinite(length)) fail(411, 'Content-Length is required');
    if (length > config.maxUploadBytes) fail(413, `Files are limited to ${Math.round(config.maxUploadBytes / 1048576)} MB`);
    const isPublic = ctx.query.get('public') === '1';
    if (isPublic && length > 5 * 1024 * 1024) fail(413, 'Photos are limited to 5 MB');
    const type = ctx.req.headers['content-type'] || '';
    if (type !== 'application/octet-stream') fail(415, 'Upload files as application/octet-stream');
    const id = newId();
    const tmp = `${filePath(id)}.part`;
    let received = 0;
    try {
      await pipeline(
        ctx.req,
        async function* (source) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > length) throw new HttpError(400, 'Body longer than Content-Length');
            yield chunk;
          }
        },
        fs.createWriteStream(tmp, { mode: 0o600 }),
      );
      if (received !== length) fail(400, 'Upload was cut short');
      fs.renameSync(tmp, filePath(id));
    } catch (err) {
      fs.rm(tmp, { force: true }, () => {});
      throw err;
    }
    db.run('INSERT INTO files (id, owner, size, public, created_at) VALUES (?, ?, ?, ?, ?)', id, ctx.user.id, length, isPublic ? 1 : 0, now());
    return { id, size: length };
  });

  route('GET', '/api/files/:id', async (ctx) => {
    const file = canReadFile(ctx.params.id, ctx.user.id);
    if (!file) fail(404, 'No such file');
    streamFile(ctx, file);
  });

  // Profile and group photos are loaded by <img> tags, which can't send the
  // device token, so these only need a tailnet identity.
  route('GET', '/api/avatars/:id', async (ctx) => {
    const file = db.get('SELECT * FROM files WHERE id = ? AND public = 1', ctx.params.id);
    if (!file) fail(404, 'No such photo');
    streamFile(ctx, file, 'image/*');
  }, noDevice);

  function streamFile(ctx, file, type = 'application/octet-stream') {
    ctx.res.writeHead(200, {
      'Content-Type': type === 'image/*' ? sniffImage(filePath(file.id)) : type,
      'Content-Length': file.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    fs.createReadStream(filePath(file.id)).pipe(ctx.res);
    ctx.streamed = true;
  }

  function sniffImage(p) {
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
    if (head.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
    if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    if (head.subarray(0, 3).toString() === 'GIF') return 'image/gif';
    return 'application/octet-stream';
  }

  // ---------- status (stories) ----------

  route('GET', '/api/status', async (ctx) => {
    const rows = db.all('SELECT * FROM statuses WHERE expires_at > ? ORDER BY created_at', now());
    const statuses = rows
      .filter((s) => s.user_id === ctx.user.id || !eitherBlocked(s.user_id, ctx.user.id))
      .map((s) => statusView(s, ctx.user.id));
    return { statuses };
  });

  function statusView(s, viewer) {
    return {
      id: s.id,
      userId: s.user_id,
      payload: s.payload,
      files: JSON.parse(s.files),
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      seen: !!db.get('SELECT 1 FROM status_views WHERE status_id = ? AND viewer_id = ?', s.id, viewer),
      ...(s.user_id === viewer
        ? { viewers: db.all('SELECT viewer_id AS userId, at FROM status_views WHERE status_id = ? ORDER BY at DESC', s.id) }
        : {}),
    };
  }

  // Status updates are encrypted to every logged-in device on the server
  // (everyone on the tailnet who uses Tailchat), like "My contacts" on WhatsApp.
  route('GET', '/api/status/devices', async () => ({
    devices: db.all('SELECT * FROM devices WHERE revoked_at IS NULL').map(deviceView),
  }));

  route('POST', '/api/status', async (ctx) => {
    const body = await readJson(ctx.req, MAX_PAYLOAD + 64 * 1024);
    if (typeof body.payload !== 'string' || body.payload.length > MAX_PAYLOAD) fail(400, 'payload must be an encrypted envelope string');
    const files = checkFiles(body.files ?? [], ctx.user.id);
    const id = newId();
    const created = now();
    db.tx(() => {
      db.run(
        'INSERT INTO statuses (id, user_id, payload, files, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, ctx.user.id, body.payload, JSON.stringify(files), created, created + config.statusHours * 3600 * 1000,
      );
      for (const f of files) db.run('INSERT INTO file_links (file_id, status_id) VALUES (?, ?)', f, id);
    });
    const s = db.get('SELECT * FROM statuses WHERE id = ?', id);
    for (const uid of allUserIds()) {
      if (uid === ctx.user.id || !eitherBlocked(uid, ctx.user.id)) hub.sendToUser(uid, { type: 'status', status: statusView(s, uid) });
    }
    return { status: statusView(s, ctx.user.id) };
  });

  route('DELETE', '/api/status/:id', async (ctx) => {
    const s = db.get('SELECT * FROM statuses WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
    if (!s) fail(404, 'No such status');
    db.run('DELETE FROM file_links WHERE status_id = ?', s.id);
    db.run('DELETE FROM status_views WHERE status_id = ?', s.id);
    db.run('DELETE FROM statuses WHERE id = ?', s.id);
    deleteOrphanFiles(JSON.parse(s.files));
    hub.sendToUsers(allUserIds(), { type: 'status-gone', id: s.id });
    return { ok: true };
  });

  route('POST', '/api/status/:id/view', async (ctx) => {
    const s = db.get('SELECT * FROM statuses WHERE id = ? AND expires_at > ?', ctx.params.id, now());
    if (!s || eitherBlocked(s.user_id, ctx.user.id)) fail(404, 'No such status');
    if (s.user_id === ctx.user.id) return { ok: true };
    const viewer = db.get('SELECT read_receipts FROM users WHERE id = ?', ctx.user.id);
    // With read receipts off, your views aren't recorded (WhatsApp behaves the same).
    if (viewer.read_receipts) {
      db.run('INSERT OR IGNORE INTO status_views (status_id, viewer_id, at) VALUES (?, ?, ?)', s.id, ctx.user.id, now());
      hub.sendToUser(s.user_id, { type: 'status', status: statusView(s, s.user_id) });
    }
    return { ok: true };
  });

  // ---------- calls ----------

  route('GET', '/api/calls', async (ctx) => {
    const rows = db.all(
      `SELECT c.* FROM calls c JOIN members m ON m.chat_id = c.chat_id AND m.user_id = ?
       ORDER BY c.started_at DESC LIMIT 200`,
      ctx.user.id,
    );
    return {
      calls: rows.map((c) => ({
        id: c.id,
        chatId: c.chat_id,
        callerId: c.caller_id,
        video: !!c.video,
        startedAt: c.started_at,
        answeredAt: c.answered_at,
        endedAt: c.ended_at,
        participants: JSON.parse(c.participants),
      })),
    };
  });

  // Signalling arrives over the WebSocket. Media flows device to device over
  // WebRTC, directly across the tailnet.
  function handleCallSignal(ws, msg) {
    const callId = typeof msg.callId === 'string' ? msg.callId.slice(0, 40) : null;
    if (!callId) return;
    const userId = ws.userId;
    if (msg.action === 'ring') {
      const chatId = String(msg.chatId || '');
      if (!activeMember(chatId, userId) || calls.has(callId)) return;
      const chat = db.get('SELECT * FROM chats WHERE id = ?', chatId);
      const others = activeMemberIds(chatId).filter((u) => u !== userId && !eitherBlocked(u, userId));
      if (chat.type === 'group' && others.length > 7) {
        ws.send(JSON.stringify({ type: 'call', action: 'error', callId, message: 'Group calls are limited to 8 people' }));
        return;
      }
      const call = { chatId, video: !!msg.video, participants: new Map([[ws.deviceId, userId]]), invited: new Set(others) };
      calls.set(callId, call);
      db.run(
        'INSERT INTO calls (id, chat_id, caller_id, video, started_at, participants) VALUES (?, ?, ?, ?, ?, ?)',
        callId, chatId, userId, call.video ? 1 : 0, now(), JSON.stringify([userId]),
      );
      hub.sendToUsers(others, { type: 'call', action: 'ring', callId, chatId, from: userId, video: call.video });
      // Unanswered calls stop ringing after 45 seconds.
      setTimeout(() => {
        const c = calls.get(callId);
        if (c && c.participants.size <= 1 && !db.get('SELECT answered_at FROM calls WHERE id = ?', callId).answered_at) endCall(callId, 'missed');
      }, 45_000).unref();
      return;
    }
    const call = calls.get(callId);
    if (!call) {
      ws.send(JSON.stringify({ type: 'call', action: 'ended', callId }));
      return;
    }
    if (msg.action === 'accept') {
      if (!call.invited.has(userId) && ![...call.participants.values()].includes(userId)) return;
      const existing = [...call.participants.entries()].map(([deviceId, uid]) => ({ deviceId, userId: uid }));
      call.participants.set(ws.deviceId, userId);
      const row = db.get('SELECT * FROM calls WHERE id = ?', callId);
      const people = new Set(JSON.parse(row.participants));
      people.add(userId);
      db.run('UPDATE calls SET answered_at = COALESCE(answered_at, ?), participants = ? WHERE id = ?', now(), JSON.stringify([...people]), callId);
      // The newcomer sends an offer to everyone already in the call.
      ws.send(JSON.stringify({ type: 'call', action: 'joined', callId, peers: existing, video: call.video }));
      for (const p of existing) hub.sendToUser(p.userId, { type: 'call', action: 'peer-joined', callId, userId, deviceId: ws.deviceId }, { onlyDevice: p.deviceId });
      // Stop ringing on the user's other devices.
      hub.sendToUser(userId, { type: 'call', action: 'answered-elsewhere', callId }, { exceptDevice: ws.deviceId });
      return;
    }
    if (msg.action === 'decline') {
      call.invited.delete(userId);
      hub.sendToUser(userId, { type: 'call', action: 'answered-elsewhere', callId }, { exceptDevice: ws.deviceId });
      for (const [deviceId, uid] of call.participants) hub.sendToUser(uid, { type: 'call', action: 'declined', callId, userId }, { onlyDevice: deviceId });
      if (call.invited.size === 0 && call.participants.size <= 1) endCall(callId, 'declined');
      return;
    }
    if (!call.participants.has(ws.deviceId)) return;
    if (msg.action === 'signal') {
      const target = call.participants.get(String(msg.toDevice));
      if (!target || typeof msg.data !== 'object' || msg.data === null) return;
      hub.sendToUser(target, { type: 'call', action: 'signal', callId, fromDevice: ws.deviceId, from: userId, data: msg.data }, { onlyDevice: String(msg.toDevice) });
      return;
    }
    if (msg.action === 'hangup') {
      call.participants.delete(ws.deviceId);
      for (const [deviceId, uid] of call.participants) hub.sendToUser(uid, { type: 'call', action: 'peer-left', callId, deviceId: ws.deviceId }, { onlyDevice: deviceId });
      if (call.participants.size <= 1) endCall(callId, 'ended');
    }
  }

  function endCall(callId, reason) {
    const call = calls.get(callId);
    if (!call) return;
    calls.delete(callId);
    db.run('UPDATE calls SET ended_at = ? WHERE id = ?', now(), callId);
    hub.sendToUsers(activeMemberIds(call.chatId), { type: 'call', action: 'ended', callId, reason });
  }

  function dropDeviceFromCalls(deviceId) {
    for (const [callId, call] of calls) {
      if (!call.participants.has(deviceId)) continue;
      call.participants.delete(deviceId);
      for (const [d, uid] of call.participants) hub.sendToUser(uid, { type: 'call', action: 'peer-left', callId, deviceId }, { onlyDevice: d });
      if (call.participants.size <= 1) endCall(callId, 'ended');
    }
  }

  // ---------- realtime ----------

  function presenceChanged(userId) {
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    for (const uid of allUserIds()) {
      if (uid !== userId) hub.sendToUser(uid, { type: 'user', user: userView(u, uid) });
    }
  }

  hub.onConnect = (userId) => presenceChanged(userId);
  hub.onDisconnect = (userId) => {
    db.run('UPDATE users SET last_seen = ? WHERE id = ?', now(), userId);
    presenceChanged(userId);
  };
  hub.onMessage = (ws, msg) => {
    if (msg.type === 'typing') {
      const chatId = String(msg.chatId || '');
      if (!activeMember(chatId, ws.userId)) return;
      const kind = msg.kind === 'recording' ? 'recording' : 'typing';
      for (const uid of activeMemberIds(chatId)) {
        if (uid !== ws.userId && !eitherBlocked(uid, ws.userId)) {
          hub.sendToUser(uid, { type: 'typing', chatId, userId: ws.userId, on: !!msg.on, kind });
        }
      }
    } else if (msg.type === 'call') {
      handleCallSignal(ws, msg);
    }
  };
  hub.onSocketClosed = (ws) => dropDeviceFromCalls(ws.deviceId);

  return { router, upsertUser, authenticateToken, sweep, HttpError };
}
