// The open chat: header, pinned message, message list and composer.
import * as A from './app.js';
import { S, api, render } from './app.js';
import {
  h, icon, iconButton, avatar, richText, isJumboEmoji, timeOf, dayLabel, lastSeenText, fileSize, duration, colorFor,
  toast, menu, closeMenu, dialog, confirmDialog, emojiPicker, QUICK_REACTIONS, reconcile, Slots,
} from './ui.js';
import { extensionOf, kindFor, VoiceRecorder } from './media.js';
import * as O from './overlays.js';

const { str, num, safeThumb } = O;
export const drafts = new Map(); // chatId -> unsent text
const slots = new Slots();

// ---------- shared actions ----------

function latest(m) {
  return A.box(m.chatId).list.find((x) => x.id === m.id) || m;
}

export function replyRef(m) {
  return { id: m.id, senderId: m.senderId, preview: A.previewText(m).slice(0, 140) };
}

export function canSend(chat) {
  if (chat.me.left) return { text: "You can't send messages to this group because you're no longer a member." };
  if (chat.type === 'group' && chat.adminsOnlySend && chat.me.role !== 'admin') return { text: 'Only admins can send messages.' };
  if (chat.type === 'direct') {
    const other = S.users.get(A.otherMember(chat));
    if (other && !A.isMe(other.id) && other.blocked) {
      return { text: `You blocked ${other.name}. Click to unblock.`, action: () => api.del(`/api/blocks/${encodeURIComponent(other.id)}`).catch((e) => toast(e.message)) };
    }
  }
  return null;
}

async function react(m, emoji) {
  m = latest(m);
  const mine = m.reactions?.find((r) => A.isMe(r.userId));
  try {
    await api.post(`/api/messages/${encodeURIComponent(m.id)}/react`, { emoji: mine?.emoji === emoji ? null : emoji });
  } catch (err) {
    toast(err.message);
  }
}

function reactMenu(m, anchor) {
  menu(anchor, [{ label: 'More reactions', icon: 'emoji', onClick: () => emojiPicker(anchor, (e) => { closeMenu(); react(m, e); }) }], {
    quick: QUICK_REACTIONS,
    onQuick: (e) => react(m, e),
  });
}

async function star(m) {
  m = latest(m);
  try {
    await api.post(`/api/messages/${encodeURIComponent(m.id)}/star`, { starred: !m.starred });
    S.starred = null;
    toast(m.starred ? 'Message unstarred' : 'Message starred');
  } catch (err) {
    toast(err.message);
  }
}

async function pin(chat, m) {
  try {
    await api.post(`/api/chats/${encodeURIComponent(chat.id)}/pin`, { messageId: chat.pinnedMessage === m.id ? null : m.id });
  } catch (err) {
    toast(err.message);
  }
}

function startReply(m) {
  S.reply = m;
  S.editing = null;
  render();
  setTimeout(() => comp?.ta?.focus(), 0);
}

function startEdit(m) {
  const c = A.contentOf(m)?.ok;
  if (!comp?.ta || c?.type !== 'text') return;
  if (!S.editing) comp.savedDraft = comp.ta.value;
  S.editing = m;
  S.reply = null;
  comp.ta.value = c.text;
  autosize(comp.ta);
  render();
  setTimeout(() => comp.ta.focus(), 0);
}

function deleteDialog(m, chat) {
  m = latest(m);
  if (m.pending || m.failed) {
    const b = A.box(m.chatId);
    b.list = b.list.filter((x) => x.id !== m.id);
    render();
    return;
  }
  const mine = A.isMe(m.senderId);
  const asAdmin = chat.type === 'group' && chat.me.role === 'admin' && !chat.me.left;
  const forEveryone = m.kind === 'msg' && !m.deletedAt && !chat.me.left
    && ((mine && Date.now() - m.createdAt < (S.limits.deleteWindowSeconds || 0) * 1000) || (!mine && asAdmin));
  const del = (everyone) => async (close) => {
    close();
    try {
      await api.del(`/api/messages/${encodeURIComponent(m.id)}${everyone ? '?for=everyone' : ''}`);
    } catch (err) {
      toast(err.message);
    }
  };
  dialog({
    title: 'Delete message?',
    content: h('p', { class: 'muted' }, forEveryone && !mine ? `As a group admin you can delete ${A.nameOf(m.senderId)}'s message for everyone.` : 'Deleting for everyone removes the message and its files from the server.'),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      { label: 'Delete for me', onClick: del(false) },
      forEveryone ? { label: 'Delete for everyone', kind: 'danger', onClick: del(true) } : null,
    ].filter(Boolean),
  });
}

export function messageMenu(m, chat, anchor) {
  m = latest(m);
  const res = A.contentOf(m);
  const c = res?.ok;
  const mine = A.isMe(m.senderId);
  const live = m.kind === 'msg' && !m.pending && !m.failed && !m.deletedAt && c && !['deleted', 'opened'].includes(c.type);
  const active = !chat.me.left;
  const mayPin = active && (chat.type !== 'group' || !chat.adminsOnlyEdit || chat.me.role === 'admin');
  const editable = mine && live && c.type === 'text' && !m.viewOnce && Date.now() - m.createdAt < (S.limits.editWindowSeconds || 0) * 1000;
  menu(
    anchor,
    [
      live && active && !canSend(chat) ? { label: 'Reply', icon: 'reply', onClick: () => startReply(m) } : null,
      live && c.type === 'text' ? { label: 'Copy', icon: 'copy', onClick: () => navigator.clipboard.writeText(c.text).then(() => toast('Message copied')) } : null,
      live && !m.viewOnce ? { label: 'Forward', icon: 'forward', onClick: () => O.forwardDialog(m) } : null,
      live && c.type === 'media' && !m.viewOnce ? { label: 'Download', icon: 'download', onClick: () => O.downloadFile(c.file) } : null,
      m.kind === 'msg' && !m.pending && !m.failed ? { label: m.starred ? 'Unstar' : 'Star', icon: 'star', onClick: () => star(m) } : null,
      live && mayPin ? { label: chat.pinnedMessage === m.id ? 'Unpin' : 'Pin', icon: 'pin', onClick: () => pin(chat, m) } : null,
      editable ? { label: 'Edit', icon: 'edit', onClick: () => startEdit(m) } : null,
      mine && live ? { label: 'Message info', icon: 'info', onClick: () => O.messageInfo(m, chat) } : null,
      m.failed && m.retry ? { label: 'Try again', icon: 'send', onClick: () => m.retry().catch(() => {}) } : null,
      m.kind === 'msg' ? { label: 'Delete', icon: 'delete', danger: true, onClick: () => deleteDialog(m, chat) } : null,
    ],
    live && active ? { quick: QUICK_REACTIONS, onQuick: (e) => react(m, e) } : {},
  );
}

