// Tailchat web app: state, sync, encryption and actions. Rendering lives in
// views.js; this module owns the data and everything that talks to the server.
import { Api, ApiError, Realtime, kvGet, kvSet } from './api.js';
import { CallManager } from './calls.js';
import { KeyRing, callAad, chatAad, codeFromFingerprint, decryptFile, deviceCode, encryptFile, generateDeviceKeys, keyFingerprint, newMessageId, statusAad } from './crypto.js';
import { describeMedia, kindFor } from './media.js';
import { toast } from './ui.js';

export const api = new Api();

export const S = {
  me: null,
  device: null,
  limits: {},
  ring: null,
  online: false,
  users: new Map(),
  chats: new Map(),
  msgs: new Map(), // chatId -> { list, hasMore, loading, loaded }
  content: new Map(), // `${id}:${editedAt}` -> { ok } | { error, code }
  files: new Map(), // fileId -> { url, blob } | { progress } | { error }
  chatDevices: new Map(), // chatId -> { devices, at }
  typing: new Map(), // chatId -> Map userId -> { kind, until }
  statuses: new Map(),
  statusContent: new Map(),
  calls: [],
  starred: null,
  view: 'chats',
  filter: 'all',
  search: '',
  active: null,
  details: null, // null | 'info' | 'starred' | 'media' | 'search'
  panel: null, // sidebar panel over the chat list: 'settings', 'new-chat', ...
  chatSearch: '',
  community: null, // community id shown by the 'community' panel
  unreadFrom: null, // { chatId, seq, count } when a chat was opened
  reply: null,
  editing: null,
  highlight: null,
  uploads: new Map(), // temp message id -> progress
  ownDevices: [], // this account's linked devices
  deviceCodes: new Map(), // deviceId -> code of the key this device actually uses for it
  badKeys: new Set(), // own devices the server lists with a key other than the pinned one
  history: { requests: new Map(), sharing: null, loaded: false, epoch: 0 }, // chat history between your devices
  prefs: loadPrefs(),
};

let realtime;
export let calls;
const listeners = new Set();
let renderQueued = false;

export function onRender(fn) {
  listeners.add(fn);
}

export function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    for (const fn of listeners) fn();
  });
}

function loadPrefs() {
  try {
    return { theme: 'system', notifications: false, enterToSend: true, ...JSON.parse(localStorage.getItem('tailchat-prefs') || '{}') };
  } catch {
    return { theme: 'system', notifications: false, enterToSend: true };
  }
}

export function savePrefs(changes) {
  Object.assign(S.prefs, changes);
  try {
    localStorage.setItem('tailchat-prefs', JSON.stringify(S.prefs));
  } catch {
    // private mode: preferences last for this session only
  }
  applyTheme();
  render();
}

export function applyTheme() {
  const t = S.prefs.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------- boot ----------

function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export async function boot(setStatus) {
  applyTheme();
  if (!globalThis.crypto?.subtle) {
    throw new Error('This page must be opened over HTTPS (your https://…ts.net address) so the browser can encrypt your messages.');
  }
  const anon = await api.get('/api/me');
  S.me = anon.user;
  S.limits = anon.limits;
  const key = `device:${S.me.id}`;
  let stored = await kvGet(key);
  if (stored) {
    api.token = stored.token;
    try {
      const me = await api.get('/api/me');
      if (!me.device) throw new ApiError(401, 'no device');
      S.device = me.device;
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err;
      stored = null; // logged out from another device: start fresh
      api.token = null;
    }
  }
  const fresh = !stored;
  if (!stored) {
    setStatus('Creating encryption keys for this device…');
    const keys = await generateDeviceKeys();
    const reg = await api.post('/api/devices', { name: deviceName(), publicKey: keys.publicJwk });
    stored = { deviceId: reg.device.id, token: reg.token, privateKey: keys.privateKey, publicJwk: keys.publicJwk };
    await kvSet(key, stored);
    api.token = reg.token;
    S.device = reg.device;
  }
  // Every device key this browser has seen is pinned, so the server can't
  // quietly swap a key or reassign a device to someone else. `users` are the
  // people whose whole device list this browser has seen; a device that
  // turns up for one of them later is new.
  const pinsKey = `pins:${S.me.id}`;
  const saved = await kvGet(pinsKey).catch(() => null);
  S.pins = new Map(Object.entries(saved?.pins || {}));
  S.knownDevices = new Set(saved?.users || []);
  let pinSave = null;
  S.savePins = () => {
    clearTimeout(pinSave);
    pinSave = setTimeout(() => kvSet(pinsKey, { pins: Object.fromEntries(S.pins), users: [...S.knownDevices] }).catch(() => {}), 300);
  };
  S.ring = new KeyRing({
    deviceId: stored.deviceId,
    privateKey: stored.privateKey,
    fetchPublicKeys: async (ids) => {
      const { devices } = await api.get(`/api/keys?ids=${ids.map(encodeURIComponent).join(',')}`);
      noticeDevices(devices);
      return devices;
    },
    pins: S.pins,
    onPin: S.savePins,
  });
  await S.ring.addPublicKey(stored.deviceId, stored.publicJwk, S.me.id);
  // This device's code comes from the key it holds, never from the server.
  S.deviceCodes.set(stored.deviceId, await deviceCode(stored.publicJwk));
  setStatus('Loading your chats…');
  await Promise.all([loadUsers(), loadChats(), loadStatuses(), loadCalls()]);
  await checkOwnDevices().catch((err) => console.warn('device check failed', err));
  await loadHistory().catch((err) => console.warn('history requests failed', err));
  // A newly linked device asks your other devices for the history it can't
  // read; one of them has to say yes.
  if (fresh && S.ownDevices.some((d) => d.id !== S.device.id)) requestHistory().catch(() => {});
  realtime = new Realtime(api, {
    onEvent: handleEvent,
    onOpen: catchUp,
    onStatus: (up) => {
      S.online = up;
      render();
    },
  });
  calls = new CallManager({
    realtime,
    onChange: render,
    onIncoming: (ring) => notify(`Incoming ${ring.video ? 'video' : 'voice'} call`, nameOf(ring.from), ring.chatId),
    onEnded: () => loadCalls(),
    onError: (err) => toast(err.message),
    seal: async (callId, toDevice, toUser, data) => {
      await S.ring.publicKey(toDevice);
      if (!toUser || S.ring.owners.get(toDevice) !== toUser) throw new Error("This call's other device doesn't belong to who the server says it does");
      return S.ring.seal(data, callAad(callId, S.device.id, toDevice), [{ id: toDevice }]);
    },
    open: async (callId, fromDevice, fromUser, sealed) => {
      if (typeof sealed !== 'string') throw new Error('Unsealed call signalling refused');
      if (JSON.parse(sealed).from !== fromDevice) throw new Error('Call signalling from the wrong device refused');
      return S.ring.open(sealed, callAad(callId, fromDevice, S.device.id), fromUser);
    },
  });
  realtime.connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.active) markRead(S.active);
  });
  setInterval(expireTyping, 2000);
  setInterval(() => render(), 60_000); // relative times, disappearing messages
}

