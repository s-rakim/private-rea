// Dialogs and full-screen layers shared by the screens: pickers, message
// info, media viewer, status viewer and composer, calls, group invites.
import { S, api, calls, render, nameOf, isMe, chatTitle, chatAvatar, contentOf, previewText, ensureFile, forwardMessage, openChat, statusContentOf, postStatus, sendText, isGroupish, isChannel } from './app.js';
import { h, icon, iconButton, avatar, dialog, toast, viewer, timeOf, listTime, dayLabel, fileSize, duration, reconcile } from './ui.js';
import { securityCode } from './crypto.js';
import { kindFor, safeName } from './media.js';

// ---------- small helpers for content from other people ----------

export const str = (v, max = 65536) => (typeof v === 'string' ? v.slice(0, max) : '');
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Thumbnails travel inside encrypted messages. Only inline images are
// shown, so a message can't make your browser fetch a tracking URL.
export function safeThumb(t) {
  return typeof t === 'string' && t.length < 400_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(t) ? t : null;
}

const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#54656f');

const layer = () => document.getElementById('layer');

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: safeName(name) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function downloadFile(file) {
  try {
    const entry = await ensureFile(file);
    if (entry?.blob) saveBlob(entry.blob, file.name || 'file');
  } catch (err) {
    toast(err.message);
  }
}

// ---------- pickers ----------

function userRow(u, extra, onClick) {
  return h(
    'div',
    { class: 'row', onclick: onClick },
    avatar(u),
    h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, isMe(u.id) ? `${u.name} (You)` : u.name), h('div', { class: 'preview ellipsis' }, u.about || u.id)),
    extra,
  );
}

// Resolves to a list of user ids, or null when cancelled.
export function pickUsers({ title, exclude = [], multiple = true, okLabel = 'Done', includeMe = false } = {}) {
  return new Promise((resolve) => {
    const chosen = new Set();
    let result = null;
    const search = h('input', { type: 'search', placeholder: 'Search name or tailnet login', oninput: () => draw() });
    const list = h('div', { class: 'pick-list' });
    const chips = h('div', { class: 'chips-sel' });
    const users = [...S.users.values()].filter((u) => !exclude.includes(u.id) && (includeMe || !isMe(u.id)));
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q));
      reconcile(list, shown.length
        ? shown.map((u) => userRow(u, multiple ? h('input', { type: 'checkbox', checked: chosen.has(u.id), tabindex: -1 }) : null, () => {
          if (!multiple) {
            result = [u.id];
            d.close();
            return;
          }
          if (chosen.has(u.id)) chosen.delete(u.id);
          else chosen.add(u.id);
          draw();
        }))
        : [h('div', { class: 'empty' }, users.length ? 'No matches' : 'Nobody else on your tailnet has opened Tailchat yet. Share your Tailchat address with them.')]);
      reconcile(chips, [...chosen].map((id) => h('span', { class: 'chip' }, nameOf(id))));
      const ok = d?.box.querySelector('footer .btn.primary');
      if (ok) ok.disabled = !chosen.size;
    };
    const d = dialog({
      title,
      content: [h('label', { class: 'field' }, search), chips, list],
      actions: multiple
        ? [
          { label: 'Cancel', onClick: (close) => close() },
          { label: okLabel, kind: 'primary', disabled: true, onClick: (close) => { result = [...chosen]; close(); } },
        ]
        : [],
      onClose: () => resolve(result),
    });
    draw();
  });
}

// Chats you can currently send to, most recent first.
export function sendableChats() {
  return [...S.chats.values()]
    .filter((c) => !c.me.left && !(isGroupish(c) && c.adminsOnlySend && c.me.role !== 'admin'))
    .sort((a, b) => (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt));
}