// Scrolls to a message, loading older pages until it turns up.
export async function jumpTo(chatId, messageId) {
  if (!messageId) return;
  const b = A.box(chatId);
  for (let i = 0; i < 40 && !b.list.some((m) => m.id === messageId); i++) {
    if (!b.hasMore) break;
    await A.loadMessages(chatId, { older: true });
  }
  if (!b.list.some((m) => m.id === messageId)) {
    toast("That message isn't available anymore");
    return;
  }
  A.openChat(chatId, { highlight: messageId });
}

// ---------- voice notes and audio ----------

const player = { id: null, audio: null, playing: false, progress: 0, length: 0 };

function stopPlayer() {
  player.audio?.pause();
  player.audio = null;
  player.id = null;
  player.playing = false;
  player.progress = 0;
}

async function playAudio(m, c, seekTo) {
  if (player.id === m.id && player.audio) {
    if (seekTo !== undefined) player.audio.currentTime = seekTo * (player.length || 0);
    else if (player.audio.paused) player.audio.play();
    else player.audio.pause();
    return;
  }
  stopPlayer();
  player.id = m.id;
  render();
  let entry;
  try {
    entry = await A.ensureFile(c.file);
  } catch (err) {
    toast(err.message);
    player.id = null;
    return;
  }
  if (player.id !== m.id) return;
  const audio = new Audio(entry.url);
  player.audio = audio;
  // Recorded WebM has no duration header, so fall back to the sender's figure.
  const length = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : num(c.duration) || 0);
  audio.addEventListener('loadedmetadata', () => {
    player.length = length();
    if (seekTo !== undefined) audio.currentTime = seekTo * player.length;
  });
  audio.addEventListener('timeupdate', () => {
    player.length = length();
    player.progress = player.length ? Math.min(1, audio.currentTime / player.length) : 0;
    render();
  });
  audio.addEventListener('play', () => { player.playing = true; render(); });
  audio.addEventListener('pause', () => { player.playing = false; render(); });
  audio.addEventListener('ended', () => { stopPlayer(); render(); });
  audio.play().catch((err) => toast(err.message));
}

function voiceBlock(m, c) {
  const playing = player.id === m.id;
  const fs = c.file?.id ? S.files.get(c.file.id) : null;
  const wave = Array.isArray(c.waveform) && c.waveform.length ? c.waveform.slice(0, 64).map((v) => Math.max(8, Math.min(100, num(v) || 0))) : Array(40).fill(20);
  const done = playing ? Math.floor(player.progress * wave.length) : -1;
  const bars = h(
    'div',
    {
      class: 'wave',
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        playAudio(m, c, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      },
    },
    wave.map((v, i) => {
      const s = h('span', { class: i < done ? 'played' : '' });
      s.style.height = `${v}%`;
      return s;
    }),
  );
  const loading = playing && !player.audio && fs?.progress !== undefined;
  const length = num(c.duration);
  return h(
    'div',
    { class: 'voice' },
    c.kind === 'voice' ? avatar(S.users.get(m.senderId) || { id: m.senderId, name: A.nameOf(m.senderId) }, 'sm') : h('div', { class: 'doc-icon' }, '♪'),
    h('button', { type: 'button', class: 'play', 'aria-label': playing && player.playing ? 'Pause' : 'Play', onclick: () => playAudio(m, c) }, icon(playing && player.playing ? 'pause' : 'play')),
    h(
      'div',
      { class: 'grow' },
      c.kind !== 'voice' ? h('div', { class: 'ellipsis' }, str(c.file?.name, 200) || 'Audio') : null,
      bars,
      h('div', { class: 'dur' }, loading ? `Downloading ${Math.round(fs.progress * 100)}%` : playing && player.length ? `${duration(player.progress * player.length)} / ${duration(player.length)}` : length ? duration(length) : ''),
    ),
  );
}

// ---------- message rendering ----------

function autoDownload(c) {
  const f = c.file;
  return f?.id && ['image', 'gif', 'sticker'].includes(c.kind) && (num(f.size) || 0) <= 16 * 1048576;
}

function stickToBottom() {
  if (mv?.atBottom) mv.el.scrollTop = mv.el.scrollHeight;
}

function mediaBlock(m, c) {
  const file = c.file || {};
  const fs = file.id ? S.files.get(file.id) : null;
  const up = S.uploads.get(m.id);
  const thumb = safeThumb(c.thumb);
  const w = num(c.width);
  const ht = num(c.height);
  const isVideo = c.kind === 'video';
  if (!fs && autoDownload(c)) A.ensureFile(file).catch(() => {});
  const wrap = h('div', { class: 'media', onclick: () => O.openMedia(m, c) });
  let img = null;
  if (fs?.url && !isVideo) img = h('img', { src: fs.url, alt: str(c.caption, 200) });
  else if (thumb) img = h('img', { src: thumb, alt: '', class: isVideo ? '' : 'blur' });
  if (img) {
    if (w && ht) img.style.aspectRatio = `${w} / ${ht}`;
    img.addEventListener('load', stickToBottom, { once: true });
    wrap.append(img);
  }
  if (isVideo) {
    wrap.append(h('div', { class: 'overlay-btn' }, icon('play')));
    if (num(c.duration)) wrap.append(h('span', { class: 'media-badge' }, icon('video'), duration(c.duration)));
  } else if (!fs?.url && up === undefined) {
    if (fs?.error) wrap.append(h('div', { class: 'overlay-btn', title: fs.error }, icon('info')));
    else if (fs?.progress === undefined) wrap.append(h('div', { class: 'overlay-btn' }, icon('download')), h('span', { class: 'media-badge' }, fileSize(num(file.size) || 0)));
  }
  const p = up !== undefined ? up : fs?.progress;
  if (p !== undefined) {
    const bar = h('div', { class: 'progress' });
    bar.style.width = `${Math.round(p * 100)}%`;
    wrap.append(bar);
  }
  return wrap;
}

function docBlock(m, c) {
  const file = c.file || {};
  const name = str(file.name, 200) || 'Document';
  const ext = extensionOf(name);
  const fs = file.id ? S.files.get(file.id) : null;
  const up = S.uploads.get(m.id);
  const p = up !== undefined ? up : fs?.progress;
  return h(
    'div',
    { class: 'doc', onclick: () => file.id && O.downloadFile(file), title: 'Download' },
    h('div', { class: 'doc-icon' }, ext.slice(0, 4)),
    h('div', { class: 'doc-body' }, h('div', { class: 'ellipsis' }, name), h('div', { class: 'doc-sub' }, `${fileSize(num(file.size) || 0)} · ${ext.toUpperCase()}`)),
    h('div', { class: 'dl' }, p !== undefined ? `${Math.round(p * 100)}%` : icon('download')),
  );
}