async function loadUsers() {
  const { users } = await api.get('/api/users');
  S.users = new Map(users.map((u) => [u.id, u]));
  const me = S.users.get(S.me.id);
  if (me) S.me = me;
}

async function loadChats() {
  const { chats } = await api.get('/api/chats');
  S.chats = new Map(chats.map((c) => [c.id, c]));
  for (const c of chats) if (c.lastMessage) decryptMessage(c.lastMessage);
  render();
}

export async function loadStatuses() {
  const { statuses } = await api.get('/api/status');
  S.statuses = new Map(statuses.map((s) => [s.id, s]));
  render();
}

export async function loadCalls() {
  S.calls = (await api.get('/api/calls')).calls;
  render();
}

async function catchUp() {
  try {
    await Promise.all([loadUsers(), loadChats(), loadStatuses(), loadHistory()]);
    for (const [chatId, box] of S.msgs) {
      if (!box.loaded || !S.chats.has(chatId)) continue;
      const last = box.list.filter((m) => !m.pending).at(-1);
      const { messages } = await api.get(`/api/chats/${encodeURIComponent(chatId)}/messages?after=${last ? last.seq : 0}&limit=200`);
      for (const m of messages) upsertMessage(m);
    }
    if (S.active) markRead(S.active);
    render();
  } catch (err) {
    console.warn('catch-up failed', err);
  }
}

// ---------- lookups ----------

export const isMe = (userId) => userId === S.me?.id;

export function nameOf(userId) {
  if (isMe(userId)) return 'You';
  return S.users.get(userId)?.name || userId?.split('@')[0] || 'Unknown';
}

export function otherMember(chat) {
  const others = chat.members.filter((m) => m.userId !== S.me.id);
  return others[0]?.userId || S.me.id;
}

// Groups, community announcement groups and channels have a name, admins and
// members. Only groups and communities show who sent each message: a channel
// post speaks for the channel.
export const isGroupish = (chat) => !!chat && chat.type !== 'direct';
export const isChannel = (chat) => chat?.type === 'channel';
export const showsSender = (chat) => chat?.type === 'group' || chat?.type === 'community';
export const noun = (chat) => ({ group: 'group', community: 'community', channel: 'channel' })[chat?.type] || 'chat';

// A device chat is between two of your own devices (PROTOCOL.md §10).
export const isDeviceChat = (chat) => Array.isArray(chat?.devices);
export const devicePeer = (chat) => chat?.devices?.find((id) => id !== S.device.id) || null;

export function chatTitle(chat) {
  if (!chat) return '';
  if (isDeviceChat(chat)) return ownDevice(devicePeer(chat))?.name || 'Your other device';
  if (isGroupish(chat)) return chat.name;
  const other = otherMember(chat);
  return isMe(other) ? `${S.me.name} (You)` : nameOf(other);
}

export function chatAvatar(chat) {
  if (isDeviceChat(chat)) return { id: devicePeer(chat) || chat.id, name: chatTitle(chat) };
  if (isGroupish(chat)) return { id: chat.id, name: chat.name, src: chat.avatar, group: chat.type === 'group' || chat.type };
  const u = S.users.get(otherMember(chat)) || S.me;
  return { id: u.id, name: u.name, src: u.avatar };
}

export const contentKey = (m) => `${m.id}:${m.editedAt || 0}`;

export function contentOf(m) {
  if (!m) return null;
  if (m.kind === 'system') {
    try {
      return { ok: { type: 'system', ...JSON.parse(m.payload) } };
    } catch {
      return { ok: { type: 'system', event: 'unknown' } };
    }
  }
  if (m.deletedAt) return { ok: { type: 'deleted' } };
  if (!m.payload) return m.viewOnce ? { ok: { type: 'opened' } } : { ok: { type: 'deleted' } };
  return S.content.get(contentKey(m)) || null;
}

const chatFetches = new Map();

// The chat a message belongs to, fetched if this device hasn't seen it yet.
export function chatOf(chatId) {
  const known = S.chats.get(chatId);
  if (known) return Promise.resolve(known);
  let p = chatFetches.get(chatId);
  if (!p) {
    p = api.get(`/api/chats/${encodeURIComponent(chatId)}`).then(({ chat }) => {
      if (!S.chats.has(chat.id)) S.chats.set(chat.id, chat);
      render();
      return S.chats.get(chat.id);
    }).finally(() => chatFetches.delete(chatId));
    chatFetches.set(chatId, p);
  }
  return p;
}