// Recent chats plus everyone you haven't talked to yet. Resolves to the
// chosen chat ids (creating direct chats as needed), or null.
export function pickChats({ title, okLabel = 'Send', max = 5 }) {
  return new Promise((resolve) => {
    const chosen = new Map(); // key -> entry
    let result = null;
    const search = h('input', { type: 'search', placeholder: 'Search name or tailnet login', oninput: () => draw() });
    const list = h('div', { class: 'pick-list' });
    const chats = sendableChats();
    const withDirect = new Set(chats.filter((c) => c.type === 'direct').map((c) => c.members.find((m) => !isMe(m.userId))?.userId || S.me.id));
    const entries = [
      ...chats.map((c) => ({
        key: c.id,
        title: chatTitle(c),
        sub: isChannel(c) ? `Channel · ${c.followers} followers` : isGroupish(c) ? `${c.members.filter((m) => !m.left).length} members` : c.members.find((m) => !isMe(m.userId))?.userId || 'Message yourself',
        av: chatAvatar(c),
        chatId: async () => c.id,
      })),
      ...[...S.users.values()].filter((u) => !withDirect.has(u.id) && !u.blocked).map((u) => ({
        key: `user:${u.id}`,
        title: isMe(u.id) ? `${u.name} (You)` : u.name,
        sub: isMe(u.id) ? 'Message yourself' : u.id,
        av: u,
        chatId: async () => {
          const { chat } = await api.post('/api/chats/direct', { userId: u.id });
          S.chats.set(chat.id, chat);
          return chat.id;
        },
      })),
    ];
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = entries.filter((e) => !q || e.title.toLowerCase().includes(q) || e.sub.toLowerCase().includes(q));
      reconcile(list, shown.map((e) => h(
        'div',
        {
          class: 'row',
          onclick: () => {
            if (chosen.has(e.key)) chosen.delete(e.key);
            else if (chosen.size < max) chosen.set(e.key, e);
            else toast(`You can share with up to ${max} chats`);
            draw();
          },
        },
        avatar(e.av),
        h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, e.title), h('div', { class: 'preview ellipsis' }, e.sub)),
        h('input', { type: 'checkbox', checked: chosen.has(e.key), tabindex: -1 }),
      )));
      if (!shown.length) list.append(h('div', { class: 'empty' }, 'No matches'));
      const ok = d?.box.querySelector('footer .btn.primary');
      if (ok) ok.disabled = !chosen.size;
    };
    const d = dialog({
      title,
      content: [h('label', { class: 'field' }, search), list],
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        {
          label: okLabel,
          kind: 'primary',
          disabled: true,
          onClick: async (close) => {
            try {
              result = await Promise.all([...chosen.values()].map((e) => e.chatId()));
            } catch (err) {
              toast(err.message);
              return;
            }
            close();
          },
        },
      ],
      onClose: () => resolve(result),
    });
    draw();
  });
}

export async function forwardDialog(m) {
  const ids = await pickChats({ title: 'Forward message to' });
  if (!ids?.length) return;
  try {
    await forwardMessage(m, ids);
    toast(ids.length === 1 ? 'Message forwarded' : `Forwarded to ${ids.length} chats`);
  } catch (err) {
    toast(err.message);
  }
}

function radioDialog(title, options, current, onPick, note) {
  let picked = current;
  const rows = options.map(([value, label]) =>
    h('label', { class: 'radio-row' }, h('input', { type: 'radio', name: 'opt', checked: value === current, onchange: () => (picked = value) }), label),
  );
  dialog({
    title,
    content: [note ? h('p', { class: 'muted' }, note) : null, ...rows],
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      { label: 'OK', kind: 'primary', onClick: (close) => { close(); onPick(picked); } },
    ],
  });
}

export function muteDialog(chat) {
  const hour = 3600_000;
  radioDialog(
    'Mute notifications',
    [[8 * hour, '8 hours'], [7 * 24 * hour, '1 week'], [-1, 'Always']],
    8 * hour,
    (ms) => {
      const until = ms === -1 ? 2 ** 53 - 1 : Date.now() + ms;
      api.patch(`/api/chats/${encodeURIComponent(chat.id)}/prefs`, { mutedUntil: until }).catch((e) => toast(e.message));
    },
    `Other people in the chat won't see that you muted it, and you'll still be notified if you're mentioned.`,
  );
}