function pollBlock(m, c) {
  const options = Array.isArray(c.options) ? c.options.slice(0, 12).map((o) => str(o, 200)) : [];
  const votes = m.votes || [];
  const mine = votes.find((v) => A.isMe(v.userId))?.options || [];
  const counts = options.map((_, i) => votes.filter((v) => v.options.includes(i)).length);
  const total = votes.length;
  const vote = async (i) => {
    let next;
    if (c.multiple) next = mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i];
    else next = mine.includes(i) ? [] : [i];
    try {
      await api.post(`/api/messages/${encodeURIComponent(m.id)}/vote`, { options: next });
    } catch (err) {
      toast(err.message);
    }
  };
  return h(
    'div',
    { class: 'poll' },
    h('div', { class: 'question' }, str(c.question, 300)),
    h('div', { class: 'hint' }, c.multiple ? 'Select one or more' : 'Select one'),
    options.map((label, i) => {
      const bar = h('span');
      bar.style.width = total ? `${(counts[i] / total) * 100}%` : '0';
      return h(
        'button',
        { type: 'button', class: `option${c.multiple ? ' multiple' : ''}${mine.includes(i) ? ' chosen' : ''}`, onclick: () => vote(i), disabled: m.pending },
        h('div', { class: 'opt-line' }, h('span', { class: 'check' }), h('span', { class: 'label' }, label), h('span', { class: 'votes' }, String(counts[i]))),
        h('div', { class: 'bar' }, bar),
      );
    }),
    h('button', { type: 'button', class: 'view-votes', onclick: () => O.pollVotesDialog(m, c) }, total ? `View votes (${total})` : 'No votes yet'),
  );
}

function locationBlock(c) {
  const lat = num(c.lat);
  const lon = num(c.lon);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return h('div', { class: 'text' }, '📍 Location');
  const url = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
  return h(
    'a',
    { class: 'location', href: url, target: '_blank', rel: 'noopener noreferrer' },
    h('div', { class: 'map' }, icon('location')),
    h('div', { class: 'loc-body' }, h('div', null, str(c.name, 200) || 'Shared location'), h('div', { class: 'muted' }, `${lat.toFixed(5)}, ${lon.toFixed(5)}${num(c.accuracy) ? ` · ±${Math.round(c.accuracy)} m` : ''}`)),
  );
}

function contactBlock(c) {
  const userId = str(c.userId, 320);
  const u = S.users.get(userId);
  const name = u?.name || str(c.name, 100) || userId;
  return [
    h('div', { class: 'contact-card' }, avatar(u || { id: userId, name }, 'md'), h('div', null, h('div', null, name), h('div', { class: 'muted' }, userId))),
    u && !A.isMe(userId) ? h('button', { type: 'button', class: 'card-action', onclick: () => A.openDirect(userId).catch((e) => toast(e.message)) }, 'Message') : null,
  ];
}

function tickIcon(state, m) {
  switch (state) {
    case 'pending':
      return h('span', { title: 'Sending' }, icon('clock'));
    case 'failed':
      return h('span', { class: 'danger', title: 'Not sent. Click to try again', onclick: (e) => { e.stopPropagation(); m.retry?.().catch(() => {}); } }, icon('info'));
    case 'read':
      return h('span', { class: 'read', title: 'Read' }, icon('checks'));
    case 'delivered':
      return h('span', { title: 'Delivered' }, icon('checks'));
    default:
      return h('span', { title: 'Sent' }, icon('check'));
  }
}

function mentionMap(c) {
  const out = {};
  if (Array.isArray(c.mentions)) {
    for (const id of c.mentions.slice(0, 64)) if (typeof id === 'string') out[id] = A.isMe(id) ? S.me.name : A.nameOf(id);
  }
  return out;
}