// Channel posts are plain JSON (channels aren't end-to-end encrypted, as on
// WhatsApp). Whether a payload is read as plain JSON depends only on the
// chat's type, never on what the payload looks like.
function channelPost(payload) {
  const post = JSON.parse(payload);
  if (!post || typeof post !== 'object' || Array.isArray(post) || typeof post.type !== 'string') throw new Error('Unreadable channel post');
  return post;
}

async function sealFor(chat, content, messageId) {
  if (isChannel(chat)) return JSON.stringify(content);
  return S.ring.seal(content, chatAad(chat.id, messageId), await devicesFor(chat.id));
}

export async function decryptMessage(m) {
  if (m.kind !== 'msg' || !m.payload || m.deletedAt) return;
  const key = contentKey(m);
  const cached = S.content.get(key);
  // History shared since is worth another try, even while a try without it
  // is still running.
  if (cached && !(m.historyKey && (cached.code === 'NO_KEY' || (cached.pending && !cached.history)))) return;
  const attempt = { pending: true, history: !!m.historyKey };
  S.content.set(key, attempt);
  let result;
  try {
    const chat = await chatOf(m.chatId);
    result = { ok: isChannel(chat) ? channelPost(m.payload) : await S.ring.open(m.payload, chatAad(m.chatId, m.id), m.senderId, m.historyKey) };
  } catch (err) {
    result = { error: err.message, code: err.code };
  }
  if (S.content.get(key) === attempt) S.content.set(key, result);
  render();
}

export function previewText(m) {
  const c = contentOf(m)?.ok;
  if (!c) return contentOf(m)?.error ? 'Waiting for this message' : '…';
  switch (c.type) {
    case 'text':
      return withNames(c.text, c.mentions);
    case 'media':
      return (
        { image: '📷 Photo', video: '🎥 Video', gif: 'GIF', audio: '🎵 Audio', voice: '🎤 Voice message', sticker: 'Sticker', document: `📄 ${c.file?.name || 'Document'}` }[c.kind] +
        (c.caption ? ` ${c.caption}` : '')
      );
    case 'location':
      return '📍 Location';
    case 'contact':
      return `👤 ${c.name}`;
    case 'poll':
      return `📊 ${c.question}`;
    case 'deleted':
      return isMe(m.senderId) ? 'You deleted this message' : 'This message was deleted';
    case 'opened':
      return 'Opened';
    case 'system':
      return systemText(m, c);
    default:
      return 'Message';
  }
}

// "@alice@example.com" -> "@Alice" for the people a message mentions.
export function withNames(text, mentions) {
  if (typeof text !== 'string') return '';
  if (!Array.isArray(mentions)) return text;
  for (const id of mentions.slice(0, 64)) {
    if (typeof id === 'string' && id) text = text.split(`@${id}`).join(`@${isMe(id) ? S.me.name : nameOf(id)}`);
  }
  return text;
}

export function systemText(m, c) {
  const who = nameOf(m.senderId);
  const names = (Array.isArray(c.users) ? c.users : []).map((u) => (isMe(u) ? 'you' : nameOf(u))).join(', ');
  const kind = noun(S.chats.get(m.chatId));
  switch (c.event) {
    case 'created':
      return `${who} created ${kind} "${c.name}"`;
    case 'added':
      return `${who} added ${names}`;
    case 'joined':
      return c.via === 'community' ? `${who} joined from the community` : `${who} joined using this ${kind}'s invite link`;
    case 'left':
      return `${names} left`;
    case 'removed':
      return `${who} removed ${names}`;
    case 'promoted':
      return `${who} made ${names} an admin`;
    case 'demoted':
      return `${who} dismissed ${names} as admin`;
    case 'renamed':
      return `${who} changed the ${kind} name to "${c.name}"`;
    case 'description':
      return `${who} changed the ${kind} description`;
    case 'photo':
      return `${who} changed this ${kind}'s icon`;
    case 'disappearing':
      return c.seconds ? `${who} turned on disappearing messages. New messages will disappear ${disappearAfter(c.seconds)} after they're sent.` : `${who} turned off disappearing messages.`;
    case 'settings':
      if ('adminsOnlySend' in c) return c.adminsOnlySend ? `${who} changed this group's settings to allow only admins to send messages` : `${who} changed this group's settings to allow all members to send messages`;
      return c.adminsOnlyEdit ? `${who} changed this group's settings to allow only admins to edit this group's info` : `${who} changed this group's settings to allow all members to edit this group's info`;
    case 'pinned':
      return `${who} pinned a message`;
    case 'unpinned':
      return `${who} unpinned a message`;
    case 'community':
      return `${who} added this group to the community "${c.name}"`;
    case 'community-left':
      return `${who} removed this group from the community "${c.name}"`;
    case 'community-group':
      return `${who} added the group "${c.name}"`;
    case 'community-group-removed':
      return `${who} removed the group "${c.name}"`;
    case 'deactivated':
      return `${who} deactivated this community`;
    default:
      return 'Group updated';
  }
}