export function disappearingDialog(chat) {
  radioDialog(
    'Disappearing messages',
    [[86400, '24 hours'], [7 * 86400, '7 days'], [90 * 86400, '90 days'], [0, 'Off']],
    chat.disappearing || 0,
    (secs) => {
      if (secs === (chat.disappearing || 0)) return;
      api.patch(`/api/chats/${encodeURIComponent(chat.id)}`, { disappearing: secs }).catch((e) => toast(e.message));
    },
    'New messages in this chat will disappear for everyone after the selected time. The server deletes them and their files.',
  );
}

export async function securityCodeDialog(chat) {
  let devices;
  try {
    ({ devices } = await api.get(`/api/chats/${encodeURIComponent(chat.id)}/devices`));
  } catch (err) {
    toast(err.message);
    return;
  }
  const code = await securityCode(devices);
  const people = chat.type === 'group' ? 'everyone in this group' : nameOf(chat.members.find((m) => !isMe(m.userId))?.userId || S.me.id);
  dialog({
    title: 'Verify security code',
    content: [
      h('div', { class: 'card center' }, icon('shield'), h('div', { class: 'code' }, code.split(' ').map((g) => h('span', null, g)))),
      h('p', null, `To verify that messages and calls with ${people} are end-to-end encrypted, compare this code with the one on their device. It covers the ${devices.length} linked device${devices.length === 1 ? '' : 's'} in this chat.`),
      h('p', { class: 'muted' }, 'The code changes when someone links a new device or logs one out. Tailchat encrypts every message on your device before it leaves; the server only ever stores ciphertext.'),
    ],
    actions: [
      { label: 'Copy code', onClick: () => navigator.clipboard.writeText(code).then(() => toast('Code copied')) },
      { label: 'Done', kind: 'primary', onClick: (close) => close() },
    ],
  });
}

// ---------- message details ----------

export function messageInfo(m, chat) {
  const others = chat.members.filter((x) => !x.left && !isMe(x.userId) && x.joinedSeq < m.seq);
  const read = others.filter((x) => x.readSeq >= m.seq);
  const delivered = others.filter((x) => x.readSeq < m.seq && x.deliveredSeq >= m.seq);
  const waiting = others.filter((x) => x.deliveredSeq < m.seq);
  const section = (title, iconName, list, cls = '') =>
    list.length
      ? [
        h('div', { class: `list-section ${cls}` }, icon(iconName), ` ${title}`),
        list.map((x) => userRow(S.users.get(x.userId) || { id: x.userId, name: nameOf(x.userId) }, null)),
      ]
      : null;
  dialog({
    title: 'Message info',
    flush: true,
    content: [
      h('div', { class: 'card' }, h('div', { class: 'muted' }, `Sent ${dayLabel(m.createdAt)} at ${timeOf(m.createdAt)}`), h('div', null, previewText(m))),
      section('Read by', 'checks', read),
      section('Delivered to', 'checks', delivered),
      section('Not delivered yet', 'check', waiting),
      !others.length ? h('p', { class: 'empty' }, 'Nobody else was in this chat when you sent it.') : null,
      chat.type === 'direct' && delivered.length && !read.length ? h('p', { class: 'muted card' }, 'If read receipts are turned off on either side, messages show as delivered only.') : null,
    ],
  });
}

const FOLLOWER = { id: 'follower', name: 'A follower', about: 'Followers stay anonymous' };

export function reactionsDialog(m) {
  const d = dialog({
    title: `${m.reactions.length} reaction${m.reactions.length === 1 ? '' : 's'}`,
    flush: true,
    content: h('div', { class: 'pick-list' }, m.reactions.map((r) => {
      const u = r.userId ? S.users.get(r.userId) || { id: r.userId, name: nameOf(r.userId) } : FOLLOWER;
      return userRow(u, h('span', { class: 'jumbo-react' }, r.emoji), isMe(r.userId)
        ? () => {
          api.post(`/api/messages/${encodeURIComponent(m.id)}/react`, { emoji: null }).catch((e) => toast(e.message));
          d.close();
        }
        : null);
    })),
  });
}