function messageRow(m, chat, flags) {
  const res = A.contentOf(m);
  if (m.kind === 'system') return h('div', { class: 'system-msg' }, A.systemText(m, res.ok));
  const mine = A.isMe(m.senderId);
  const c = res?.ok;
  const parts = [];
  let mediaOnly = false;
  if (flags.showName) parts.push(h('div', { class: 'sender', style: { color: colorFor(m.senderId) } }, A.nameOf(m.senderId)));
  if (!res || res.pending) {
    parts.push(h('div', { class: 'text undecryptable' }, icon('clock'), 'Decrypting…'));
  } else if (res.error) {
    parts.push(h('div', { class: 'text undecryptable', title: res.error }, icon('lock'), res.code === 'NO_KEY' ? "This message was sent before this device was linked, so it can't be read here." : "This message couldn't be decrypted."));
  } else if (c.type === 'deleted') {
    parts.push(h('div', { class: 'text deleted' }, icon('block'), mine ? 'You deleted this message' : 'This message was deleted'));
  } else if (c.type === 'opened' || (m.viewOnce && !mine)) {
    const opened = c.type === 'opened';
    parts.push(h(
      'div',
      { class: `view-once${opened ? ' opened' : ''}`, onclick: opened ? null : () => O.openViewOnce(m, c) },
      icon('once'),
      opened ? 'Opened' : c.kind === 'video' ? 'Video' : 'Photo',
    ));
  } else {
    if (c.forwarded) parts.push(h('div', { class: 'forwarded' }, icon('forward'), (num(c.forwardCount) || 0) >= 5 ? 'Forwarded many times' : 'Forwarded'));
    const r = c.replyTo;
    if (r && typeof r === 'object') {
      const rid = str(r.senderId, 320);
      parts.push(h(
        'div',
        { class: 'quote', onclick: (e) => { e.stopPropagation(); jumpTo(m.chatId, str(r.id, 64)); } },
        h('div', { class: 'q-body' }, h('div', { class: 'q-name', style: { color: colorFor(rid) } }, A.isMe(rid) ? 'You' : A.nameOf(rid)), h('div', { class: 'q-text' }, str(r.preview, 300))),
      ));
    }
    if (m.viewOnce) {
      const opened = Array.isArray(m.opened) && m.opened.length;
      parts.push(h('div', { class: 'view-once opened' }, icon('once'), opened ? 'Opened' : c.kind === 'video' ? 'Video' : 'Photo'));
    } else {
      switch (c.type) {
        case 'text': {
          const text = str(c.text);
          parts.push(h('div', { class: `text${isJumboEmoji(text) ? ' jumbo' : ''}` }, richText(text, { mentions: mentionMap(c), highlight: flags.search })));
          break;
        }
        case 'media':
          if (['image', 'gif', 'sticker', 'video'].includes(c.kind)) {
            parts.push(mediaBlock(m, c));
            mediaOnly = !c.caption && !c.replyTo && !c.forwarded && !flags.showName;
          } else if (c.kind === 'voice' || c.kind === 'audio') parts.push(voiceBlock(m, c));
          else parts.push(docBlock(m, c));
          if (c.caption) parts.push(h('div', { class: 'text' }, richText(str(c.caption), { mentions: mentionMap(c), highlight: flags.search })));
          break;
        case 'location':
          parts.push(locationBlock(c));
          break;
        case 'contact':
          parts.push(contactBlock(c));
          break;
        case 'poll':
          parts.push(pollBlock(m, c));
          break;
        case 'call':
          parts.push(h('div', { class: 'text' }, `${c.video ? '🎥 Video' : '📞 Voice'} call${num(c.duration) ? ` · ${duration(c.duration)}` : ''}`));
          break;
        default:
          parts.push(h('div', { class: 'text undecryptable' }, icon('info'), 'This message needs a newer version of Tailchat.'));
      }
    }
  }
  parts.push(h(
    'span',
    { class: 'meta' },
    m.starred ? h('span', { class: 'star' }, icon('star')) : null,
    m.expiresAt ? h('span', { class: 'star', title: 'Disappearing message' }, icon('timer')) : null,
    m.editedAt && !m.deletedAt ? 'Edited ' : null,
    timeOf(m.createdAt),
    mine ? tickIcon(A.tickState(m, chat), m) : null,
  ));

  const live = m.kind === 'msg' && c && !m.pending && !m.failed && !m.deletedAt && !['deleted', 'opened'].includes(c.type) && !chat.me.left;
  const bubble = h(
    'div',
    {
      class: `bubble${mediaOnly ? ' media-only' : ''}`,
      oncontextmenu: (e) => {
        e.preventDefault();
        messageMenu(m, chat, { x: e.clientX, y: e.clientY });
      },
      ondblclick: (e) => {
        if (live && !canSend(chat) && !e.target.closest('a, button, .media')) startReply(m);
      },
    },
    h('button', { type: 'button', class: 'actions-btn', 'aria-label': 'Message options', onclick: (e) => { e.stopPropagation(); messageMenu(m, chat, e.currentTarget); } }, icon('down')),
    parts,
  );
  if (m.reactions?.length) {
    const emojis = [...new Set(m.reactions.map((r) => r.emoji))].slice(0, 3);
    bubble.append(h('button', { type: 'button', class: 'reactions', onclick: () => O.reactionsDialog(latest(m)) }, emojis, m.reactions.length > 1 ? h('span', { class: 'count' }, String(m.reactions.length)) : null));
  }
  const reactBtn = live ? h('button', { type: 'button', class: 'react-btn', 'aria-label': 'React', onclick: (e) => reactMenu(m, e.currentTarget) }, icon('emoji')) : null;
  return h(
    'div',
    { class: `msg-row ${mine ? 'out' : 'in'}${flags.first ? ' first' : ''}${m.reactions?.length ? ' has-reactions' : ''}`, dataset: { id: m.id } },
    mine ? [reactBtn, bubble] : [bubble, reactBtn],
  );
}

function rowSig(m, chat, flags) {
  const res = A.contentOf(m);
  const c = res?.ok;
  const fid = c?.file?.id;
  const fs = fid ? S.files.get(fid) : null;
  const up = S.uploads.get(m.id);
  return JSON.stringify([
    A.contentKey(m), res ? (res.ok ? 1 : res.error ? 2 : 0) : 0, m.kind === 'system' ? m.payload : 0,
    m.reactions, m.votes, m.starred, m.opened, m.pending, m.failed, m.deletedAt, m.payload === null,
    A.isMe(m.senderId) ? A.tickState(m, chat) : 0,
    fs ? [!!fs.url, fs.progress === undefined ? -1 : Math.round(fs.progress * 40), fs.error || ''] : 0,
    up === undefined ? -1 : Math.round(up * 40),
    flags, chat.me.left, chat.me.role, canSend(chat)?.text || '',
    player.id === m.id ? [player.playing, !!player.audio, Math.round(player.progress * 64), Math.round(player.length)] : 0,
    A.nameOf(m.senderId),
  ]);
}

// ---------- message list ----------

let mv = null; // { chatId, el, rows: Slots, atBottom, firstId, lastSeq, newCount, initial }

function messagesView(chat) {
  if (mv?.chatId === chat.id) return mv;
  stopPlayer();
  const el = h('div', { class: 'messages' });
  const down = h('button', { type: 'button', class: 'scroll-down hidden', 'aria-label': 'Scroll to bottom', onclick: () => { el.scrollTop = el.scrollHeight; } }, icon('down'));
  mv = { chatId: chat.id, el, down, rows: new Slots(), atBottom: true, firstId: null, lastSeq: chat.lastSeq, newCount: 0, initial: true };
  el.addEventListener('scroll', () => {
    const v = mv;
    v.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (v.atBottom) v.newCount = 0;
    if (el.scrollTop < 400) {
      const b = A.box(chat.id);
      if (b.loaded && b.hasMore && !b.loading) A.loadMessages(chat.id, { older: true });
    }
    updateDown();
  }, { passive: true });
  return mv;
}

function updateDown() {
  mv.down.classList.toggle('hidden', mv.atBottom);
  reconcile(mv.down, [icon('down'), mv.newCount ? h('span', { class: 'badge' }, String(mv.newCount)) : null]);
}