function disappearAfter(s) {
  if (s >= 86400) return `${Math.round(s / 86400)} day${s >= 172800 ? 's' : ''}`;
  if (s >= 3600) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 60)} minutes`;
}

// Delivery ticks for a message I sent.
export function tickState(m, chat) {
  if (m.pending) return 'pending';
  if (m.failed) return 'failed';
  if (isChannel(chat)) return 'sent';
  const others = chat.members.filter((x) => !x.left && x.userId !== S.me.id && x.joinedSeq < m.seq);
  if (!others.length) return 'read';
  if (others.every((x) => x.readSeq >= m.seq)) return 'read';
  if (others.every((x) => x.deliveredSeq >= m.seq)) return 'delivered';
  return 'sent';
}

// ---------- messages ----------

export function box(chatId) {
  let b = S.msgs.get(chatId);
  if (!b) S.msgs.set(chatId, (b = { list: [], hasMore: true, loading: false, loaded: false }));
  return b;
}

export function upsertMessage(m) {
  const b = box(m.chatId);
  const i = b.list.findIndex((x) => x.id === m.id);
  if (i >= 0) b.list[i] = m;
  // While the first page is loading, keep it: the page may have been read
  // before this message was stored, and is merged into the list after.
  else if (b.loaded || b.loading) {
    b.list.push(m);
    b.list.sort((a, c) => (a.pending ? Infinity : a.seq) - (c.pending ? Infinity : c.seq));
  }
  decryptMessage(m);
  const chat = S.chats.get(m.chatId);
  if (chat && (!chat.lastMessage || chat.lastMessage.seq <= m.seq)) chat.lastMessage = m;
  if (chat && m.seq > chat.lastSeq) chat.lastSeq = m.seq;
}

export async function loadMessages(chatId, { older = false } = {}) {
  const b = box(chatId);
  if (b.loading || (older && !b.hasMore)) return;
  b.loading = true;
  try {
    const first = b.list.find((m) => !m.pending);
    const qs = older && first ? `?before=${first.seq}&limit=50` : '?limit=50';
    const { messages, hasMore } = await api.get(`/api/chats/${encodeURIComponent(chatId)}/messages${qs}`);
    const known = new Set(b.list.map((m) => m.id));
    b.list = older ? [...messages.filter((m) => !known.has(m.id)), ...b.list] : mergeLatest(b.list, messages);
    b.hasMore = hasMore;
    b.loaded = true;
    for (const m of messages) decryptMessage(m);
  } finally {
    b.loading = false;
    render();
  }
}

function mergeLatest(existing, fresh) {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const m of fresh) map.set(m.id, m);
  return [...map.values()].sort((a, c) => (a.pending ? Infinity : a.seq) - (c.pending ? Infinity : c.seq));
}

// Devices a message for this chat is sealed to. A logged-out device never
// gets a key, whatever the server says.
async function devicesFor(chatId) {
  const cached = S.chatDevices.get(chatId);
  if (cached && Date.now() - cached.at < 60_000) return cached.devices;
  const devices = (await api.get(`/api/chats/${encodeURIComponent(chatId)}/devices`)).devices.filter((d) => !d.revokedAt);
  noticeDevices(devices, { complete: true });
  S.chatDevices.set(chatId, { devices, at: Date.now() });
  return devices;
}

// ---------- new devices (security code changes) ----------

// Like WhatsApp's "security code changed" notices: a device appearing for
// someone whose devices this browser already knew means their code changed.
// A new device on your own account gets a louder warning, since anyone
// signed in to Tailscale as you could have linked it. `complete` lists hold
// every active device of the people in them; the first one seen for a person
// is trusted as it is.
function noticeDevices(devices, { complete = false } = {}) {
  const listed = devices.filter((d) => !d.revokedAt);
  const active = listed.filter((d) => d.id !== S.device.id);
  const fresh = active.filter((d) => !S.pins.has(d.id) && S.knownDevices.has(d.userId));
  if (complete) {
    const firstSight = new Set(listed.map((d) => d.userId).filter((u) => !S.knownDevices.has(u)));
    for (const u of firstSight) S.knownDevices.add(u);
    if (firstSight.size) S.savePins();
  }
  // Pin what was seen, so each new device is reported once.
  for (const d of active) {
    if (!S.pins.has(d.id) && S.knownDevices.has(d.userId)) S.ring.addPublicKey(d.id, d.publicKey, d.userId).catch(() => {});
  }
  if (!fresh.length) return;
  const alerts = { users: { ...(S.prefs.securityAlerts?.users || {}) }, devices: [...(S.prefs.securityAlerts?.devices || [])] };
  for (const d of fresh) {
    if (!isMe(d.userId)) alerts.users[d.userId] = Date.now();
    else if (!alerts.devices.some((x) => x.id === d.id)) alerts.devices.push({ id: d.id, name: String(d.name).slice(0, 80), at: d.createdAt || Date.now() });
  }
  savePrefs({ securityAlerts: alerts });
}

async function checkDevicesOf(userId) {
  const { devices } = await api.get(`/api/users/${encodeURIComponent(userId)}/devices`);
  noticeDevices(devices.filter((d) => d.userId === userId), { complete: true });
}

export const checkOwnDevices = () => checkDevicesOf(S.me.id);

export function dismissSecurityAlerts({ users = [], devices = false } = {}) {
  const a = S.prefs.securityAlerts || {};
  const left = { ...(a.users || {}) };
  for (const u of users) delete left[u];
  savePrefs({ securityAlerts: { users: left, devices: devices ? [] : a.devices || [] } });
}

// ---------- chat history between your own devices (PROTOCOL.md §9) ----------

let historyGen = 0;
export async function loadHistory() {
  const gen = ++historyGen;
  const [{ requests }, { devices }] = await Promise.all([api.get('/api/history/requests'), api.get('/api/devices')]);
  // A slower, older call must not bring back an out-of-date device list.
  if (gen !== historyGen) return;
  S.ownDevices = devices.filter((d) => !d.revokedAt && d.userId === S.me.id);
  // Another device's code is computed from the key this device pinned for
  // it, which is the key history would be encrypted to. If the server's
  // list shows a different key, sharing with that device is refused.
  for (const d of S.ownDevices) {
    if (d.id === S.device.id) continue;
    try {
      await S.ring.ownDevice(d.id);
      const pin = S.pins.get(d.id);
      if (!pin) throw new Error('not pinned');
      S.deviceCodes.set(d.id, codeFromFingerprint(pin.fp));
      if (pin.fp !== (await keyFingerprint(d.publicKey))) S.badKeys.add(d.id);
    } catch (err) {
      S.deviceCodes.delete(d.id);
      if (err.code === 'KEY_CHANGED') S.badKeys.add(d.id);
    }
  }
  const before = S.history.requests.get(S.device.id);
  S.history.requests = new Map(requests.map((r) => [r.deviceId, r]));
  const now = S.history.requests.get(S.device.id);
  // An answer that came while this device was offline.
  if (S.history.loaded && now) ownRequestChanged(before, now);
  S.history.loaded = true;
  render();
  ensureDeviceChats().catch(() => {});
}

// Every other device of yours gets a chat, the first time this one sees it.
// A chat with a device that has been logged out goes.
const deviceChatTried = new Set();
async function ensureDeviceChats() {
  for (const [id, c] of S.chats) {
    if (!isDeviceChat(c) || ownDevice(devicePeer(c))) continue;
    deviceChatTried.delete(devicePeer(c));
    S.chats.delete(id);
    S.msgs.delete(id);
    if (S.active === id) S.active = null;
  }
  for (const d of S.ownDevices) {
    if (d.id === S.device.id || deviceChatTried.has(d.id)) continue;
    deviceChatTried.add(d.id);
    if ([...S.chats.values()].some((c) => c.devices?.includes(d.id))) continue;
    const { chat } = await api.post('/api/chats/devices', { deviceId: d.id, open: false });
    if (chat) S.chats.set(chat.id, chat);
  }
  render();
}

export async function openDeviceChat(deviceId) {
  const { chat } = await api.post('/api/chats/devices', { deviceId });
  S.chats.set(chat.id, chat);
  openChat(chat.id);
}

export async function renameDevice(deviceId, name) {
  await api.patch(`/api/devices/${encodeURIComponent(deviceId)}`, { name });
  await loadHistory();
}

export const ownDevice = (id) => S.ownDevices.find((d) => d.id === id);

// Requests from your other devices that this one can answer.
export function historyAsks() {
  return [...S.history.requests.values()].filter((r) => r.state === 'pending' && r.deviceId !== S.device.id && ownDevice(r.deviceId));
}

export async function requestHistory() {
  const { request } = await api.post('/api/history/request');
  S.history.requests.set(request.deviceId, request);
  render();
  return request;
}

export async function declineHistory(deviceId) {
  await api.del(`/api/history/requests/${encodeURIComponent(deviceId)}`);
}

function historyChanged(r) {
  if (!r?.deviceId) return;
  const before = S.history.requests.get(r.deviceId);
  if (r.state === 'gone') S.history.requests.delete(r.deviceId);
  else S.history.requests.set(r.deviceId, r);
  if (!ownDevice(r.deviceId) && r.state !== 'gone') loadHistory().catch(() => {});
  if (r.deviceId === S.device.id) ownRequestChanged(before, r);
}

function ownRequestChanged(before, r) {
  if (before?.state === r.state && before?.updatedAt === r.updatedAt) return;
  const by = ownDevice(r.byDevice)?.name || 'your other device';
  if (r.state === 'done') {
    toast(r.shared ? `Chat history arrived from ${by}` : `${by} had no older messages to share`, 6000);
    reloadHistory();
  } else if (r.state === 'declined' && r.byDevice !== S.device.id) {
    toast(`${by} didn't share chat history`, 6000);
  }
}