export function pollVotesDialog(m, c) {
  const options = Array.isArray(c.options) ? c.options.map((o) => str(o, 200)) : [];
  dialog({
    title: str(c.question, 300) || 'Poll',
    flush: true,
    content: options.map((label, i) => {
      const voters = (m.votes || []).filter((v) => v.options.includes(i));
      return [
        h('div', { class: 'list-section' }, `${label} · ${voters.length} vote${voters.length === 1 ? '' : 's'}`),
        voters.map((v) => userRow(v.userId ? S.users.get(v.userId) || { id: v.userId, name: nameOf(v.userId) } : FOLLOWER, null)),
      ];
    }),
  });
}

// ---------- media ----------

export async function openMedia(m, c) {
  if (!c?.file) return;
  let entry;
  try {
    entry = await ensureFile(c.file);
  } catch (err) {
    toast(err.message);
    return;
  }
  const isVideo = c.kind === 'video';
  const content = isVideo ? h('video', { src: entry.url, controls: true, autoplay: true, playsInline: true }) : h('img', { src: entry.url, alt: str(c.caption, 200) });
  viewer({
    title: isMe(m.senderId) ? 'You' : nameOf(m.senderId),
    subtitle: `${dayLabel(m.createdAt)} at ${timeOf(m.createdAt)}`,
    content,
    caption: str(c.caption) || null,
    actions: [iconButton('download', 'Download', () => saveBlob(entry.blob, c.file.name || 'file'))],
  });
}

// View once: decrypt, tell the server it was opened (it then refuses to
// serve the file to you again), show it, and drop the decrypted copy on close.
export async function openViewOnce(m, c) {
  let entry;
  try {
    entry = await ensureFile(c.file);
  } catch (err) {
    toast(err.message);
    return;
  }
  api.post(`/api/messages/${encodeURIComponent(m.id)}/opened`).catch(() => {});
  const content = c.kind === 'video' ? h('video', { src: entry.url, controls: true, autoplay: true, playsInline: true, controlsList: 'nodownload' }) : h('img', { src: entry.url, alt: '', draggable: false });
  content.addEventListener('contextmenu', (e) => e.preventDefault());
  viewer({
    title: nameOf(m.senderId),
    subtitle: 'View once',
    content,
    onClose: () => {
      URL.revokeObjectURL(entry.url);
      S.files.delete(c.file.id);
      render();
    },
  });
}

// ---------- status ----------

export function statusGroups() {
  const byUser = new Map();
  const list = [...S.statuses.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const s of list) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }
  return byUser;
}

export const STATUS_COLORS = ['#128c7e', '#25d366', '#34b7f1', '#7e57c2', '#ec407a', '#ff7043', '#5c6bc0', '#26a69a', '#8d6e63', '#54656f'];