function renderMessages(chat) {
  const v = messagesView(chat);
  const b = A.box(chat.id);
  const el = v.el;
  if (!b.loaded) {
    if (!b.loading) A.loadMessages(chat.id);
    reconcile(el, [h('div', { class: 'spacer' }), h('div', { class: 'day' }, 'Loading messages…')]);
    return;
  }
  const list = b.list;
  const used = new Set();
  const nodes = [h('div', { class: 'spacer' })];
  if (b.loading && b.hasMore) nodes.push(v.rows.get('loading', '1', () => h('div', { class: 'day' }, 'Loading…')));
  if (!b.hasMore) {
    used.add('e2e');
    nodes.push(v.rows.get('e2e', chat.type, () => h(
      'button',
      { type: 'button', class: 'e2e-note', onclick: () => O.securityCodeDialog(chat) },
      icon('lock'),
      " Messages and calls are end-to-end encrypted. Nobody outside of this chat, not even Tailchat's server, can read or listen to them. Click to verify.",
    )));
  }
  const unread = S.unreadFrom?.chatId === chat.id && S.unreadFrom.count > 0 ? S.unreadFrom : null;
  let unreadShown = false;
  let prev = null;
  const term = S.details === 'search' ? S.chatSearch.trim() : '';
  for (const m of list) {
    const day = new Date(m.createdAt).toDateString();
    if (!prev || new Date(prev.createdAt).toDateString() !== day) {
      const key = `day:${day}`;
      used.add(key);
      nodes.push(v.rows.get(key, dayLabel(m.createdAt), () => h('div', { class: 'day' }, dayLabel(m.createdAt))));
    }
    if (unread && !unreadShown && m.seq > unread.seq && m.kind === 'msg' && !A.isMe(m.senderId) && !m.pending) {
      unreadShown = true;
      used.add('unread');
      const label = `${unread.count} unread message${unread.count === 1 ? '' : 's'}`;
      nodes.push(v.rows.get('unread', label, () => h('div', { class: 'day unread-marker' }, label)));
    }
    const first = !prev || prev.kind === 'system' || prev.senderId !== m.senderId || new Date(prev.createdAt).toDateString() !== day;
    const flags = { first, showName: first && chat.type === 'group' && !A.isMe(m.senderId) && m.kind === 'msg', search: term };
    used.add(m.id);
    nodes.push(v.rows.get(m.id, rowSig(m, chat, flags), () => messageRow(m, chat, flags)));
    prev = m;
  }
  v.rows.sweep(used);

  const fromBottom = el.scrollHeight - el.scrollTop;
  const firstId = list.find((m) => !m.pending)?.id || null;
  const newer = list.filter((m) => m.seq > v.lastSeq && m.kind === 'msg' && !A.isMe(m.senderId)).length;
  v.lastSeq = Math.max(v.lastSeq, ...list.map((m) => m.seq || 0));
  if (!v.atBottom && newer) v.newCount += newer;
  reconcile(el, nodes);

  if (v.initial) {
    v.initial = false;
    const marker = el.querySelector('.unread-marker');
    if (marker) {
      el.scrollTop = Math.max(0, marker.offsetTop - 80);
      v.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    } else el.scrollTop = el.scrollHeight;
  } else if (v.atBottom) el.scrollTop = el.scrollHeight;
  else if (firstId !== v.firstId) el.scrollTop = el.scrollHeight - fromBottom;
  v.firstId = firstId;

  if (S.highlight) {
    const row = el.querySelector(`[data-id="${CSS.escape(S.highlight)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('highlight');
      setTimeout(() => row.classList.remove('highlight'), 1600);
      v.atBottom = false;
    }
    S.highlight = null;
  }
  updateDown();
}

// ---------- header and pinned message ----------

function subtitle(chat) {
  const t = A.typingText(chat.id);
  if (t) return { text: t, typing: true };
  if (chat.type === 'group') {
    const names = chat.members.filter((m) => !m.left).map((m) => (A.isMe(m.userId) ? 'You' : A.nameOf(m.userId)));
    names.sort((a, b) => (a === 'You') - (b === 'You'));
    return { text: chat.me.left ? "You're no longer a member" : names.join(', ') };
  }
  const other = A.otherMember(chat);
  if (A.isMe(other)) return { text: 'Message yourself' };
  return { text: lastSeenText(S.users.get(other)) || 'click here for contact info' };
}

function toggleDetails(kind) {
  S.details = S.details === kind ? null : kind;
  render();
}

function chatMenuItems(chat) {
  const muted = chat.me.mutedUntil > Date.now();
  const other = chat.type === 'direct' ? S.users.get(A.otherMember(chat)) : null;
  const self = chat.type === 'direct' && A.isMe(A.otherMember(chat));
  return [
    { label: chat.type === 'group' ? 'Group info' : 'Contact info', icon: 'info', onClick: () => { S.details = 'info'; render(); } },
    { label: 'Search', icon: 'search', onClick: () => { S.details = 'search'; render(); } },
    { label: 'Media, links and docs', icon: 'image', onClick: () => { S.details = 'media'; render(); } },
    { label: 'Starred messages', icon: 'star', onClick: () => { S.details = 'starred'; render(); } },
    {
      label: muted ? 'Unmute notifications' : 'Mute notifications',
      icon: 'mute',
      onClick: () => (muted ? api.patch(`/api/chats/${encodeURIComponent(chat.id)}/prefs`, { mutedUntil: 0 }).catch((e) => toast(e.message)) : O.muteDialog(chat)),
    },
    !chat.me.left ? { label: 'Disappearing messages', icon: 'timer', onClick: () => O.disappearingDialog(chat) } : null,
    { label: 'Clear chat', icon: 'delete', onClick: () => clearChat(chat) },
    other && !self ? { label: other.blocked ? `Unblock ${other.name}` : `Block ${other.name}`, icon: 'block', danger: !other.blocked, onClick: () => blockUser(other) } : null,
    chat.type === 'group' && !chat.me.left ? { label: 'Exit group', icon: 'exit', danger: true, onClick: () => exitGroup(chat) } : null,
    chat.type === 'direct' || chat.me.left ? { label: chat.type === 'group' ? 'Delete group' : 'Delete chat', icon: 'delete', danger: true, onClick: () => deleteChat(chat) } : null,
    { label: 'Close chat', icon: 'close', onClick: () => { S.active = null; S.details = null; render(); } },
  ];
}

export async function clearChat(chat) {
  if (!(await confirmDialog('Clear this chat?', 'Messages will be removed from this chat on all your devices. Other people keep their copies.', 'Clear chat', 'danger'))) return;
  try {
    await api.post(`/api/chats/${encodeURIComponent(chat.id)}/clear`);
    S.msgs.delete(chat.id);
    if (mv?.chatId === chat.id) mv = null;
    render();
  } catch (err) {
    toast(err.message);
  }
}

export async function deleteChat(chat) {
  const title = chat.type === 'group' ? `Delete "${chat.name}"?` : `Delete chat with ${A.chatTitle(chat)}?`;
  if (!(await confirmDialog(title, 'Messages will be removed from all your devices. The chat comes back if someone writes to you again.', 'Delete', 'danger'))) return;
  try {
    await api.del(`/api/chats/${encodeURIComponent(chat.id)}`);
  } catch (err) {
    toast(err.message);
  }
}

export async function exitGroup(chat) {
  if (!(await confirmDialog(`Exit "${chat.name}"?`, "Only group admins will be notified that you left the group. You'll keep the messages you already have.", 'Exit group', 'danger'))) return;
  try {
    await api.del(`/api/chats/${encodeURIComponent(chat.id)}/members/${encodeURIComponent(S.me.id)}`);
  } catch (err) {
    toast(err.message);
  }
}

export async function blockUser(user) {
  if (user.blocked) {
    await api.del(`/api/blocks/${encodeURIComponent(user.id)}`).catch((e) => toast(e.message));
    toast(`${user.name} unblocked`);
    return;
  }
  if (!(await confirmDialog(`Block ${user.name}?`, "Blocked contacts can't call you or send you messages, and won't see your status updates or when you're online.", 'Block', 'danger'))) return;
  await api.post('/api/blocks', { userId: user.id }).catch((e) => toast(e.message));
}

function header(chat) {
  const sub = subtitle(chat);
  const av = A.chatAvatar(chat);
  const self = chat.type === 'direct' && A.isMe(A.otherMember(chat));
  const callable = !chat.me.left && !self && !canSend(chat);
  const sig = JSON.stringify([chat.id, A.chatTitle(chat), av, sub, S.details, callable, chat.me.mutedUntil, chat.me.left, chat.me.role, chat.adminsOnlyEdit, !!A.calls?.call]);
  return slots.get('header', sig, () => {
    let moreBtn;
    return h(
      'header',
      { class: 'topbar' },
      iconButton('back', 'Back', () => { S.active = null; S.details = null; render(); }, { class: 'icon-btn back-btn' }),
      h('button', { type: 'button', class: 'avatar-btn', 'aria-label': 'Chat info', onclick: () => toggleDetails('info') }, avatar(av)),
      h('div', { class: 'title', onclick: () => toggleDetails('info') }, h('div', { class: 'name ellipsis' }, A.chatTitle(chat)), h('div', { class: `sub ellipsis${sub.typing ? ' typing' : ''}` }, sub.text)),
      callable ? iconButton('video', 'Video call', () => O.startCall(chat, true), { disabled: !!A.calls?.call }) : null,
      callable ? iconButton('phone', 'Voice call', () => O.startCall(chat, false), { disabled: !!A.calls?.call }) : null,
      iconButton('search', 'Search messages', () => toggleDetails('search'), { class: `icon-btn${S.details === 'search' ? ' active' : ''}` }),
      (moreBtn = iconButton('more', 'Menu', () => menu(moreBtn, chatMenuItems(chat)))),
    );
  });
}

const fetchedPins = new Map();

function pinnedBar(chat) {
  const id = chat.pinnedMessage;
  if (!id) return null;
  let m = A.box(chat.id).list.find((x) => x.id === id) || fetchedPins.get(id);
  if (!m && !fetchedPins.has(id)) {
    fetchedPins.set(id, null);
    api.get(`/api/messages/${encodeURIComponent(id)}`).then(({ message }) => {
      fetchedPins.set(id, message);
      A.decryptMessage(message);
      render();
    }).catch(() => {});
  }
  if (!m) m = null;
  const text = m ? A.previewText(m) : 'Pinned message';
  const mayPin = !chat.me.left && (chat.type !== 'group' || !chat.adminsOnlyEdit || chat.me.role === 'admin');
  return slots.get('pinned', JSON.stringify([id, text, mayPin]), () => h(
    'div',
    { class: 'pinned-bar', onclick: () => jumpTo(chat.id, id) },
    icon('pin'),
    h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, text)),
    mayPin ? iconButton('close', 'Unpin', (e) => { e.stopPropagation(); api.post(`/api/chats/${encodeURIComponent(chat.id)}/pin`, { messageId: null }).catch((err) => toast(err.message)); }) : null,
  ));
}

// ---------- composer ----------

let comp = null;

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
}

function pickFiles(accept, multiple, onPick, capture) {
  const input = h('input', { type: 'file', accept, multiple, class: 'hidden' });
  if (capture) input.setAttribute('capture', capture);
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.remove();
    if (files.length) onPick(files);
  });
  document.body.append(input);
  input.click();
}

export function attachDialog(chat, files, { asDocument = false } = {}) {
  files = files.slice(0, 30).filter((f) => !O.fileTooBig(f));
  if (!files.length) return;
  const first = files[0];
  const kind = asDocument ? 'document' : kindFor(first);
  const url = URL.createObjectURL(first);
  const caption = h('input', { maxlength: 1024, placeholder: 'Add a caption' });
  const single = files.length === 1 && (kind === 'image' || kind === 'video');
  const once = h('input', { type: 'checkbox' });
  const preview = kind === 'image' || kind === 'gif'
    ? h('img', { src: url, alt: '' })
    : kind === 'video'
      ? h('video', { src: url, controls: true })
      : h('div', { class: 'doc-big' }, h('div', { class: 'doc-icon' }, extensionOf(first.name).slice(0, 4)), h('div', null, first.name), h('div', { class: 'muted' }, fileSize(first.size)));
  dialog({
    title: files.length === 1 ? (asDocument ? 'Send document' : 'Send file') : `Send ${files.length} files`,
    wide: true,
    content: [
      h('div', { class: 'upload-preview' }, preview),
      files.length > 1 ? h('div', { class: 'muted' }, files.map((f) => `${f.name} (${fileSize(f.size)})`).join(' · ')) : null,
      h('label', { class: 'field' }, caption),
      single ? h('label', { class: 'check-row' }, once, icon('once'), 'View once: the recipient can open it one time, then it disappears') : null,
      h('p', { class: 'muted' }, icon('lock'), ' Files are encrypted on this device before upload. The server only stores ciphertext.'),
    ],
    onClose: () => URL.revokeObjectURL(url),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Send',
        kind: 'primary',
        onClick: (close) => {
          const text = caption.value.trim();
          const replyTo = S.reply ? replyRef(S.reply) : undefined;
          close();
          S.reply = null;
          if (mv) mv.atBottom = true;
          files.forEach((f, i) => {
            A.sendFile(chat.id, f, {
              caption: i === 0 ? text : undefined,
              kind: asDocument ? 'document' : undefined,
              viewOnce: single && once.checked,
              extra: i === 0 && replyTo ? { replyTo } : {},
            }).catch(() => {});
          });
        },
      },
    ],
  });
}

function pollDialog(chat) {
  const question = h('input', { maxlength: 255, placeholder: 'Ask a question' });
  const optionsBox = h('div');
  const multiple = h('input', { type: 'checkbox', class: 'toggle', checked: true });
  const addOption = () => {
    const input = h('input', { maxlength: 100, placeholder: '+ Add option' });
    input.addEventListener('input', () => {
      const inputs = [...optionsBox.querySelectorAll('input')];
      if (input === inputs.at(-1) && input.value && inputs.length < 12) addOption();
    });
    optionsBox.append(h('label', { class: 'field' }, input));
  };
  addOption();
  addOption();
  dialog({
    title: 'Create poll',
    content: [h('label', { class: 'field' }, h('span', null, 'Question'), question), h('div', { class: 'list-section' }, 'Options'), optionsBox, h('label', { class: 'check-row' }, multiple, 'Allow multiple answers')],
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Send',
        kind: 'primary',
        onClick: (close) => {
          const q = question.value.trim();
          const options = [...optionsBox.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
          if (!q || options.length < 2) {
            toast('A poll needs a question and at least 2 options');
            return;
          }
          if (new Set(options).size !== options.length) {
            toast('Options must be different');
            return;
          }
          close();
          A.sendContent(chat.id, { type: 'poll', question: q, options, multiple: multiple.checked }).catch(() => {});
        },
      },
    ],
  });
}

function locationDialog(chat) {
  const lat = h('input', { inputmode: 'decimal', placeholder: 'Latitude' });
  const lon = h('input', { inputmode: 'decimal', placeholder: 'Longitude' });
  const name = h('input', { maxlength: 100, placeholder: 'Place name (optional)' });
  const status = h('p', { class: 'muted' }, 'Locating you…');
  let accuracy;
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lat.value = pos.coords.latitude.toFixed(6);
        lon.value = pos.coords.longitude.toFixed(6);
        accuracy = Math.round(pos.coords.accuracy);
        status.textContent = `Your current location, accurate to about ${accuracy} m.`;
      },
      (err) => (status.textContent = `Couldn't get your location (${err.message}). You can type coordinates instead.`),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  } else status.textContent = 'This browser cannot share your location. You can type coordinates instead.';
  dialog({
    title: 'Send location',
    content: [status, h('label', { class: 'field' }, h('span', null, 'Latitude'), lat), h('label', { class: 'field' }, h('span', null, 'Longitude'), lon), h('label', { class: 'field' }, name)],
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Send',
        kind: 'primary',
        onClick: (close) => {
          const la = Number(lat.value);
          const lo = Number(lon.value);
          if (!lat.value || !lon.value || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
            toast('Enter a valid latitude and longitude');
            return;
          }
          close();
          A.sendContent(chat.id, { type: 'location', lat: la, lon: lo, accuracy, name: name.value.trim() || undefined }).catch(() => {});
        },
      },
    ],
  });
}