// Fetches the messages already on screen again, now that more of them can
// be opened here. Drafts and unsent messages stay where they are.
export function reloadHistory() {
  S.history.epoch++;
  S.starred = null;
  loadChats().catch(() => {});
  for (const [chatId, b] of S.msgs) {
    if (b.loaded) refetchBox(chatId).catch(() => {});
  }
}

async function refetchBox(chatId) {
  const sent = box(chatId).list.filter((m) => !m.pending);
  if (!sent.length) return;
  const last = sent.at(-1).seq;
  let after = sent[0].seq - 1;
  while (after < last) {
    const { messages, hasMore } = await api.get(`/api/chats/${encodeURIComponent(chatId)}/messages?after=${after}&limit=200`);
    for (const m of messages) if (m.seq <= last) upsertMessage(m);
    if (!hasMore || !messages.length) break;
    after = messages.at(-1).seq;
  }
  render();
}

// Re-encrypts the key of every message this device can read for another
// device of yours that asked for it. onProgress(count) as it goes.
// code: the device code the user compared, so the history goes to exactly
// that key.
export async function shareHistory(deviceId, code, onProgress) {
  if (S.history.sharing) throw new Error('Already sharing chat history');
  const target = ownDevice(deviceId);
  if (!target || deviceId === S.device.id) throw new Error('That device is not one of yours');
  await S.ring.ownDevice(deviceId);
  const pin = S.pins.get(deviceId);
  if (S.badKeys.has(deviceId) || !pin || codeFromFingerprint(pin.fp) !== code) {
    throw new Error("That device's key doesn't match the code you checked, so nothing was shared");
  }
  S.history.sharing = { deviceId, count: 0 };
  render();
  let batch = [];
  const flush = async (done = false) => {
    await api.post('/api/history/keys', { deviceId, keys: batch, done });
    batch = [];
  };
  try {
    // Channels aren't encrypted, and a device chat is for its two devices only.
    for (const chat of [...S.chats.values()].filter((c) => !isChannel(c) && !isDeviceChat(c))) {
      let before = 0;
      for (;;) {
        const { messages, hasMore } = await api.get(`/api/chats/${encodeURIComponent(chat.id)}/messages?limit=200${before ? `&before=${before}` : ''}`);
        for (const m of messages) {
          if (m.kind !== 'msg' || !m.payload || m.deletedAt || m.viewOnce) continue;
          try {
            if (JSON.parse(m.payload).keys?.[deviceId]) continue; // it can read this one already
            batch.push({ messageId: m.id, key: await S.ring.reshare(m.payload, chatAad(m.chatId, m.id), m.senderId, m.historyKey, deviceId) });
            S.history.sharing.count++;
          } catch {
            // not readable here either, or not genuine: skipped
          }
          if (batch.length >= 200) await flush();
        }
        onProgress?.(S.history.sharing.count);
        render();
        if (!hasMore || !messages.length) break;
        before = messages[0].seq;
      }
    }
    await flush(true);
    return S.history.sharing.count;
  } finally {
    S.history.sharing = null;
    render();
  }
}