export function openStatus(userId) {
  const groups = statusGroups();
  const order = [...groups.keys()].filter((u) => !isMe(u));
  let uid = userId;
  let list = groups.get(uid) || [];
  if (!list.length) return;
  let i = Math.max(0, list.findIndex((s) => !s.seen && !isMe(s.userId)));
  let timer;
  let raf;
  let paused = false;
  let started = 0;
  let elapsed = 0;
  let total = 5000;
  const el = h('div', { class: 'viewer status-viewer', role: 'dialog', 'aria-modal': 'true' });
  layer().append(el);
  const onKey = (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
  };
  document.addEventListener('keydown', onKey);

  function close() {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    el.remove();
    document.removeEventListener('keydown', onKey);
    render();
  }
  function next() {
    if (i < list.length - 1) i++;
    else {
      const k = order.indexOf(uid);
      if (k < 0 || k === order.length - 1) return close();
      uid = order[k + 1];
      list = groups.get(uid);
      i = 0;
    }
    show();
  }
  function prev() {
    if (i > 0) i--;
    else {
      const k = order.indexOf(uid);
      if (k > 0) {
        uid = order[k - 1];
        list = groups.get(uid);
        i = list.length - 1;
      }
    }
    show();
  }
  function run(ms, fill) {
    total = ms;
    elapsed = 0;
    started = performance.now();
    const tick = () => {
      if (!paused) {
        const now = performance.now();
        elapsed += now - started;
        started = now;
        fill.style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
        if (elapsed >= total) return next();
      } else started = performance.now();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  async function show() {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    paused = false;
    const s = list[i];
    const own = isMe(s.userId);
    if (!own && !s.seen) {
      s.seen = true;
      api.post(`/api/status/${encodeURIComponent(s.id)}/view`).catch(() => {});
    }
    const user = own ? S.me : S.users.get(s.userId) || { id: s.userId, name: nameOf(s.userId) };
    const fills = list.map((_, j) => {
      const f = h('i');
      if (j < i) f.style.width = '100%';
      return f;
    });
    const stage = h('div', { class: 'stage' }, h('div', { class: 'muted' }, 'Decrypting…'));
    const footer = h('div', { class: 'caption' });
    if (own) {
      const viewers = s.viewers || [];
      footer.append(h('button', { type: 'button', class: 'btn plain', onclick: () => { paused = true; viewersDialog(viewers, () => (paused = false)); } }, `👁 ${viewers.length} view${viewers.length === 1 ? '' : 's'}`));
    } else {
      const input = h('input', { placeholder: 'Reply…', maxlength: 2000, onfocus: () => (paused = true), onblur: () => (paused = false) });
      const send = async () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        try {
          const { chat } = await api.post('/api/chats/direct', { userId: s.userId });
          S.chats.set(chat.id, chat);
          const c = S.statusContent.get(s.id)?.ok;
          await sendText(chat.id, text, { replyTo: { id: s.id, senderId: s.userId, preview: `Status · ${c?.type === 'text' ? str(c.text, 80) : c?.kind === 'video' ? '🎥 Video' : '📷 Photo'}` } });
          toast('Reply sent');
        } catch (err) {
          toast(err.message);
        }
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
      footer.append(h('div', { class: 'status-reply' }, input, iconButton('send', 'Send', send)));
    }
    reconcile(el, [
      h('div', { class: 'bars' }, fills.map((f) => h('span', null, f))),
      h(
        'header',
        null,
        avatar(user, 'sm'),
        h('div', { class: 'grow' }, h('div', null, own ? 'My status' : user.name), h('div', { class: 'muted' }, listTime(s.createdAt))),
        own ? iconButton('delete', 'Delete status', async () => {
          await api.del(`/api/status/${encodeURIComponent(s.id)}`).catch((e) => toast(e.message));
          close();
        }) : null,
        iconButton('close', 'Close', close),
      ),
      stage,
      h('button', { class: 'nav prev', type: 'button', 'aria-label': 'Previous', onclick: prev }),
      h('button', { class: 'nav next', type: 'button', 'aria-label': 'Next', onclick: next }),
      footer,
    ]);
    const res = await statusContentOf(s);
    if (list[i] !== s || !el.isConnected) return;
    const c = res.ok;
    if (!c) {
      stage.replaceChildren(h('div', { class: 'text-status' }, "This status update couldn't be decrypted on this device."));
      return run(4000, fills[i]);
    }
    if (c.type === 'text') {
      const t = h('div', { class: 'text-status' }, str(c.text, 700));
      t.style.background = safeColor(c.color);
      stage.replaceChildren(t);
      return run(Math.min(15000, 3000 + str(c.text).length * 60), fills[i]);
    }
    let entry;
    try {
      entry = await ensureFile(c.file);
    } catch {
      stage.replaceChildren(h('div', { class: 'text-status' }, 'This status update is no longer available.'));
      return run(3000, fills[i]);
    }
    if (list[i] !== s || !el.isConnected) return;
    if (c.caption) footer.prepend(h('div', null, str(c.caption, 700)));
    if (c.kind === 'video') {
      const v = h('video', { src: entry.url, autoplay: true, playsInline: true });
      v.addEventListener('loadedmetadata', () => run(Number.isFinite(v.duration) ? Math.min(v.duration, 60) * 1000 : 15000, fills[i]), { once: true });
      stage.replaceChildren(v);
    } else {
      stage.replaceChildren(h('img', { src: entry.url, alt: '' }));
      run(6000, fills[i]);
    }
  }
  show();
}

function viewersDialog(viewers, onClose) {
  dialog({
    title: `Viewed by ${viewers.length}`,
    flush: true,
    content: viewers.length
      ? viewers.map((v) => userRow(S.users.get(v.userId) || { id: v.userId, name: nameOf(v.userId) }, h('span', { class: 'time muted' }, listTime(v.at))))
      : h('p', { class: 'empty' }, 'No views yet'),
    onClose,
  });
}

export function textStatusDialog() {
  let color = STATUS_COLORS[0];
  const ta = h('textarea', { rows: 4, maxlength: 700, placeholder: 'Type a status' });
  const area = h('div', { class: 'status-compose' }, ta);
  area.style.background = color;
  const swatches = h('div', { class: 'swatches' }, STATUS_COLORS.map((c) => {
    const b = h('button', { type: 'button', class: c === color ? 'active' : '', 'aria-label': 'Background colour', onclick: () => {
      color = c;
      area.style.background = c;
      for (const x of swatches.children) x.classList.toggle('active', x === b);
    } });
    b.style.background = c;
    return b;
  }));
  dialog({
    title: 'Text status',
    content: [area, swatches, h('p', { class: 'muted' }, `Status updates are end-to-end encrypted and disappear after 24 hours. Everyone using Tailchat on your tailnet can see them, except people you've blocked.`)],
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Post',
        kind: 'primary',
        onClick: async (close) => {
          const text = ta.value.trim();
          if (!text) return;
          close();
          try {
            await postStatus({ type: 'text', text, color });
            toast('Status posted');
          } catch (err) {
            toast(err.message);
          }
        },
      },
    ],
  });
}