async function contactDialog(chat) {
  const ids = await O.pickUsers({ title: 'Share contacts', okLabel: 'Send' });
  for (const id of ids || []) {
    const u = S.users.get(id);
    A.sendContent(chat.id, { type: 'contact', userId: id, name: u?.name || id }).catch(() => {});
  }
}

function attachMenu(chat, anchor) {
  menu(anchor, [
    { label: 'Document', icon: 'document', onClick: () => pickFiles('*/*', true, (f) => attachDialog(chat, f, { asDocument: true })) },
    { label: 'Photos & videos', icon: 'image', onClick: () => pickFiles('image/*,video/*', true, (f) => attachDialog(chat, f)) },
    { label: 'Camera', icon: 'camera', onClick: () => pickFiles('image/*,video/*', false, (f) => attachDialog(chat, f), 'environment') },
    { label: 'Audio', icon: 'mic', onClick: () => pickFiles('audio/*', true, (f) => attachDialog(chat, f)) },
    { label: 'Contact', icon: 'person', onClick: () => contactDialog(chat) },
    { label: 'Poll', icon: 'poll', onClick: () => pollDialog(chat) },
    { label: 'Location', icon: 'location', onClick: () => locationDialog(chat) },
  ]);
}

function mentionCandidates(chat, query) {
  if (chat.type !== 'group') return [];
  const q = query.toLowerCase();
  return chat.members
    .filter((m) => !m.left && !A.isMe(m.userId))
    .map((m) => S.users.get(m.userId) || { id: m.userId, name: A.nameOf(m.userId) })
    .filter((u) => u.name.toLowerCase().includes(q) || u.id.toLowerCase().startsWith(q))
    .slice(0, 8);
}