// One message's content for an export: from the cache, or opened now.
export async function readMessage(m) {
  const known = contentOf(m);
  if (known?.ok || (known?.error && !(known.code === 'NO_KEY' && m.historyKey))) return known;
  try {
    const chat = await chatOf(m.chatId);
    return { ok: isChannel(chat) ? channelPost(m.payload) : await S.ring.open(m.payload, chatAad(m.chatId, m.id), m.senderId, m.historyKey) };
  } catch (err) {
    return { error: err.message, code: err.code };
  }
}

// Decrypts an attachment without keeping it around.
export async function fileBlob(file) {
  const hit = S.files.get(file.id);
  if (hit?.blob) return hit.blob;
  return decryptFile(await api.download(file.id), file, safeMime(file.mime));
}

// Encrypts and sends. `content` is the plaintext message (PROTOCOL.md §4).
export async function sendContent(chatId, content, { files = [], viewOnce = false, id = newMessageId(), temp } = {}) {
  const b = box(chatId);
  const draft = temp || {
    id, chatId, seq: 0, senderId: S.me.id, senderDevice: S.device.id, kind: 'msg', payload: 'local', files,
    viewOnce, createdAt: Date.now(), reactions: [], votes: [], pending: true,
  };
  if (!temp) {
    S.content.set(contentKey(draft), { ok: content });
    if (b.loaded) b.list.push(draft);
    render();
  }
  try {
    const payload = await sealFor(await chatOf(chatId), content, id);
    const { message } = await api.post(`/api/chats/${encodeURIComponent(chatId)}/messages`, { id, payload, files, viewOnce });
    S.content.set(contentKey(message), { ok: content });
    const i = b.list.findIndex((m) => m.id === id);
    if (i >= 0) b.list[i] = message;
    upsertMessage(message);
    render();
    return message;
  } catch (err) {
    draft.pending = false;
    draft.failed = true;
    draft.retry = () => {
      draft.failed = false;
      draft.pending = true;
      render();
      return sendContent(chatId, content, { files, viewOnce, id, temp: draft });
    };
    render();
    toast(err.message);
    throw err;
  }
}

export function sendText(chatId, text, extra = {}) {
  const content = { type: 'text', text, ...extra };
  return sendContent(chatId, content);
}

// Attachments: encrypt in the browser, upload the ciphertext, then send the
// key inside the encrypted message.
export async function sendFile(chatId, file, { caption, kind = kindFor(file), viewOnce = false, extra = {}, voice } = {}) {
  const id = newMessageId();
  const meta = voice ? { duration: voice.duration, waveform: voice.waveform } : await describeMedia(file, kind);
  const content = {
    type: 'media',
    kind,
    caption: caption || undefined,
    ...meta,
    ...extra,
    file: { name: file.name || `${kind}.${(file.type.split('/')[1] || 'bin').split(';')[0]}`, mime: file.type || 'application/octet-stream', size: file.size },
  };
  const b = box(chatId);
  const draft = {
    id, chatId, seq: 0, senderId: S.me.id, senderDevice: S.device.id, kind: 'msg', payload: 'local', files: [],
    viewOnce, createdAt: Date.now(), reactions: [], votes: [], pending: true,
  };
  S.content.set(contentKey(draft), { ok: content });
  S.uploads.set(id, 0);
  if (b.loaded) b.list.push(draft);
  render();
  try {
    const { blob, file: keys } = await encryptFile(file, (p) => {
      S.uploads.set(id, p * 0.3);
      render();
    });
    const up = await api.upload(blob, {
      onProgress: (p) => {
        S.uploads.set(id, 0.3 + p * 0.7);
        render();
      },
    });
    content.file = { ...content.file, ...keys, id: up.id };
    S.files.set(up.id, { url: URL.createObjectURL(file), blob: file });
    S.uploads.delete(id);
    S.content.set(contentKey(draft), { ok: content });
    draft.files = [up.id];
    return await sendContent(chatId, content, { files: [up.id], viewOnce, id, temp: draft });
  } catch (err) {
    S.uploads.delete(id);
    draft.pending = false;
    draft.failed = true;
    draft.retry = () => {
      b.list = b.list.filter((m) => m.id !== id);
      return sendFile(chatId, file, { caption, kind, viewOnce, extra, voice });
    };
    render();
    toast(err.message);
    throw err;
  }
}

export async function editMessage(m, newContent) {
  const payload = await sealFor(await chatOf(m.chatId), newContent, m.id);
  const { message } = await api.put(`/api/messages/${encodeURIComponent(m.id)}`, { payload });
  S.content.set(contentKey(message), { ok: newContent });
  upsertMessage(message);
  render();
}