export function mediaStatusDialog(file) {
  const kind = kindFor(file);
  if (kind !== 'image' && kind !== 'video' && kind !== 'gif') {
    toast('Status updates can be photos or videos');
    return;
  }
  const url = URL.createObjectURL(file);
  const caption = h('input', { maxlength: 700, placeholder: 'Add a caption' });
  dialog({
    title: 'New status',
    content: [
      h('div', { class: 'upload-preview' }, kind === 'video' ? h('video', { src: url, controls: true }) : h('img', { src: url, alt: '' })),
      h('label', { class: 'field' }, caption),
    ],
    onClose: () => URL.revokeObjectURL(url),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Post',
        kind: 'primary',
        onClick: async (close) => {
          const text = caption.value.trim();
          close();
          toast('Posting status…');
          try {
            await postStatus({ type: 'media', kind, caption: text || undefined }, file);
            toast('Status posted');
          } catch (err) {
            toast(err.message);
          }
        },
      },
    ],
  });
}

// ---------- calls ----------

const callUi = { el: null, incoming: new Map(), tiles: new Map(), self: null, clock: null };

function callTitle(chatId) {
  const chat = S.chats.get(chatId);
  return chat ? chatTitle(chat) : 'Tailchat call';
}

export function renderCalls() {
  if (!calls) return;
  // Incoming call cards (only while not already in a call).
  const ringing = calls.call ? [] : [...calls.incoming.values()];
  for (const [id, el] of callUi.incoming) {
    if (!ringing.some((r) => r.callId === id)) {
      el.remove();
      callUi.incoming.delete(id);
    }
  }
  for (const ring of ringing) {
    if (callUi.incoming.has(ring.callId)) continue;
    const chat = S.chats.get(ring.chatId);
    const caller = S.users.get(ring.from) || { id: ring.from, name: nameOf(ring.from) };
    const accept = () => calls.accept(ring.callId).catch((e) => toast(e.message));
    const el = h(
      'div',
      { class: 'incoming', role: 'alertdialog', 'aria-label': 'Incoming call' },
      h('div', { class: 'who' }, avatar(chat?.type === 'group' ? chatAvatar(chat) : caller, 'md'), h('div', null, h('div', { class: 'name' }, chat?.type === 'group' ? chatTitle(chat) : caller.name), h('div', { class: 'muted' }, `${chat?.type === 'group' ? `${caller.name} · ` : ''}Incoming ${ring.video ? 'video' : 'voice'} call`))),
      h(
        'div',
        { class: 'btns' },
        h('button', { type: 'button', class: 'decline', onclick: () => calls.decline(ring.callId) }, icon('hangup'), 'Decline'),
        h('button', { type: 'button', class: 'accept', onclick: accept }, icon(ring.video ? 'video' : 'phone'), 'Accept'),
      ),
    );
    callUi.incoming.set(ring.callId, el);
    layer().append(el);
  }

  const call = calls.call;
  if (!call) {
    if (callUi.el) {
      callUi.el.remove();
      callUi.el = null;
      callUi.tiles.clear();
      callUi.self = null;
      clearInterval(callUi.clock);
    }
    return;
  }
  if (!callUi.el) {
    callUi.el = h('div', { class: 'call-screen', role: 'dialog', 'aria-label': 'Call' });
    layer().append(callUi.el);
    callUi.clock = setInterval(render, 1000);
  }
  const chat = S.chats.get(call.chatId);
  const peers = [...call.peers.entries()];
  const state = call.status === 'active'
    ? duration((Date.now() - (call.startedAt || Date.now())) / 1000)
    : call.status === 'ringing'
      ? call.declined && chat?.type !== 'group' ? 'Declined' : 'Ringing…'
      : 'Connecting…';
  const anyVideo = call.video || peers.some(([, p]) => p.stream.getVideoTracks().length);
  const group = chat?.type === 'group';

  const used = new Set();
  const tiles = peers.map(([deviceId, p]) => {
    used.add(deviceId);
    let t = callUi.tiles.get(deviceId);
    if (!t) {
      const video = h('video', { autoplay: true, playsInline: true });
      video.srcObject = p.stream;
      const label = h('div', { class: 'label' });
      const face = h('div', { class: 'face' });
      t = { el: h('div', { class: 'tile' }, face, video, label), video, label, face };
      callUi.tiles.set(deviceId, t);
    }
    if (t.video.srcObject !== p.stream) t.video.srcObject = p.stream;
    const hasVideo = p.stream.getVideoTracks().some((tr) => tr.readyState === 'live' && !tr.muted);
    t.video.classList.toggle('invisible', !hasVideo);
    const u = S.users.get(p.userId) || { id: p.userId, name: nameOf(p.userId) };
    reconcile(t.face, hasVideo ? [] : [avatar(u, 'lg')]);
    t.label.textContent = `${u.name}${p.state === 'failed' ? ' · connection lost' : p.state !== 'connected' ? ' · connecting…' : ''}`;
    return t.el;
  });
  for (const id of callUi.tiles.keys()) if (!used.has(id)) callUi.tiles.delete(id);

  const localVideo = call.local?.getVideoTracks()[0];
  if (localVideo && !call.cameraOff) {
    if (!callUi.self) {
      const v = h('video', { autoplay: true, playsInline: true, muted: true });
      v.srcObject = call.local;
      callUi.self = h('div', { class: 'self-view' }, v);
    }
  } else callUi.self = null;

  const ctl = (name, title, on, onClick, cls = '') =>
    h('button', { type: 'button', class: `${on ? 'off' : ''} ${cls}`, title, 'aria-label': title, onclick: () => Promise.resolve(onClick()).catch((e) => toast(e.message)) }, icon(name));
  const avatarInfo = chat ? chatAvatar(chat) : { id: call.chatId, name: '?' };
  reconcile(callUi.el, [
    h(
      'div',
      { class: 'call-head' },
      (!anyVideo && !group) || !peers.length ? avatar(avatarInfo, 'lg') : null,
      h('div', { class: 'who' }, callTitle(call.chatId)),
      h('div', { class: 'state' }, `${call.video ? 'Video' : 'Voice'} call · end-to-end encrypted · ${state}`),
    ),
    // A one-to-one voice call shows just the big avatar; the tile stays in
    // the page because its <video> element plays the other person's audio.
    h('div', { class: `videos${anyVideo ? '' : ' audio-only'}${!anyVideo && !group ? ' solo' : ''}` }, tiles),
    callUi.self,
    h(
      'div',
      { class: 'controls' },
      ctl(call.muted ? 'micOff' : 'mic', call.muted ? 'Unmute' : 'Mute', call.muted, () => calls.toggleMute()),
      ctl(call.cameraOff ? 'videoOff' : 'video', call.cameraOff ? 'Turn camera on' : 'Turn camera off', call.cameraOff, () => calls.toggleCamera()),
      navigator.mediaDevices?.getDisplayMedia ? ctl('screen', call.sharing ? 'Stop sharing' : 'Share screen', call.sharing, () => calls.toggleScreen()) : null,
      ctl('hangup', 'End call', false, () => calls.hangup(), 'hang'),
    ),
  ]);
}