function buildComposer(chat) {
  const c = { chatId: chat.id, mentionIndex: 0, mentions: [] };
  c.ta = h('textarea', { rows: 1, placeholder: 'Type a message', maxlength: 65536, 'aria-label': 'Message' });
  c.ta.value = drafts.get(chat.id) || '';
  c.ctx = h('div', { class: 'ctx hidden' });
  c.pop = h('div', { class: 'mentions-pop hidden' });
  c.action = h('button', { type: 'button', class: 'icon-btn send-btn' });
  c.normal = h(
    'div',
    { class: 'row-input' },
    (c.emoji = iconButton('emoji', 'Emoji', () => emojiPicker(c.emoji, (e) => insertText(c.ta, e)))),
    (c.attach = iconButton('attach', 'Attach', () => attachMenu(S.chats.get(chat.id), c.attach))),
    c.ta,
    c.action,
  );
  c.time = h('span', null, '0:00');
  c.rec = h(
    'div',
    { class: 'row-input hidden' },
    iconButton('delete', 'Cancel recording', () => finishRecording(false)),
    h('div', { class: 'recording' }, h('span', { class: 'dot' }), c.time, h('span', { class: 'muted' }, 'Recording voice message')),
    iconButton('send', 'Send voice message', () => finishRecording(true), { class: 'icon-btn send-btn' }),
  );
  c.el = h('footer', { class: 'composer' }, c.pop, c.ctx, c.normal, c.rec);

  c.ta.addEventListener('input', () => {
    autosize(c.ta);
    if (!S.editing) drafts.set(chat.id, c.ta.value);
    if (c.ta.value) A.typing(chat.id);
    else A.stopTyping(chat.id);
    updateMentions(c);
    updateAction(c);
  });
  c.ta.addEventListener('keydown', (e) => {
    if (!c.pop.classList.contains('hidden') && c.mentions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        c.mentionIndex = (c.mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + c.mentions.length) % c.mentions.length;
        drawMentions(c);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(c, c.mentions[c.mentionIndex]);
        return;
      }
    }
    if (e.key === 'Escape' && (S.reply || S.editing)) {
      cancelContext(c);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && S.prefs.enterToSend) {
      e.preventDefault();
      send(c);
    }
  });
  c.ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      attachDialog(S.chats.get(chat.id), files);
    }
  });
  c.action.addEventListener('click', () => (c.ta.value.trim() || S.editing ? send(c) : startRecording(c)));
  updateAction(c);
  setTimeout(() => autosize(c.ta), 0);
  return c;
}