export async function forwardMessage(m, chatIds) {
  const c = contentOf(m)?.ok;
  if (!c) return;
  const { replyTo, mentions, forwarded, forwardCount, ...rest } = c;
  const count = isMe(m.senderId) && !forwarded ? 0 : (forwardCount || 0) + 1;
  const content = { ...rest, forwarded: count > 0 || undefined, forwardCount: count || undefined };
  for (const chatId of chatIds) await sendContent(chatId, content, { files: m.files });
}

// The sender picks an attachment's type. Only media types are kept, so a
// blob URL can never be opened as a page (HTML or SVG) on Tailchat's origin.
function safeMime(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return /^(image\/(png|jpeg|gif|webp|avif|heic|heif)|video\/[\w.+-]+|audio\/[\w.+-]+)$/.test(base) ? base : 'application/octet-stream';
}

// Downloads and decrypts an attachment; cached as an object URL.
export async function ensureFile(file) {
  if (!file?.id) return null;
  const hit = S.files.get(file.id);
  if (hit?.url || hit?.progress !== undefined) return hit;
  S.files.set(file.id, { progress: 0 });
  render();
  try {
    const encrypted = await api.download(file.id, {
      onProgress: (p) => {
        S.files.set(file.id, { progress: p });
        render();
      },
    });
    const blob = await decryptFile(encrypted, file, safeMime(file.mime));
    const entry = { url: URL.createObjectURL(blob), blob };
    S.files.set(file.id, entry);
    render();
    return entry;
  } catch (err) {
    S.files.set(file.id, { error: err.message });
    render();
    throw err;
  }
}

export async function markRead(chatId) {
  const chat = S.chats.get(chatId);
  if (!chat || document.visibilityState !== 'visible') return;
  if (chat.lastSeq > chat.me.readSeq || chat.me.markedUnread || chat.unread) {
    chat.unread = 0;
    chat.me.markedUnread = false;
    chat.me.readSeq = chat.lastSeq;
    render();
    await api.post(`/api/chats/${encodeURIComponent(chatId)}/receipts`, { delivered: chat.lastSeq, read: chat.lastSeq }).catch(() => {});
  }
}

const deliveredTimers = new Map();
function markDelivered(chatId, seq) {
  const pending = deliveredTimers.get(chatId);
  if (pending) {
    pending.seq = Math.max(pending.seq, seq);
    return;
  }
  const entry = { seq };
  deliveredTimers.set(chatId, entry);
  setTimeout(() => {
    deliveredTimers.delete(chatId);
    api.post(`/api/chats/${encodeURIComponent(chatId)}/receipts`, { delivered: entry.seq }).catch(() => {});
  }, 300);
}

// ---------- typing ----------

let typingSent = { chatId: null, at: 0 };
let typingStop;
export function typing(chatId, kind = 'typing') {
  const now = Date.now();
  if (typingSent.chatId !== chatId || now - typingSent.at > 3000) {
    realtime.send({ type: 'typing', chatId, on: true, kind });
    typingSent = { chatId, at: now };
  }
  clearTimeout(typingStop);
  typingStop = setTimeout(() => stopTyping(chatId), 4000);
}

export function stopTyping(chatId) {
  clearTimeout(typingStop);
  if (typingSent.chatId === chatId) {
    realtime.send({ type: 'typing', chatId, on: false });
    typingSent = { chatId: null, at: 0 };
  }
}

function expireTyping() {
  const now = Date.now();
  let changed = false;
  for (const [chatId, m] of S.typing) {
    for (const [uid, t] of m) {
      if (t.until < now) {
        m.delete(uid);
        changed = true;
      }
    }
    if (!m.size) S.typing.delete(chatId);
  }
  if (changed) render();
}

export function typingText(chatId) {
  const m = S.typing.get(chatId);
  if (!m?.size) return '';
  const chat = S.chats.get(chatId);
  const entries = [...m.entries()];
  const recording = entries.some(([, t]) => t.kind === 'recording');
  const verb = recording ? 'recording audio…' : 'typing…';
  if (!showsSender(chat)) return verb;
  if (entries.length === 1) return `${nameOf(entries[0][0])} is ${verb}`;
  return `${entries.length} people are ${verb}`;
}

// ---------- realtime ----------