export async function startCall(chat, video) {
  if (!chat) return;
  if (chat.type === 'direct' && chat.members.every((m) => isMe(m.userId))) {
    toast("You can't call yourself");
    return;
  }
  try {
    await calls.start(chat.id, video);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- group invites ----------

export async function handleInvite(code) {
  history.replaceState(null, '', '/');
  let chat;
  try {
    ({ chat } = await api.get(`/api/invite/${encodeURIComponent(code)}`));
  } catch (err) {
    toast(err.message);
    return;
  }
  if (chat.isMember) {
    openChat(chat.id);
    return;
  }
  const kind = { community: 'Community', channel: 'Channel' }[chat.type] || 'Group';
  const people = chat.type === 'channel' ? 'follower' : 'member';
  dialog({
    title: `${kind} invite`,
    content: h(
      'div',
      { class: 'card center' },
      avatar({ id: chat.id, name: chat.name, src: chat.avatar, group: true }, 'lg'),
      h('h2', null, chat.name),
      h('h3', null, `${kind} · ${chat.memberCount} ${people}${chat.memberCount === 1 ? '' : 's'}`),
      chat.description ? h('p', { class: 'about' }, chat.description) : null,
      chat.type === 'channel' ? h('p', { class: 'muted small' }, "Channel posts aren't end-to-end encrypted. Other followers won't see that you follow it.") : null,
    ),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: chat.type === 'channel' ? 'Follow' : `Join ${kind.toLowerCase()}`,
        kind: 'primary',
        onClick: async (close) => {
          try {
            const res = await api.post(`/api/invite/${encodeURIComponent(code)}/join`);
            S.chats.set(res.chat.id, res.chat);
            close();
            openChat(res.chat.id);
          } catch (err) {
            toast(err.message);
          }
        },
      },
    ],
  });
}

export function fileTooBig(file) {
  // 16-byte tag per 1 MiB chunk on top of the file itself.
  const encrypted = file.size + 16 * (Math.ceil(file.size / 1048576) || 1);
  if (S.limits.maxUploadBytes && encrypted > S.limits.maxUploadBytes) {
    toast(`${file.name} is larger than ${fileSize(S.limits.maxUploadBytes)}, the limit on this server`);
    return true;
  }
  return false;
}