function cancelContext(c) {
  if (S.editing) {
    c.ta.value = c.savedDraft || '';
    autosize(c.ta);
  }
  S.reply = null;
  S.editing = null;
  updateAction(c);
  render();
}

function insertText(ta, text) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  ta.value = value.slice(0, s) + text + value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

function updateAction(c) {
  const sending = !!c.ta.value.trim() || !!S.editing;
  const name = S.editing ? 'check' : sending ? 'send' : 'mic';
  if (c.actionName === name) return;
  c.actionName = name;
  c.action.replaceChildren(icon(name));
  c.action.title = S.editing ? 'Save edit' : sending ? 'Send' : 'Record voice message';
  c.action.setAttribute('aria-label', c.action.title);
}

function updateMentions(c) {
  const chat = S.chats.get(c.chatId);
  const before = c.ta.value.slice(0, c.ta.selectionStart);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  c.mentions = m && chat ? mentionCandidates(chat, m[2]) : [];
  c.mentionIndex = 0;
  drawMentions(c);
}

function drawMentions(c) {
  c.pop.classList.toggle('hidden', !c.mentions.length);
  reconcile(c.pop, c.mentions.map((u, i) => h(
    'div',
    { class: `row${i === c.mentionIndex ? ' selected' : ''}`, onmousedown: (e) => { e.preventDefault(); pickMention(c, u); } },
    avatar(u, 'sm'),
    h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, u.name), h('div', { class: 'preview ellipsis' }, u.id)),
  )));
}

function pickMention(c, u) {
  const pos = c.ta.selectionStart;
  const before = c.ta.value.slice(0, pos).replace(/@([^\s@]*)$/, `@${u.id} `);
  c.ta.value = before + c.ta.value.slice(pos);
  c.ta.selectionStart = c.ta.selectionEnd = before.length;
  c.mentions = [];
  drawMentions(c);
  c.ta.dispatchEvent(new Event('input'));
}

function send(c) {
  const chat = S.chats.get(c.chatId);
  const text = c.ta.value.trim();
  if (!chat || !text) return;
  const mentions = chat.type === 'group' ? chat.members.map((m) => m.userId).filter((id) => text.includes(`@${id}`)) : [];
  if (S.editing) {
    const m = S.editing;
    const old = A.contentOf(m)?.ok || {};
    S.editing = null;
    A.editMessage(m, { ...old, text, mentions: mentions.length ? mentions : undefined }).catch((e) => toast(e.message));
    c.ta.value = c.savedDraft || '';
    autosize(c.ta);
    updateAction(c);
    render();
    return;
  } else {
    const replyTo = S.reply ? replyRef(S.reply) : undefined;
    S.reply = null;
    c.ta.value = '';
    A.sendText(chat.id, text, { replyTo, mentions: mentions.length ? mentions : undefined }).catch(() => {});
    if (mv) mv.atBottom = true;
  }
  drafts.delete(chat.id);
  A.stopTyping(chat.id);
  autosize(c.ta);
  updateAction(c);
  render();
}

async function startRecording(c) {
  const rec = new VoiceRecorder();
  try {
    await rec.start();
  } catch (err) {
    toast(`Can't use your microphone: ${err.message}`);
    return;
  }
  c.recorder = rec;
  c.normal.classList.add('hidden');
  c.rec.classList.remove('hidden');
  c.recTimer = setInterval(() => {
    c.time.textContent = duration(rec.elapsed());
    A.typing(c.chatId, 'recording');
    if (rec.elapsed() > 15 * 60) finishRecording(true);
  }, 300);
}

async function finishRecording(sendIt) {
  const c = comp;
  const rec = c?.recorder;
  if (!rec) return;
  c.recorder = null;
  clearInterval(c.recTimer);
  c.time.textContent = '0:00';
  c.rec.classList.add('hidden');
  c.normal.classList.remove('hidden');
  A.stopTyping(c.chatId);
  if (!sendIt) {
    rec.cancel();
    return;
  }
  const { blob, duration: secs, waveform } = await rec.stop();
  if (secs < 0.7) {
    toast('Voice message too short');
    return;
  }
  const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
  const file = new File([blob], `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type: blob.type });
  const replyTo = S.reply ? replyRef(S.reply) : undefined;
  S.reply = null;
  if (mv) mv.atBottom = true;
  A.sendFile(c.chatId, file, { kind: 'voice', voice: { duration: secs, waveform }, extra: replyTo ? { replyTo } : {} }).catch(() => {});
}

function composer(chat) {
  const blocked = canSend(chat);
  if (blocked) {
    if (comp?.chatId === chat.id) {
      comp.recorder?.cancel();
      comp = null;
    }
    return slots.get('blocked', blocked.text, () => h('footer', { class: 'composer' }, h('div', { class: `notice${blocked.action ? ' link' : ''}`, onclick: blocked.action }, blocked.text)));
  }
  if (comp?.chatId !== chat.id) {
    if (comp?.recorder) comp.recorder.cancel();
    comp = buildComposer(chat);
  }
  const ref = S.editing?.chatId === chat.id ? S.editing : S.reply?.chatId === chat.id ? S.reply : null;
  const kind = S.editing?.chatId === chat.id ? 'Editing' : 'Replying to';
  const sig = ref ? JSON.stringify([kind, ref.id, A.previewText(ref)]) : '';
  if (comp.ctxSig !== sig) {
    comp.ctxSig = sig;
    comp.ctx.classList.toggle('hidden', !ref);
    reconcile(comp.ctx, ref ? [
      h('div', { class: 'quote' }, h('div', { class: 'q-body' }, h('div', { class: 'q-name', style: { color: colorFor(ref.senderId) } }, `${kind} ${A.isMe(ref.senderId) ? 'yourself' : A.nameOf(ref.senderId)}`), h('div', { class: 'q-text' }, A.previewText(ref)))),
      iconButton('close', 'Cancel', () => cancelContext(comp)),
    ] : []);
    updateAction(comp);
  }
  return comp.el;
}

export function focusComposer() {
  comp?.ta?.focus();
}

// ---------- the whole conversation pane ----------

export function renderConversation(el, chat) {
  if (S.reply && S.reply.chatId !== chat.id) S.reply = null;
  if (S.editing && S.editing.chatId !== chat.id) S.editing = null;
  const v = messagesView(chat);
  renderMessages(chat);
  reconcile(el, [header(chat), pinnedBar(chat), v.el, v.down, composer(chat)]);
}