function handleEvent(e) {
  switch (e.type) {
    case 'message': {
      const m = e.message;
      upsertMessage(m);
      const chat = S.chats.get(m.chatId);
      if (!chat) chatOf(m.chatId).catch(() => {});
      if (m.kind === 'msg' && !isMe(m.senderId)) {
        S.typing.get(m.chatId)?.delete(m.senderId);
        if (S.active === m.chatId && document.visibilityState === 'visible') markRead(m.chatId);
        else markDelivered(m.chatId, m.seq);
        if (chat && (S.active !== m.chatId || document.visibilityState !== 'visible') && !(chat.me.mutedUntil > Date.now())) {
          waitForContent(m).then(() => notify(chatTitle(chat), (showsSender(chat) ? `${nameOf(m.senderId)}: ` : '') + previewText(m), m.chatId));
        }
      }
      break;
    }
    case 'message-update': {
      const m = e.message;
      const b = S.msgs.get(m.chatId);
      const old = b?.list.find((x) => x.id === m.id);
      if (old && old.editedAt !== m.editedAt) S.content.delete(contentKey(old));
      upsertMessage(m);
      const chat = S.chats.get(m.chatId);
      if (chat?.lastMessage?.id === m.id) chat.lastMessage = m;
      break;
    }
    case 'message-gone': {
      const b = S.msgs.get(e.chatId);
      if (b) b.list = b.list.filter((m) => m.id !== e.id);
      const chat = S.chats.get(e.chatId);
      if (chat?.lastMessage?.id === e.id) chat.lastMessage = b?.list.filter((m) => !m.pending).at(-1) || null;
      break;
    }
    case 'chat': {
      const prev = S.chats.get(e.chat.id);
      S.chats.set(e.chat.id, e.chat);
      if (e.chat.lastMessage) decryptMessage(e.chat.lastMessage);
      if (prev && prev.members.length !== e.chat.members.length) S.chatDevices.delete(e.chat.id);
      if (S.active === e.chat.id) markRead(e.chat.id);
      break;
    }
    case 'chat-removed':
      S.chats.delete(e.chatId);
      S.msgs.delete(e.chatId);
      if (S.active === e.chatId) S.active = null;
      break;
    case 'receipt': {
      const chat = S.chats.get(e.chatId);
      const i = chat?.members.findIndex((m) => m.userId === e.member.userId) ?? -1;
      if (i >= 0) chat.members[i] = e.member;
      break;
    }
    case 'typing': {
      let m = S.typing.get(e.chatId);
      if (!m) S.typing.set(e.chatId, (m = new Map()));
      if (e.on) m.set(e.userId, { kind: e.kind, until: Date.now() + 6000 });
      else m.delete(e.userId);
      break;
    }
    case 'user':
      S.users.set(e.user.id, e.user);
      if (isMe(e.user.id)) S.me = { ...S.me, ...e.user };
      break;
    case 'devices':
      if (S.knownDevices.has(e.userId)) checkDevicesOf(e.userId).catch(() => {});
      if (isMe(e.userId)) loadHistory().catch(() => {});
      for (const [chatId, chat] of S.chats) if (chat.members.some((m) => m.userId === e.userId)) S.chatDevices.delete(chatId);
      break;
    case 'status':
      S.statuses.set(e.status.id, e.status);
      break;
    case 'status-gone':
      S.statuses.delete(e.id);
      break;
    case 'call':
      calls.handle(e).catch((err) => toast(err.message));
      if (e.action === 'ended') loadCalls();
      break;
    case 'history':
      historyChanged(e.request);
      break;
    case 'auth-failed':
      toast('This device was logged out. Reload to link it again.', 10_000);
      realtime.stop();
      break;
    default:
      break;
  }
  render();
}

async function waitForContent(m) {
  for (let i = 0; i < 20 && !contentOf(m)?.ok && !contentOf(m)?.error; i++) await new Promise((r) => setTimeout(r, 50));
}

export function notify(title, body, chatId) {
  updateTitle();
  if (!S.prefs.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && S.active === chatId) return;
  try {
    const n = new Notification(title, { body: body.slice(0, 160), tag: chatId, icon: '/icon.svg' });
    n.onclick = () => {
      window.focus();
      openChat(chatId);
      n.close();
    };
  } catch {
    // some browsers only allow notifications from a service worker
  }
}

export function updateTitle() {
  let unread = 0;
  for (const c of S.chats.values()) if (!c.me.archived && !(c.me.mutedUntil > Date.now()) && (c.unread || c.me.markedUnread)) unread++;
  document.title = unread ? `(${unread}) Tailchat` : 'Tailchat';
}

// ---------- navigation ----------

export function openChat(chatId, { highlight } = {}) {
  if (S.active !== chatId) {
    if (S.active) stopTyping(S.active);
    const chat = S.chats.get(chatId);
    S.unreadFrom = chat ? { chatId, seq: chat.me.readSeq, count: chat.unread || 0 } : null;
    S.chatSearch = '';
    S.active = chatId;
    S.reply = null;
    S.editing = null;
    if (S.details !== 'info' || !chatId) S.details = null;
  }
  // Stay on the tab that lists the chat: channels under Updates, a
  // community's chats under Communities.
  const chat = S.chats.get(chatId);
  if (isChannel(chat)) S.view = 'status';
  else if (!(S.view === 'communities' && (chat?.type === 'community' || chat?.communityId))) S.view = 'chats';
  S.highlight = highlight || null;
  if (chatId && !box(chatId).loaded) loadMessages(chatId).then(() => markRead(chatId));
  else if (chatId) markRead(chatId);
  render();
}

export async function openDirect(userId) {
  const { chat } = await api.post('/api/chats/direct', { userId });
  S.chats.set(chat.id, chat);
  openChat(chat.id);
  return chat;
}

// ---------- status ----------

export async function postStatus(content, file) {
  let files = [];
  if (file) {
    const { blob, file: keys } = await encryptFile(file);
    const up = await api.upload(blob);
    const meta = await describeMedia(file, kindFor(file));
    content = { ...content, ...meta, file: { ...keys, id: up.id, name: file.name, mime: file.type, size: file.size } };
    files = [up.id];
  }
  const devices = (await api.get('/api/status/devices')).devices.filter((d) => !d.revokedAt);
  noticeDevices(devices, { complete: true });
  const payload = await S.ring.seal(content, statusAad(S.me.id), devices);
  const { status } = await api.post('/api/status', { payload, files });
  S.statuses.set(status.id, status);
  S.statusContent.set(status.id, { ok: content });
  render();
}

export async function statusContentOf(s) {
  const hit = S.statusContent.get(s.id);
  if (hit) return hit;
  try {
    const content = await S.ring.open(s.payload, statusAad(s.userId), s.userId);
    S.statusContent.set(s.id, { ok: content });
  } catch (err) {
    S.statusContent.set(s.id, { error: err.message });
  }
  return S.statusContent.get(s.id);
}

export async function loadStarred() {
  const { messages } = await api.get('/api/starred');
  S.starred = messages;
  for (const m of messages) decryptMessage(m);
  render();
}
