// App shell and the left column: chat list, status, calls, and the panels
// that slide over it (new chat, new group, settings, starred, archived).
import * as A from './app.js';
import { S, api, render } from './app.js';
import { kvDelete } from './api.js';
import { h, icon, iconButton, avatar, toast, menu, dialog, confirmDialog, promptDialog, listTime, duration, lastSeenText, reconcile, Slots, toggle, viewer, chooseFiles } from './ui.js';
import { kindFor } from './media.js';
import { pickPhoto, cropPhoto } from './photo.js';
import * as O from './overlays.js';
import * as T from './themes.js';
import { renderConversation, drafts, clearChat, deleteChat, exitGroup, exitLabel, attachDialog, canSend, followChannel, openCommunity } from './conversation.js';
import { renderDetails, starredRow, inviteDialog, addMembers, deactivateCommunity } from './details.js';
import { QUALITIES, DEFAULT_QUALITY } from './rtc.js';
import * as tones from './tones.js';
import * as native from './native.js';

const slots = new Slots();
let root;
let railEl;
let sidebarEl;
let mainEl;
let convEl;
let detailsEl;
let welcomeEl;
let chatSearchEl;
let panelSearchEl;
let panelKey = null;
let ng = null; // new group draft: { step, members, name, photo, photoUrl }

// ---------- small pieces ----------

function setView(view) {
  S.view = view;
  S.panel = null;
  render();
}

function openPanel(panel) {
  S.panel = panel;
  render();
}

function tickIcon(state) {
  const map = { pending: ['clock', ''], failed: ['info', 'danger'], read: ['checks', 'read'], delivered: ['checks', ''], sent: ['check', ''] };
  const [name, cls] = map[state] || map.sent;
  return h('span', { class: `tick ${cls}` }, icon(name));
}

// An avatar with a green dot when that person or device is online.
function presenceAvatar(av, online) {
  const el = avatar(av, 'md');
  return online ? h('div', { class: 'av-wrap' }, el, h('span', { class: 'presence', title: 'Online' })) : el;
}

function ringAvatar(user, seen, size = 'md') {
  return h('div', { class: `status-ring${seen ? ' seen' : ''}` }, avatar(user, size));
}

const prefs = (chat, body) => api.patch(`/api/chats/${encodeURIComponent(chat.id)}/prefs`, body).catch((e) => toast(e.message));

function chatMenu(chat, anchor) {
  const muted = chat.me.mutedUntil > Date.now();
  const unread = chat.unread || chat.me.markedUnread;
  menu(anchor, [
    { label: chat.me.archived ? 'Unarchive chat' : 'Archive chat', icon: 'archive', onClick: () => prefs(chat, { archived: !chat.me.archived }) },
    { label: muted ? 'Unmute notifications' : 'Mute notifications', icon: 'mute', onClick: () => (muted ? prefs(chat, { mutedUntil: 0 }) : O.muteDialog(chat)) },
    { label: chat.me.pinnedAt ? 'Unpin chat' : 'Pin chat', icon: 'pin', onClick: () => prefs(chat, { pinned: !chat.me.pinnedAt }) },
    {
      label: unread ? 'Mark as read' : 'Mark as unread',
      icon: 'unread',
      onClick: () => (unread
        ? api.post(`/api/chats/${encodeURIComponent(chat.id)}/receipts`, { delivered: chat.lastSeq, read: chat.lastSeq }).catch((e) => toast(e.message))
        : prefs(chat, { markedUnread: true })),
    },
    { label: 'Clear chat', icon: 'delete', onClick: () => clearChat(chat) },
    A.isGroupish(chat) && !chat.me.left
      ? { label: exitLabel(chat), icon: 'exit', danger: true, onClick: () => exitGroup(chat) }
      : { label: A.isGroupish(chat) ? `Delete ${A.noun(chat)}` : A.isDeviceGroup(chat) ? 'Leave group on this device' : 'Delete chat', icon: A.isDeviceGroup(chat) ? 'exit' : 'delete', danger: true, onClick: () => deleteChat(chat) },
  ]);
}

function chatRowData(chat, title) {
  const last = chat.lastMessage;
  const draft = S.active !== chat.id ? (drafts.get(chat.id) || '').trim() : '';
  return {
    id: chat.id,
    title: title || A.chatTitle(chat),
    av: title ? { id: chat.id, name: title, group: 'channel' } : A.chatAvatar(chat),
    time: listTime(last?.createdAt || chat.createdAt),
    typing: A.typingText(chat.id),
    draft: draft.slice(0, 100),
    tick: last && last.kind === 'msg' && A.sentHere(last, chat) && !last.deletedAt ? A.tickState(last, chat) : null,
    prefix: last && (A.showsSender(chat) || A.isDeviceGroup(chat)) && last.kind === 'msg' && !last.deletedAt && !A.sentHere(last, chat) ? `${A.senderName(last, chat)}: ` : '',
    preview: last ? A.previewText(last) : A.isGroupish(chat) || A.isDeviceGroup(chat) ? 'No messages yet' : A.isDeviceChat(chat) ? 'Send messages and files to this device' : '',
    online: chat.type === 'direct' && !A.isMe(A.otherMember(chat)) && !!S.users.get(A.otherMember(chat))?.online,
    unread: chat.unread,
    marked: chat.me.markedUnread,
    muted: chat.me.mutedUntil > Date.now(),
    pinned: !!chat.me.pinnedAt,
    selected: S.active === chat.id,
  };
}

// title replaces the chat's own name (a community's "Announcements" row).
function chatRow(chat, title) {
  if (typeof title !== 'string') title = undefined; // also used as a map() callback
  const d = chatRowData(chat, title);
  return slots.get(`chat:${chat.id}${title ? ':alt' : ''}`, JSON.stringify(d), () => {
    let btn;
    let preview;
    if (d.typing) preview = h('span', { class: 'typing ellipsis' }, d.typing);
    else if (d.draft) preview = [h('span', { class: 'draft' }, 'Draft: '), h('span', { class: 'ellipsis' }, d.draft)];
    else preview = [d.tick ? tickIcon(d.tick) : null, h('span', { class: 'ellipsis' }, d.prefix + d.preview)];
    return h(
      'div',
      {
        class: `row chat-row${d.selected ? ' selected' : ''}${(d.unread || d.marked) && !d.muted ? ' unread' : ''}`,
        onclick: () => {
          S.panel = null;
          A.openChat(chat.id);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          chatMenu(S.chats.get(chat.id) || chat, { x: e.clientX, y: e.clientY });
        },
      },
      presenceAvatar(d.av, d.online),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'line' }, h('div', { class: 'name ellipsis grow' }, d.title), h('span', { class: `time${(d.unread || d.marked) && !d.muted ? ' unread' : ''}` }, d.time)),
        h(
          'div',
          { class: 'line' },
          h('div', { class: 'preview grow' }, preview),
          h(
            'span',
            { class: 'meta-icons' },
            d.muted ? icon('mute') : null,
            d.pinned ? icon('pin') : null,
            d.unread ? h('span', { class: `badge${d.muted ? ' muted' : ''}` }, String(d.unread)) : d.marked ? h('span', { class: `badge dot${d.muted ? ' muted' : ''}` }) : null,
            (btn = h('button', { type: 'button', class: 'row-menu', 'aria-label': 'Chat options', onclick: (e) => { e.stopPropagation(); chatMenu(S.chats.get(chat.id) || chat, btn); } }, icon('down'))),
          ),
        ),
      ),
    );
  });
}

// One of your machines that hasn't opened Tailchat yet, listed like a chat.
function machineRow(m) {
  const d = { name: m.name, seen: lastSeenText(m), selected: S.machine === m.id };
  return slots.get(`machine:${m.id}`, JSON.stringify(d), () => h(
    'div',
    {
      class: `row machine-row${d.selected ? ' selected' : ''}`,
      onclick: () => {
        S.panel = null;
        A.openMachine(m.id);
      },
    },
    presenceAvatar({ id: m.id, name: d.name }, d.seen === 'online'),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'line' }, h('div', { class: 'name ellipsis grow' }, d.name), h('span', { class: 'time' }, d.seen === 'online' ? 'online' : '')),
      h('div', { class: 'line' }, h('div', { class: 'preview grow' }, h('span', { class: 'ellipsis' }, 'Your device · open Tailchat on it to chat'))),
    ),
  ));
}

function userRow(u, onClick, sub) {
  return h(
    'div',
    { class: 'row', onclick: onClick },
    avatar(u, 'md'),
    h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, A.isMe(u.id) ? `${u.name} (You)` : u.name), h('div', { class: 'preview ellipsis' }, sub ?? (u.about || u.id))),
  );
}

function sortChats(list) {
  const at = (c) => c.lastMessage?.createdAt || c.createdAt;
  return list.sort((a, b) => (b.me.pinnedAt || 0) - (a.me.pinnedAt || 0) || at(b) - at(a));
}

async function startDirect(userId) {
  try {
    S.panel = null;
    await A.openDirect(userId);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- chats tab ----------

function searchResults(q) {
  const nodes = [];
  const chats = sortChats([...S.chats.values()].filter((c) => A.chatTitle(c).toLowerCase().includes(q)));
  const machines = A.machineChats().filter((m) => m.name.toLowerCase().includes(q));
  if (chats.length || machines.length) nodes.push(h('div', { class: 'list-section' }, 'Chats'), chats.map(chatRow), machines.map(machineRow));
  const direct = new Set(chats.filter((c) => c.type === 'direct' && !c.devices).map((c) => A.otherMember(c)));
  const people = [...S.users.values()].filter((u) => !direct.has(u.id) && (u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)));
  if (people.length) nodes.push(h('div', { class: 'list-section' }, 'Contacts'), people.map((u) => userRow(u, () => startDirect(u.id))));
  const hits = [];
  for (const [chatId, b] of S.msgs) {
    if (!S.chats.has(chatId)) continue;
    for (const m of b.list) {
      const c = A.contentOf(m)?.ok;
      if (m.kind !== 'msg' || !c) continue;
      const text = [c.text, c.caption, c.file?.name, c.question].filter((x) => typeof x === 'string').join(' ');
      if (text.toLowerCase().includes(q)) hits.push(m);
    }
  }
  if (hits.length) {
    hits.sort((a, b) => b.createdAt - a.createdAt);
    nodes.push(h('div', { class: 'list-section' }, 'Messages'), hits.slice(0, 100).map((m) => starredRow(m)));
  }
  if (!nodes.length) nodes.push(h('div', { class: 'empty' }, 'No chats, contacts or messages found'));
  nodes.push(h('div', { class: 'empty small' }, 'Messages are decrypted on this device, so search covers the chats you have opened.'));
  return nodes;
}

function chatsTab() {
  if (!chatSearchEl) {
    chatSearchEl = h('input', { type: 'search', placeholder: 'Search or start a new chat', 'aria-label': 'Search chats' });
    chatSearchEl.addEventListener('input', () => {
      S.search = chatSearchEl.value;
      render();
    });
  }
  const all = [...S.chats.values()].filter((c) => !A.isChannel(c));
  const archived = all.filter((c) => c.me.archived);
  const unreadArchived = archived.filter((c) => c.unread || c.me.markedUnread).length;
  const filters = slots.get('filters', S.filter, () => h(
    'div',
    { class: 'filters' },
    [['all', 'All'], ['unread', 'Unread'], ['groups', 'Groups']].map(([k, label]) =>
      h('button', { type: 'button', class: `chip${S.filter === k ? ' active' : ''}`, onclick: () => { S.filter = k; render(); } }, label)),
  ));
  const showBanner = 'Notification' in window && Notification.permission !== 'denied' && !S.prefs.notifications && !S.prefs.bannerDismissed;
  const banner = showBanner
    ? slots.get('banner', '1', () => h(
      'div',
      { class: 'banner' },
      icon('bell'),
      h('div', { class: 'grow' }, h('div', null, 'Get notified of new messages'), h('button', { type: 'button', class: 'link', onclick: enableNotifications }, 'Turn on desktop notifications')),
      iconButton('close', 'Dismiss', () => A.savePrefs({ bannerDismissed: true })),
    ))
    : null;
  const offline = !S.online ? slots.get('offline', '1', () => h('div', { class: 'banner warn' }, icon('info'), h('div', null, "Connecting to Tailchat… Messages you send now go out when you're back online."))) : null;
  const linked = S.prefs.securityAlerts?.devices || [];
  const linkedBanner = linked.length ? slots.get('linked', JSON.stringify(linked), () => h(
    'div',
    { class: 'banner warn' },
    icon('shield'),
    h(
      'div',
      { class: 'grow' },
      h('div', null, `New device linked to your account: ${linked.map((d) => d.name).join(', ')}`),
      h('div', { class: 'muted small' }, "If this wasn't you, log it out now. Anyone signed in to Tailscale as you can link a device."),
      h('button', { type: 'button', class: 'link', onclick: () => openPanel('devices') }, 'Review linked devices'),
    ),
    iconButton('close', 'Dismiss', () => A.dismissSecurityAlerts({ devices: true })),
  )) : null;

  const sharing = S.history.sharing;
  const historyBanners = A.historyAsks().map((r) => {
    const d = A.ownDevice(r.deviceId);
    const busy = sharing?.deviceId === r.deviceId;
    return slots.get(`history:${r.deviceId}`, `${d.name}:${r.updatedAt}:${busy ? sharing.count : sharing ? 'other' : ''}`, () => h(
      'div',
      { class: 'banner' },
      icon('history'),
      h(
        'div',
        { class: 'grow' },
        h('div', null, busy ? `Sharing chat history with ${d.name}… ${sharing.count} messages so far` : `${d.name} is asking for your chat history`),
        busy ? null : h('div', { class: 'muted small' }, `Linked ${listTime(d.createdAt)}. Only share it if you linked that device yourself.`),
        busy || sharing ? null : h('button', { type: 'button', class: 'link', onclick: () => O.shareHistoryDialog(r.deviceId) }, 'Review and share'),
      ),
      busy ? null : iconButton('close', 'Not now', () => O.declineHistoryAsk(r.deviceId)),
    ));
  });
  const mine = S.history.requests.get(S.device.id);
  const waiting = mine?.state === 'pending' && S.prefs.historyBannerHidden !== mine.updatedAt
    ? slots.get('history-waiting', `${mine.updatedAt}:${S.deviceCodes.get(S.device.id)}`, () => h(
      'div',
      { class: 'banner' },
      icon('history'),
      h(
        'div',
        { class: 'grow' },
        h('div', null, 'Waiting for your chat history'),
        h('div', { class: 'muted small' }, `Open Tailchat on one of your other devices and tap Review and share. This device's code is ${S.deviceCodes.get(S.device.id) || '…'}.`),
      ),
      iconButton('close', 'Hide', () => A.savePrefs({ historyBannerHidden: mine.updatedAt })),
    ))
    : null;

  let list;
  const q = S.search.trim().toLowerCase();
  if (q) list = searchResults(q);
  else {
    const shown = sortChats(all.filter((c) => {
      if (c.me.archived) return false;
      if (S.filter === 'unread') return c.unread || c.me.markedUnread || S.active === c.id;
      if (S.filter === 'groups') return c.type === 'group' || c.type === 'community' || A.isDeviceGroup(c);
      return true;
    }));
    const machines = S.filter === 'all' ? A.machineChats() : [];
    list = [
      archived.length && S.filter === 'all'
        ? slots.get('archived-row', `${archived.length}:${unreadArchived}`, () => h(
          'div',
          { class: 'row short', onclick: () => openPanel('archived') },
          h('div', { class: 'row-icon' }, icon('archive')),
          h('div', { class: 'body' }, h('div', { class: 'line' }, h('div', { class: 'grow' }, 'Archived'), unreadArchived ? h('span', { class: 'time unread' }, String(unreadArchived)) : h('span', { class: 'time' }, String(archived.length)))),
        ))
        : null,
      shown.map(chatRow),
      machines.map(machineRow),
      !shown.length && !machines.length
        ? h(
          'div',
          { class: 'empty' },
          S.filter === 'unread' ? 'No unread chats' : S.filter === 'groups' ? 'No groups yet' : 'No chats yet. Start one with the new chat button.',
          S.filter === 'groups' && S.ownDevices.some((d) => d.id !== S.device.id && !d.revokedAt)
            ? h('div', null, h('button', { type: 'button', class: 'link', onclick: () => startNewGroup(true) }, 'Make a group of your devices'))
            : null,
        )
        : null,
      shown.length || machines.length ? h('div', { class: 'empty small' }, icon('lock'), ' Your personal messages are end-to-end encrypted') : null,
    ];
  }
  return [
    h('div', { class: 'search' }, icon('search'), chatSearchEl),
    q ? null : filters,
    offline,
    linkedBanner,
    historyBanners,
    waiting,
    banner,
    h('div', { class: 'list' }, list),
    h('button', { type: 'button', class: 'fab list-fab', 'aria-label': 'New chat', title: 'New chat', onclick: () => openPanel('new-chat') }, icon('edit')),
  ];
}

function enableNotifications() {
  if (!('Notification' in window)) return toast("This browser can't show notifications");
  Notification.requestPermission().then((p) => {
    A.savePrefs({ notifications: p === 'granted' });
    if (p !== 'granted') toast('Notifications are blocked in your browser settings');
  });
}

// ---------- status tab ----------

function pickStatusMedia() {
  const input = h('input', { type: 'file', accept: 'image/*,video/*', class: 'hidden' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.remove();
    if (file && !O.fileTooBig(file)) O.mediaStatusDialog(file);
  });
  document.body.append(input);
  input.click();
}

function statusSection() {
  const groups = O.statusGroups();
  const mine = groups.get(S.me.id) || [];
  const others = [...groups.entries()].filter(([u]) => !A.isMe(u));
  const recent = others.filter(([, l]) => l.some((s) => !s.seen));
  const viewed = others.filter(([, l]) => l.every((s) => s.seen));
  const personRow = ([uid, l]) => {
    const u = S.users.get(uid) || { id: uid, name: A.nameOf(uid) };
    return h(
      'div',
      { class: 'row', onclick: () => O.openStatus(uid) },
      ringAvatar(u, l.every((s) => s.seen)),
      h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, u.name), h('div', { class: 'preview' }, `${l.length > 1 ? `${l.length} updates · ` : ''}${listTime(l.at(-1).createdAt)}`)),
    );
  };
  return [
    h('div', { class: 'list-section' }, 'Status'),
    h(
      'div',
      { class: 'row', onclick: () => (mine.length ? O.openStatus(S.me.id) : O.textStatusDialog()) },
      mine.length ? ringAvatar(S.me, true) : avatar(S.me, 'md'),
      h('div', { class: 'body' }, h('div', { class: 'name' }, 'My status'), h('div', { class: 'preview' }, mine.length ? `${mine.length} update${mine.length === 1 ? '' : 's'} · ${listTime(mine.at(-1).createdAt)}` : 'Click to add a status update')),
      iconButton('camera', 'Photo or video status', (e) => { e.stopPropagation(); pickStatusMedia(); }),
      iconButton('edit', 'Text status', (e) => { e.stopPropagation(); O.textStatusDialog(); }),
    ),
    recent.length ? [h('div', { class: 'list-section sub' }, 'Recent updates'), recent.map(personRow)] : null,
    viewed.length ? [h('div', { class: 'list-section sub' }, 'Viewed updates'), viewed.map(personRow)] : null,
    !others.length ? h('div', { class: 'empty small' }, 'No updates from others yet. Status updates disappear after 24 hours.') : null,
    h('div', { class: 'empty small' }, icon('lock'), ' Your status updates are end-to-end encrypted'),
  ];
}

function action(iconName, label, onClick, sub) {
  return h('div', { class: 'row short', onclick: onClick }, h('div', { class: 'row-icon accent' }, icon(iconName)), h('div', { class: 'body' }, h('div', null, label), sub ? h('div', { class: 'preview' }, sub) : null));
}

function channelsSection() {
  const followed = sortChats([...S.chats.values()].filter((c) => A.isChannel(c) && !c.me.left));
  return [
    h('div', { class: 'list-section' }, 'Channels'),
    followed.map(chatRow),
    !followed.length ? h('div', { class: 'empty small' }, 'Follow channels to get updates on topics that matter to you, from people on your tailnet.') : null,
    action('search', 'Find channels', () => openPanel('channels')),
    action('add', 'Create channel', newChannel),
  ];
}

function updatesTab() {
  return [h('div', { class: 'list' }, statusSection(), channelsSection())];
}

// ---------- channels ----------

function newChannel() {
  const name = h('input', { maxlength: 100, placeholder: 'Channel name' });
  const description = h('textarea', { rows: 3, maxlength: 2048, placeholder: 'Describe your channel (optional)' });
  dialog({
    title: 'New channel',
    content: [
      h('label', { class: 'field' }, name),
      h('label', { class: 'field' }, description),
      h('p', { class: 'muted small' }, icon('info'), " Anyone on your tailnet can find and follow your channel. Channel posts aren't end-to-end encrypted, and followers can't see each other."),
    ],
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create channel',
        kind: 'primary',
        onClick: async (close) => {
          if (!name.value.trim()) return toast('Give the channel a name');
          try {
            const { chat } = await api.post('/api/chats/channel', { name: name.value.trim(), description: description.value });
            S.chats.set(chat.id, chat);
            close();
            S.panel = null;
            A.openChat(chat.id);
          } catch (err) {
            toast(err.message);
          }
        },
      },
    ],
  });
}

let directory = null; // { list } for the channel directory panel

function channelsPanel() {
  if (!directory) {
    directory = { list: null };
    api.get('/api/channels').then(({ channels }) => {
      if (directory) directory.list = channels;
      render();
    }).catch((e) => toast(e.message));
  }
  const q = panelSearchEl?.value.trim().toLowerCase() || '';
  const list = (directory.list || []).filter((c) => !q || c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q));
  const open = async (c) => {
    const chat = c.following ? S.chats.get(c.id) || (await A.chatOf(c.id)) : await followChannel(c.id, true);
    if (!chat) return;
    S.panel = null;
    A.openChat(chat.id);
  };
  return panelShell('Find channels', [
    panelSearch('Search channels'),
    action('add', 'Create channel', newChannel),
    directory.list === null ? h('div', { class: 'empty' }, 'Loading channels…') : null,
    directory.list && !list.length ? h('div', { class: 'empty' }, q ? 'No channels found' : 'Nobody on your tailnet has made a channel yet.') : null,
    list.map((c) => h(
      'div',
      { class: 'row', onclick: () => open(c) },
      avatar({ id: c.id, name: c.name, src: c.avatar, group: 'channel' }, 'md'),
      h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, c.name), h('div', { class: 'preview ellipsis' }, `${c.followers} follower${c.followers === 1 ? '' : 's'}${c.description ? ` · ${c.description}` : ''}`)),
      c.following ? h('span', { class: 'tag' }, 'Following') : h('button', { type: 'button', class: 'btn primary small', onclick: (e) => { e.stopPropagation(); open(c); } }, 'Follow'),
    )),
  ]);
}

// ---------- communities ----------

function newCommunity() {
  const name = h('input', { maxlength: 100, placeholder: 'Community name' });
  const description = h('textarea', { rows: 3, maxlength: 2048, placeholder: "What's this community about?" });
  dialog({
    title: 'New community',
    content: [
      h('p', { class: 'muted' }, 'Bring related groups together under one community, with an announcements group that only admins post in.'),
      h('label', { class: 'field' }, name),
      h('label', { class: 'field' }, description),
    ],
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create community',
        kind: 'primary',
        onClick: async (close) => {
          if (!name.value.trim()) return toast('Give the community a name');
          try {
            const { chat } = await api.post('/api/chats/community', { name: name.value.trim(), description: description.value });
            S.chats.set(chat.id, chat);
            close();
            openCommunity(chat.id);
          } catch (err) {
            toast(err.message);
          }
        },
      },
    ],
  });
}

function communitiesTab() {
  const communities = [...S.chats.values()].filter((c) => c.type === 'community' && !c.me.left).sort((a, b) => a.name.localeCompare(b.name));
  return [
    h(
      'div',
      { class: 'list' },
      action('community', 'New community', newCommunity),
      communities.map((c) => {
        const groups = sortChats([...S.chats.values()].filter((g) => g.communityId === c.id && !g.me.left));
        return h(
          'div',
          { class: 'community-block' },
          h('div', { class: 'row', onclick: () => openCommunity(c.id) }, avatar(A.chatAvatar(c), 'md'), h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, c.name), h('div', { class: 'preview' }, `${(c.groups || []).length} group${(c.groups || []).length === 1 ? '' : 's'}`))),
          chatRow(c, 'Announcements'),
          groups.slice(0, 3).map((g) => chatRow(g)),
          h('div', { class: 'row short', onclick: () => openCommunity(c.id) }, h('div', { class: 'row-icon' }, icon('forward')), h('div', { class: 'body' }, 'View all')),
        );
      }),
      !communities.length ? h('div', { class: 'empty' }, "Communities bring members together in topic-based groups, with announcements from admins. You're not in any community yet.") : null,
    ),
  ];
}

function communityPanel() {
  const c = S.chats.get(S.community);
  if (!c || c.type !== 'community') return panelShell('Community', h('div', { class: 'empty' }, "This community isn't available."));
  const admin = c.me.role === 'admin' && !c.me.left;
  const groups = c.groups || [];
  const joined = groups.filter((g) => g.joined);
  const others = groups.filter((g) => !g.joined);
  const members = c.members.filter((m) => !m.left).length;
  const join = async (g) => {
    try {
      const { chat } = await api.post(`/api/communities/${encodeURIComponent(c.id)}/groups/${encodeURIComponent(g.id)}/join`);
      S.chats.set(chat.id, chat);
      S.panel = null;
      A.openChat(chat.id);
    } catch (err) {
      toast(err.message);
    }
  };
  const groupRow = (g, right) => {
    let more;
    return h(
      'div',
      { class: 'row', onclick: () => (g.joined ? (S.panel = null, A.openChat(g.id)) : join(g)) },
      avatar({ id: g.id, name: g.name, src: g.avatar, group: true }, 'md'),
      h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, g.name), h('div', { class: 'preview ellipsis' }, `${g.members} member${g.members === 1 ? '' : 's'}${g.description ? ` · ${g.description}` : ''}`)),
      right,
      admin ? (more = h('button', { type: 'button', class: 'row-menu', 'aria-label': 'Group options', onclick: (e) => {
        e.stopPropagation();
        menu(more, [{ label: 'Remove from community', icon: 'exit', danger: true, onClick: () => removeGroup(c, g) }]);
      } }, icon('down'))) : null,
    );
  };
  return panelShell(c.name, [
    h(
      'div',
      { class: 'card center' },
      avatar(A.chatAvatar(c), 'lg'),
      h('h2', null, c.name),
      h('h3', null, `Community · ${members} member${members === 1 ? '' : 's'}`),
      c.description ? h('p', { class: 'about' }, c.description) : null,
    ),
    chatRow(c, 'Announcements'),
    joined.length ? [h('div', { class: 'list-section' }, "Groups you're in"), joined.map((g) => groupRow(g, null))] : null,
    others.length ? [h('div', { class: 'list-section' }, 'Groups you can join'), others.map((g) => groupRow(g, h('button', { type: 'button', class: 'btn plain small', onclick: (e) => { e.stopPropagation(); join(g); } }, 'Join')))] : null,
    !groups.length ? h('div', { class: 'empty small' }, admin ? 'Add a group to get started.' : 'No groups yet.') : null,
    admin ? [
      h('div', { class: 'list-section' }, 'Manage'),
      action('add', 'New group', () => newCommunityGroup(c)),
      action('group', 'Add existing groups', () => linkGroups(c)),
      action('person', 'Add members', () => addMembers(c)),
      action('link', 'Invite to community via link', () => inviteDialog(c)),
    ] : null,
    action('info', 'Community info', () => { S.panel = null; A.openChat(c.id); S.details = 'info'; render(); }),
    h(
      'div',
      { class: 'card flush' },
      admin ? settingsRow('delete', 'Deactivate community', 'Groups carry on without it', () => deactivateCommunity(c), true) : null,
      settingsRow('exit', 'Exit community', "You'll also leave its groups", () => exitGroup(c), true),
    ),
  ], null);
}

async function newCommunityGroup(c) {
  const name = await promptDialog('New group in the community', { placeholder: 'Group name', okLabel: 'Create', max: 100 });
  if (!name?.trim()) return;
  try {
    const { chat } = await api.post(`/api/communities/${encodeURIComponent(c.id)}/groups`, { name: name.trim() });
    S.chats.set(chat.id, chat);
    S.panel = null;
    A.openChat(chat.id);
  } catch (err) {
    toast(err.message);
  }
}

// Groups you admin that aren't in a community yet.
function linkGroups(c) {
  const candidates = [...S.chats.values()].filter((g) => g.type === 'group' && !g.communityId && !g.me.left && g.me.role === 'admin');
  if (!candidates.length) return toast("You don't admin any groups that could be added. Only group admins can add their group to a community.");
  const boxes = new Map();
  dialog({
    title: 'Add existing groups',
    flush: true,
    content: h('div', { class: 'pick-list' }, candidates.map((g) => {
      const box = h('input', { type: 'checkbox', class: 'row-check' });
      boxes.set(g.id, box);
      return h('label', { class: 'row' }, avatar(A.chatAvatar(g), 'md'), h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, g.name), h('div', { class: 'preview' }, `${g.members.filter((m) => !m.left).length} members`)), box);
    })),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Add',
        kind: 'primary',
        onClick: async (close) => {
          close();
          for (const [groupId, box] of boxes) {
            if (!box.checked) continue;
            await api.post(`/api/communities/${encodeURIComponent(c.id)}/groups`, { groupId }).catch((e) => toast(e.message));
          }
        },
      },
    ],
  });
}

async function removeGroup(c, g) {
  if (!(await confirmDialog(`Remove "${g.name}"?`, 'The group carries on as a normal group. Its members stay in the community.', 'Remove', 'danger'))) return;
  api.del(`/api/communities/${encodeURIComponent(c.id)}/groups/${encodeURIComponent(g.id)}`).catch((e) => toast(e.message));
}

// ---------- calls tab ----------

async function newCall(video) {
  const ids = await O.pickUsers({ title: video ? 'New video call' : 'New voice call', multiple: false });
  if (!ids?.length) return;
  try {
    const { chat } = await api.post('/api/chats/direct', { userId: ids[0] });
    S.chats.set(chat.id, chat);
    await O.startCall(chat, video);
  } catch (err) {
    toast(err.message);
  }
}

// Calling your own devices: one of them (its device chat), or all of them at
// once (your own chat rings every other device you have).
async function callDevices(deviceId, video) {
  try {
    const { chat } = deviceId
      ? await api.post('/api/chats/devices', { deviceId })
      : await api.post('/api/chats/direct', { userId: S.me.id });
    if (!chat) throw new Error('That device chat was deleted. Open it again from New chat.');
    S.chats.set(chat.id, chat);
    await O.startCall(chat, video);
  } catch (err) {
    toast(err.message);
  }
}

function deviceCallRows() {
  const devices = A.callableDevices();
  if (!devices.length) return null;
  const buttons = (id) => [
    iconButton('video', 'Video call', (e) => { e.stopPropagation(); callDevices(id, true); }),
    iconButton('phone', 'Voice call', (e) => { e.stopPropagation(); callDevices(id, false); }),
  ];
  return [
    h('div', { class: 'list-section' }, 'Your devices'),
    devices.length > 1
      ? h(
        'div',
        { class: 'row', onclick: () => callDevices(null, true) },
        h('div', { class: 'row-icon accent' }, icon('group')),
        h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, 'All your devices'), h('div', { class: 'preview ellipsis' }, `Rings all ${devices.length} of them`)),
        buttons(null),
      )
      : null,
    devices.map((d) => h(
      'div',
      { class: 'row', onclick: () => callDevices(d.id, true) },
      avatar({ id: d.machine?.id || d.id, name: d.name }, 'md'),
      h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, d.name), h('div', { class: 'preview ellipsis' }, A.deviceWhere(d) || 'Your device')),
      buttons(d.id),
    )),
  ];
}

function callsTab() {
  const rows = S.calls
    .map((c) => {
      const chat = S.chats.get(c.chatId);
      if (!chat) return null;
      const outgoing = A.callOutgoing(c);
      const missed = !c.answeredAt && !outgoing;
      const length = c.answeredAt && c.endedAt ? ` · ${duration((c.endedAt - c.answeredAt) / 1000)}` : '';
      return h(
        'div',
        { class: 'row', onclick: () => A.openChat(chat.id) },
        avatar(A.chatAvatar(chat), 'md'),
        h(
          'div',
          { class: 'body' },
          h('div', { class: `name ellipsis${missed ? ' danger' : ''}` }, A.chatTitle(chat)),
          h('div', { class: 'preview' }, h('span', { class: `call-dir${missed ? ' danger' : ''}` }, icon(outgoing ? 'callOut' : 'callIn')), `${missed ? 'Missed · ' : !c.answeredAt ? 'No answer · ' : ''}${listTime(c.startedAt)}${length}`),
        ),
        !chat.me.left ? iconButton(c.video ? 'video' : 'phone', c.video ? 'Video call' : 'Voice call', (e) => { e.stopPropagation(); O.startCall(chat, c.video); }) : null,
      );
    })
    .filter(Boolean);
  return [
    h(
      'div',
      { class: 'list' },
      h('div', { class: 'row short', onclick: () => newCall(false) }, h('div', { class: 'row-icon accent' }, icon('phone')), h('div', { class: 'body' }, 'New voice call')),
      h('div', { class: 'row short', onclick: () => newCall(true) }, h('div', { class: 'row-icon accent' }, icon('video')), h('div', { class: 'body' }, 'New video call')),
      deviceCallRows(),
      h('div', { class: 'list-section' }, 'Recent'),
      rows.length ? rows : h('div', { class: 'empty' }, 'No calls yet'),
      h('div', { class: 'empty small' }, icon('lock'), ' Calls go straight between devices across your tailnet, end-to-end encrypted'),
    ),
  ];
}

// ---------- main sidebar ----------

async function logout() {
  if (!(await confirmDialog('Log out this device?', 'This browser will be unlinked and its encryption key deleted, so it can no longer read your messages. Your other devices are not affected.', 'Log out', 'danger'))) return;
  try {
    await api.del(`/api/devices/${encodeURIComponent(S.device.id)}`);
  } catch {
    // already gone
  }
  await kvDelete(`device:${S.me.id}`);
  location.reload();
}

const VIEW_TITLES = { chats: 'Chats', status: 'Updates', communities: 'Communities', calls: 'Calls' };
const SETTINGS_PANELS = new Set(['settings', 'profile', 'privacy', 'chat-settings', 'call-settings', 'themes', 'theme-editor', 'notifications', 'help']);

// The heading over the list: the section's name and what you can start there.
function topbar() {
  const sig = JSON.stringify([S.view, S.online]);
  return slots.get('topbar', sig, () => {
    let more;
    return h(
      'header',
      { class: 'topbar list-head' },
      h('div', { class: 'title' }, h('h1', { class: 'view-title' }, VIEW_TITLES[S.view] || 'Chats'), S.online ? null : h('div', { class: 'sub' }, 'Connecting…')),
      S.view === 'chats' ? iconButton('group', 'New group', () => startNewGroup()) : null,
      S.view === 'chats' ? iconButton('edit', 'New chat', () => openPanel('new-chat')) : null,
      (more = iconButton('more', 'Menu', () => menu(more, [
        { label: 'New group', icon: 'group', onClick: () => startNewGroup() },
        { label: 'New community', icon: 'community', onClick: newCommunity },
        { label: 'New channel', icon: 'channel', onClick: newChannel },
        { label: 'Broadcast lists', icon: 'broadcast', onClick: () => openPanel('broadcasts') },
        { label: 'Archived', icon: 'archive', onClick: () => openPanel('archived') },
        { label: 'Starred messages', icon: 'star', onClick: () => openPanel('starred') },
        { label: 'Linked devices', icon: 'devices', onClick: () => openPanel('devices') },
        { label: 'Settings', icon: 'settings', onClick: () => openPanel('settings') },
        { label: 'Log out', icon: 'exit', danger: true, onClick: logout },
      ]))),
    );
  });
}

// Unread chats, unseen updates and missed calls, for the badges on the rail.
function navCounts() {
  let unread = 0;
  let channelUnread = false;
  for (const c of S.chats.values()) {
    const has = !c.me.archived && (c.unread || c.me.markedUnread);
    if (has && A.isChannel(c)) channelUnread = true;
    else if (has) unread++;
  }
  const unseen = channelUnread || [...S.statuses.values()].some((s) => !s.seen && !A.isMe(s.userId));
  const missed = S.calls.filter((c) => !c.answeredAt && !A.callOutgoing(c) && c.startedAt > (S.prefs.callsSeenAt || 0)).length;
  return { unread, unseen, missed };
}

function logoMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/icon.svg#mark');
  svg.append(use);
  return svg;
}

// The navigation: a rail down the left on a computer, a tab bar along the
// bottom on a phone.
function rail() {
  const { unread, unseen, missed } = navCounts();
  const sig = JSON.stringify([S.view, S.panel, unread, unseen, missed, S.me, S.online]);
  return slots.get('rail', sig, () => {
    const item = (iconName, label, onClick, active, badge = null, extra = '') => h(
      'button',
      { type: 'button', class: `rail-item${active ? ' active' : ''}${extra}`, title: label, 'aria-current': active ? 'page' : null, onclick: onClick },
      h('span', { class: 'rail-icon' }, icon(iconName), badge),
      h('span', { class: 'rail-label' }, label),
    );
    const view = (v, iconName, label, badge) => item(iconName, label, () => {
      if (v === 'calls') A.savePrefs({ callsSeenAt: Date.now() });
      setView(v);
    }, !S.panel && S.view === v, badge);
    const count = (n) => (n ? h('span', { class: 'badge' }, n > 99 ? '99+' : String(n)) : null);
    return [
      h('div', { class: 'rail-logo', title: 'Tailchat' }, logoMark()),
      view('chats', 'chat', 'Chats', count(unread)),
      view('status', 'status', 'Updates', unseen ? h('span', { class: 'badge dot' }) : null),
      view('communities', 'community', 'Communities'),
      view('calls', 'phone', 'Calls', count(missed)),
      h('div', { class: 'rail-spacer' }),
      item('star', 'Starred', () => openPanel('starred'), S.panel === 'starred', null, ' rail-extra'),
      item('devices', 'Devices', () => openPanel('devices'), S.panel === 'devices', null, ' rail-extra'),
      item('settings', 'Settings', () => openPanel('settings'), SETTINGS_PANELS.has(S.panel)),
      h(
        'button',
        { type: 'button', class: 'rail-me rail-extra', 'aria-label': 'Profile', title: `${S.me.name} · ${S.online ? 'online' : 'connecting…'}`, onclick: () => openPanel('profile') },
        avatar(S.me, 'sm'),
        h('span', { class: `presence${S.online ? '' : ' away'}` }),
      ),
    ];
  });
}

// ---------- panels ----------

function panelShell(title, content, back = null, extra = null) {
  return [
    h('header', { class: 'topbar panel-head' }, iconButton('back', 'Back', () => openPanel(back)), h('div', { class: 'title' }, h('div', { class: 'name' }, title)), extra),
    h('div', { class: 'list' }, content),
  ];
}

function panelSearch(placeholder) {
  if (!panelSearchEl) {
    panelSearchEl = h('input', { type: 'search', placeholder, 'aria-label': placeholder });
    panelSearchEl.addEventListener('input', () => render());
    setTimeout(() => panelSearchEl?.focus(), 0);
  }
  return h('div', { class: 'search' }, icon('search'), panelSearchEl);
}

function matchUsers(q, exclude = new Set()) {
  return [...S.users.values()].filter((u) => !A.isMe(u.id) && !exclude.has(u.id) && (!q || u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)));
}

function newChatPanel() {
  const q = panelSearchEl?.value.trim().toLowerCase() || '';
  const users = matchUsers(q);
  return panelShell('New chat', [
    panelSearch('Search name or tailnet login'),
    !q ? [
      action('group', 'New group', () => startNewGroup()),
      action('broadcast', 'New broadcast', () => newBroadcast()),
      action('link', 'Invite people to Tailchat', () => O.inviteToTailnetDialog(), 'Friends and family need Tailscale to reach you'),
      userRow(S.me, () => startDirect(S.me.id), 'Message yourself'),
    ] : null,
    !q && (S.ownDevices.length > 1 || A.machineChats().length) ? [
      h('div', { class: 'list-section' }, 'Your devices'),
      action('group', 'New device group', () => startNewGroup(true), 'Chat with several of your devices at once'),
      S.ownDevices.filter((d) => d.id !== S.device.id && !d.revokedAt).map((d) => h(
        'div',
        { class: 'row', onclick: () => A.openDeviceChat(d.id).then(() => { S.panel = null; render(); }).catch((e) => toast(e.message)) },
        avatar({ id: d.id, name: d.name }, 'md'),
        h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, d.name), h('div', { class: 'preview ellipsis' }, 'Only that device and this one can read it')),
      )),
      A.machineChats().map((m) => h(
        'div',
        { class: 'row', onclick: () => { S.panel = null; A.openMachine(m.id); } },
        avatar({ id: m.id, name: m.name }, 'md'),
        h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, m.name), h('div', { class: 'preview ellipsis' }, "Tailchat isn't open on it yet")),
      )),
    ] : null,
    h('div', { class: 'list-section' }, 'Contacts on Tailchat'),
    users.map((u) => userRow(u, () => startDirect(u.id))),
    !users.length
      ? h(
        'div',
        { class: 'empty' },
        q ? 'No contacts found' : 'Nobody else has opened Tailchat yet. People show up here once they have.',
        q ? null : h('div', null, h('button', { type: 'button', class: 'link', onclick: () => O.inviteToTailnetDialog() }, 'How to invite people')),
      )
      : null,
  ]);
}

// devices: a group of your own devices rather than of people.
function startNewGroup(devices = false) {
  ng = { step: 1, members: new Set(), name: null, photo: null, photoUrl: null, devices };
  panelSearchEl = null;
  openPanel('new-group');
}

// Step 1 of a new device group: pick at least two of your other devices.
function pickDevicesStep() {
  const devices = S.ownDevices.filter((d) => d.id !== S.device.id && !d.revokedAt);
  const toggle1 = (id) => { if (ng.members.has(id)) ng.members.delete(id); else ng.members.add(id); render(); };
  const machines = A.machineChats();
  return [
    ...panelShell('Add devices', [
      h('div', { class: 'chips-sel pad' }, [...ng.members].map((id) => h('button', { type: 'button', class: 'chip', onclick: () => toggle1(id) }, A.ownDevice(id)?.name || 'Device', ' ×'))),
      h('div', { class: 'empty small' }, 'Messages in a device group are end-to-end encrypted for the devices you pick and this one.'),
      devices.map((d) => h(
        'div',
        { class: 'row', onclick: () => toggle1(d.id) },
        avatar({ id: d.machine?.id || d.id, name: d.name }, 'md'),
        h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, d.name), h('div', { class: 'preview ellipsis' }, A.deviceWhere(d) || `Active ${listTime(d.lastActive)}`)),
        h('input', { type: 'checkbox', checked: ng.members.has(d.id), tabindex: -1, class: 'row-check' }),
      )),
      machines.map((m) => h(
        'div',
        { class: 'row disabled' },
        avatar({ id: m.id, name: m.name }, 'md'),
        h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, m.name), h('div', { class: 'preview ellipsis' }, 'Open Tailchat on it to add it to a group')),
      )),
      devices.length < 2 ? h('div', { class: 'empty' }, 'A device group needs at least two of your other devices. Open Tailchat on another device first.') : null,
    ]),
    h('button', {
      type: 'button',
      class: 'fab',
      'aria-label': 'Next',
      title: 'Next',
      onclick: () => {
        if (ng.members.size < 2) return toast('Pick at least two devices');
        ng.step = 2;
        render();
      },
    }, icon('forward')),
  ];
}

function newGroupPanel() {
  if (!ng) ng = { step: 1, members: new Set(), name: null, photo: null, photoUrl: null };
  if (ng.step === 1 && ng.devices) return pickDevicesStep();
  if (ng.step === 1) {
    const q = panelSearchEl?.value.trim().toLowerCase() || '';
    return [
      ...panelShell('Add group members', [
        h('div', { class: 'chips-sel pad' }, [...ng.members].map((id) => h('button', { type: 'button', class: 'chip', onclick: () => { ng.members.delete(id); render(); } }, A.nameOf(id), ' ×'))),
        panelSearch('Search name or tailnet login'),
        matchUsers(q).map((u) => h(
          'div',
          { class: 'row', onclick: () => { if (ng.members.has(u.id)) ng.members.delete(u.id); else ng.members.add(u.id); render(); } },
          avatar(u, 'md'),
          h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, u.name), h('div', { class: 'preview ellipsis' }, u.about || u.id)),
          h('input', { type: 'checkbox', checked: ng.members.has(u.id), tabindex: -1, class: 'row-check' }),
        )),
      ]),
      h('button', { type: 'button', class: 'fab', 'aria-label': 'Next', title: 'Next', onclick: () => { ng.step = 2; panelSearchEl = null; render(); } }, icon('forward')),
    ];
  }
  if (ng.name === null) {
    ng.name = h('input', { maxlength: 100, placeholder: 'Group name' });
    setTimeout(() => ng?.name?.focus(), 0);
  }
  let photoBtn;
  return [
    ...panelShell('New group', [
      h(
        'div',
        { class: 'card center' },
        (photoBtn = h('button', {
          type: 'button',
          class: 'avatar-btn',
          title: 'Add group icon',
          onclick: () => pickImage(async (file) => {
            const blob = await cropPhoto(file, { title: 'Group icon' });
            if (!blob) return;
            ng.photo = blob;
            if (ng.photoUrl) URL.revokeObjectURL(ng.photoUrl);
            ng.photoUrl = URL.createObjectURL(ng.photo);
            render();
          }),
        }, ng.photoUrl ? avatar({ id: 'new', name: '', src: ng.photoUrl }, 'lg') : h('div', { class: 'avatar lg placeholder' }, icon('camera'), h('span', null, 'Add group icon')))),
        h('label', { class: 'field' }, ng.name),
        ng.devices
          ? h('div', { class: 'muted' }, `This device and ${[...ng.members].map((id) => A.ownDevice(id)?.name || 'a device').join(', ')}`)
          : h('div', { class: 'muted' }, `${ng.members.size} member${ng.members.size === 1 ? '' : 's'} besides you: ${[...ng.members].map(A.nameOf).join(', ') || 'none yet'}`),
      ),
    ], null, null),
    h('button', { type: 'button', class: 'fab', 'aria-label': 'Create group', title: 'Create group', onclick: createGroup }, icon('check')),
  ];
}

async function createGroup() {
  const name = ng.name.value.trim();
  if (!name) return toast('Give the group a name');
  try {
    let avatarId;
    if (ng.photo) ({ id: avatarId } = await api.upload(ng.photo, { isPublic: true }));
    const { chat } = ng.devices
      ? await api.post('/api/chats/device-group', { name, deviceIds: [...ng.members], avatar: avatarId })
      : await api.post('/api/chats/group', { name, members: [...ng.members], avatar: avatarId });
    S.chats.set(chat.id, chat);
    if (ng.photoUrl) URL.revokeObjectURL(ng.photoUrl);
    ng = null;
    S.panel = null;
    A.openChat(chat.id);
  } catch (err) {
    toast(err.message);
  }
}

function pickImage(onPick) {
  const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.remove();
    if (file) onPick(file).catch?.((e) => toast(e.message));
  });
  document.body.append(input);
  input.click();
}

function archivedPanel() {
  const list = sortChats([...S.chats.values()].filter((c) => c.me.archived));
  return panelShell('Archived', [
    h('div', { class: 'empty small' }, 'These chats stay archived when new messages arrive. Right-click a chat to unarchive it.'),
    list.map(chatRow),
    !list.length ? h('div', { class: 'empty' }, 'No archived chats') : null,
  ]);
}

function starredPanel() {
  if (S.starred === null) {
    S.starred = [];
    A.loadStarred().catch((e) => toast(e.message));
  }
  return panelShell('Starred messages', S.starred.length ? S.starred.map((m) => starredRow(m)) : h('div', { class: 'empty' }, 'Star messages to find them here later. Right-click a message and choose Star.'));
}

function settingsRow(iconName, label, sub, onClick, danger = false) {
  return h('button', { type: 'button', class: `menu-row${danger ? ' danger' : ''}`, onclick: onClick }, icon(iconName), h('div', { class: 'grow' }, h('div', { class: danger ? 'danger' : '' }, label), sub ? h('div', { class: 'sub' }, sub) : null));
}

function settingsPanel() {
  return panelShell('Settings', [
    h('div', { class: 'row tall', onclick: () => openPanel('profile') }, avatar(S.me, 'md'), h('div', { class: 'body' }, h('div', { class: 'name' }, S.me.name), h('div', { class: 'preview ellipsis' }, S.me.about || S.me.id))),
    settingsRow('lock', 'Privacy', 'Last seen, read receipts, blocked contacts', () => openPanel('privacy')),
    settingsRow('theme', 'Themes', `${A.activeTheme().name} · ${MODE_LABELS[S.prefs.theme] || MODE_LABELS.system}`, () => openPanel('themes')),
    settingsRow('chat', 'Chats', 'Enter to send', () => openPanel('chat-settings')),
    settingsRow('phone', 'Calls', callSettingsSummary(), () => openPanel('call-settings')),
    settingsRow('bell', 'Notifications', S.prefs.notifications ? 'On' : 'Off', () => openPanel('notifications')),
    settingsRow('devices', 'Linked devices', null, () => openPanel('devices')),
    settingsRow('shield', 'Security', 'How Tailchat protects your messages', () => openPanel('help')),
    settingsRow('exit', 'Log out', null, logout, true),
  ], null);
}

// Saves a new profile photo (or removes it, with null). The server tells
// everyone else, your other devices included, with a "user" event.
async function setProfilePhoto(blob) {
  let id = null;
  if (blob) {
    profilePhotoBusy = true;
    render();
    try {
      ({ id } = await api.upload(blob, { isPublic: true }));
    } finally {
      profilePhotoBusy = false;
    }
  }
  const { user } = await api.patch('/api/me', { avatar: id });
  S.me = { ...S.me, ...user };
  S.users.set(user.id, { ...S.users.get(user.id), ...user });
  render();
  toast(blob ? 'Profile photo updated' : 'Profile photo removed');
}

let profilePhotoBusy = false;

async function changeProfilePhoto() {
  try {
    const blob = await pickPhoto({ title: 'Profile photo' });
    if (blob) await setProfilePhoto(blob);
  } catch (err) {
    profilePhotoBusy = false;
    render();
    toast(err.message);
  }
}

function profilePhotoMenu(anchor) {
  const uploaded = S.me.avatar && S.me.avatar.startsWith('/api/avatars/');
  menu(anchor, [
    S.me.avatar ? { label: 'View photo', icon: 'image', onClick: () => viewer({ title: S.me.name, subtitle: 'Profile photo', content: h('img', { src: S.me.avatar, alt: '', referrerpolicy: 'no-referrer' }) }) } : null,
    { label: S.me.avatar ? 'Change photo' : 'Add photo', icon: 'camera', onClick: changeProfilePhoto },
    uploaded ? { label: 'Remove photo', icon: 'delete', danger: true, onClick: () => setProfilePhoto(null).catch((e) => toast(e.message)) } : null,
  ]);
}

function profilePanel() {
  let photoBtn;
  const edit = async (field, title, max, multiline) => {
    const value = await promptDialog(title, { value: S.me[field] || '', max, multiline, okLabel: 'Save' });
    if (value === null) return;
    if (field === 'name' && !value.trim()) return toast("Your name can't be empty");
    try {
      const { user } = await api.patch('/api/me', { [field]: value.trim() });
      S.me = { ...S.me, ...user };
      S.users.set(user.id, { ...S.users.get(user.id), ...user });
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  return panelShell('Profile', [
    h(
      'div',
      { class: 'card center profile-card' },
      (photoBtn = h(
        'button',
        {
          type: 'button',
          class: `avatar-btn profile-photo${profilePhotoBusy ? ' busy' : ''}`,
          title: 'Change profile photo',
          'aria-label': 'Change profile photo',
          onclick: () => profilePhotoMenu(photoBtn),
        },
        avatar(S.me, 'lg'),
        h('span', { class: 'photo-badge', 'aria-hidden': 'true' }, icon('camera')),
        profilePhotoBusy ? h('span', { class: 'photo-spinner', 'aria-hidden': 'true' }) : null,
      )),
      h('button', { type: 'button', class: 'btn plain photo-change', onclick: changeProfilePhoto }, S.me.avatar ? 'Change photo' : 'Add a photo'),
      h('p', { class: 'muted small' }, 'Everyone on your Tailchat sees this photo, on every device.'),
    ),
    h('div', { class: 'card' }, h('h3', null, 'Your name'), h('div', { class: 'editable-line', onclick: () => edit('name', 'Your name', 60) }, h('span', { class: 'grow' }, S.me.name), icon('edit')), h('p', { class: 'muted small' }, 'Everyone who uses this Tailchat sees this name, including people it is shared with.')),
    h('div', { class: 'card' }, h('h3', null, 'About'), h('div', { class: 'editable-line', onclick: () => edit('about', 'About', 140, true) }, h('span', { class: 'grow' }, S.me.about || 'Hey there! I am using Tailchat.'), icon('edit'))),
    h('div', { class: 'card' }, h('h3', null, 'Tailnet login'), h('div', null, S.me.id), h('p', { class: 'muted small' }, 'Tailchat knows who you are from your Tailscale identity. There are no passwords.')),
  ], 'settings');
}

function privacyPanel() {
  const blocked = [...S.users.values()].filter((u) => u.blocked);
  const set = (body) => api.patch('/api/me', body).then(({ user }) => { S.me = { ...S.me, ...user }; render(); }).catch((e) => toast(e.message));
  return panelShell('Privacy', [
    h('div', { class: 'menu-row' }, icon('clock'), h('div', { class: 'grow' }, h('div', null, 'Last seen and online'), h('div', { class: 'sub' }, "If you hide yours, you won't see other people's either")), toggle(!S.me.hideLastSeen, (on) => set({ hideLastSeen: !on }), 'Share last seen')),
    h('div', { class: 'menu-row' }, icon('checks'), h('div', { class: 'grow' }, h('div', null, 'Read receipts'), h('div', { class: 'sub' }, "If you turn these off, you won't send or receive read receipts in direct chats. Groups always send them.")), toggle(S.me.readReceipts !== false, (on) => set({ readReceipts: on }), 'Read receipts')),
    h('div', { class: 'list-section' }, `Blocked contacts${blocked.length ? ` (${blocked.length})` : ''}`),
    blocked.map((u) => userRow(u, async () => {
      if (await confirmDialog(`Unblock ${u.name}?`, 'They will be able to message and call you again.', 'Unblock')) api.del(`/api/blocks/${encodeURIComponent(u.id)}`).catch((e) => toast(e.message));
    }, 'Click to unblock')),
    h('div', { class: 'row short', onclick: async () => {
      const ids = await O.pickUsers({ title: 'Block contact', multiple: false, exclude: blocked.map((u) => u.id) });
      if (ids?.[0]) api.post('/api/blocks', { userId: ids[0] }).catch((e) => toast(e.message));
    } }, h('div', { class: 'row-icon' }, icon('block')), h('div', { class: 'body' }, 'Block a contact')),
  ], 'settings');
}

function chatSettingsPanel() {
  return panelShell('Chats', [
    settingsRow('theme', 'Themes', `${A.activeTheme().name} · ${MODE_LABELS[S.prefs.theme] || MODE_LABELS.system}`, () => openPanel('themes')),
    h('div', { class: 'list-section' }, 'Keyboard'),
    h('div', { class: 'menu-row' }, icon('send'), h('div', { class: 'grow' }, h('div', null, 'Enter is send'), h('div', { class: 'sub' }, 'Shift+Enter adds a new line')), toggle(S.prefs.enterToSend, (on) => A.savePrefs({ enterToSend: on }), 'Enter is send')),
  ], 'settings');
}

// ---------- call settings ----------

const QUALITY_NOTES = {
  best: 'The sharpest picture both cameras and your connection allow',
  fhd: 'Sharp, and lighter on the connection',
  hd: 'For slower connections',
  saver: 'Uses the least data',
};

const callQuality = () => (S.prefs.callQuality in QUALITIES ? S.prefs.callQuality : DEFAULT_QUALITY);

function callSettingsSummary() {
  return `${QUALITIES[callQuality()].short} video · ${S.prefs.hdAudio !== false ? 'HD audio' : 'standard audio'}`;
}

let ringPreview = null;
function previewRingtone() {
  clearTimeout(ringPreview);
  if (tones.playing('ringtone') && ringPreview) {
    tones.stop('ringtone');
    ringPreview = null;
  } else {
    tones.ringtone({ sound: true, vibrate: S.prefs.vibrate !== false });
    ringPreview = setTimeout(() => {
      tones.stop('ringtone');
      ringPreview = null;
      render();
    }, 4800);
  }
  render();
}

function callAlertsToggle(on) {
  if (!on) return A.savePrefs({ callAlerts: false });
  if (!('Notification' in window)) return toast("This browser can't show notifications");
  Notification.requestPermission().then((p) => {
    A.savePrefs({ callAlerts: p === 'granted' });
    if (p !== 'granted') toast('Notifications are blocked in your browser settings');
  });
}

function callSettingsPanel() {
  const q = callQuality();
  const line = (iconName, label, sub, control) => h('div', { class: 'menu-row' }, icon(iconName), h('div', { class: 'grow' }, h('div', null, label), sub ? h('div', { class: 'sub' }, sub) : null), control);
  const supported = 'Notification' in window;
  const incoming = [];
  if (native.app) {
    // What Android lets the app do, as it last told us. Each one opens the
    // right page of the phone's settings.
    const st = native.status;
    const allow = (what, ok, label = 'Allow') => (ok
      ? h('span', { class: 'call-allowed' }, icon('check'), 'On')
      : h('button', { type: 'button', class: 'btn plain small', onclick: () => native.post('open-settings', { what }) }, label));
    incoming.push(
      line('ringer', 'Ring when Tailchat is closed', 'Keeps a connection to your server so calls ring like phone calls. Android shows a small notification while it does.', toggle(!!st.background, (on) => native.post('keep-alive', { on }), 'Ring when Tailchat is closed')),
      line('layers', 'Show calls over other apps', 'A call that comes in while you use another app fills the screen, so you can answer it there', allow('overlay', st.overlay)),
      line('fullscreen', 'Ring on the lock screen', 'Incoming calls show full screen when your phone is locked', allow('full-screen', st.fullScreen !== false)),
      line('bell', 'Call notifications', 'Answer and Decline in the notification, and missed calls', allow('notifications', st.notifications !== false)),
      line('battery', 'No battery limits', "So Android doesn't put Tailchat to sleep and miss calls", allow('battery', st.battery, 'Remove')),
      line('pip', 'Picture in picture', 'Leave the app in a video call and it carries on in a small window', allow('pip', st.pip !== false)),
    );
  } else {
    const perm = supported ? Notification.permission : 'denied';
    incoming.push(line('bell', 'Ringing notifications', !supported ? "This browser can't show notifications" : perm === 'denied' ? 'Blocked in your browser settings' : 'With Answer and Decline, when Tailchat is in the background', supported ? toggle(S.prefs.callAlerts !== false && perm === 'granted', callAlertsToggle, 'Ringing notifications') : null));
  }
  return panelShell('Calls', [
    h('div', { class: 'list-section' }, 'Video quality'),
    Object.entries(QUALITIES).map(([key, v]) => h(
      'button',
      { type: 'button', class: 'menu-row', 'aria-pressed': String(q === key), onclick: () => A.savePrefs({ callQuality: key }) },
      icon(key === 'saver' ? 'battery' : 'hd'),
      h('div', { class: 'grow' }, h('div', null, v.label), h('div', { class: 'sub' }, QUALITY_NOTES[key])),
      q === key ? icon('check') : null,
    )),
    h('div', { class: 'list-section' }, 'Sound'),
    line('mic', 'HD audio', 'Full-band, studio-quality voice. Turn it off on a slow connection.', toggle(S.prefs.hdAudio !== false, (on) => A.savePrefs({ hdAudio: on }), 'HD audio')),
    line('ringer', 'Ringtone', native.app ? "Your phone's ringtone, for incoming calls" : 'Plays while a call rings and Tailchat is open', toggle(S.prefs.ringtone !== false, (on) => A.savePrefs({ ringtone: on }), 'Ringtone')),
    native.app ? null : line('music', 'Hear the ringtone', null, h('button', { type: 'button', class: 'btn plain small', onclick: previewRingtone }, ringPreview ? 'Stop' : 'Play')),
    line('vibrate', 'Vibrate', 'When a call rings, on phones that can', toggle(S.prefs.vibrate !== false, (on) => A.savePrefs({ vibrate: on }), 'Vibrate')),
    h('div', { class: 'list-section' }, 'Incoming calls'),
    incoming,
    h('div', { class: 'empty small' }, icon('lock'), ' Audio and video go straight between your devices across your tailnet, encrypted end to end. Your server only rings them.'),
  ], 'settings');
}

// ---------- themes ----------

const MODE_LABELS = { system: 'System default', light: 'Light', dark: 'Dark' };
const themeEdit = { id: null, mode: 'light' };

// A small picture of a theme: a bar, two messages and its accent.
function themeSwatch(pal) {
  return h(
    'div',
    { class: 'theme-swatch', style: { background: pal.chat } },
    h('div', { class: 'bar', style: { background: pal.header } }, h('span', { class: 'dot', style: { background: pal.accent } })),
    h('div', { class: 'msg in', style: { background: pal.in } }, h('span', { style: { background: pal.text } })),
    h('div', { class: 'msg out', style: { background: pal.out } }, h('span', { style: { background: T.textOn(pal.out) } })),
  );
}

function themeCard(t, mode, selected) {
  return slots.get(`theme-card:${t.id}`, JSON.stringify([t, mode, selected]), () => h(
    'button',
    { type: 'button', class: `theme-card${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), title: t.name, onclick: () => A.savePrefs({ palette: t.id }) },
    themeSwatch(t[mode]),
    h('span', { class: 'theme-name ellipsis' }, selected ? icon('check') : null, t.name),
  ));
}

function saveThemes(themes) {
  A.savePrefs({ themes });
}

// Built-in themes stay as they are: editing one makes your own copy.
function editTheme(theme) {
  let t = theme;
  if (T.isPreset(theme.id)) {
    const mine = T.customThemes(S.prefs);
    if (mine.length >= 30) return toast('You have 30 themes. Delete one to make another.');
    t = T.copyTheme(theme, S.prefs);
    saveThemes([...mine, t]);
    A.savePrefs({ palette: t.id });
  }
  themeEdit.id = t.id;
  themeEdit.mode = A.themeMode();
  openPanel('theme-editor');
}

async function importTheme() {
  const code = await promptDialog('Add a theme', { label: 'Theme code', placeholder: 'Paste a theme code copied from Tailchat', multiline: true, max: 4000, okLabel: 'Add' });
  if (code === null) return;
  const t = T.parseThemeCode(code);
  if (!t) return toast("That isn't a Tailchat theme code");
  const mine = T.customThemes(S.prefs);
  if (mine.length >= 30) return toast('You have 30 themes. Delete one to add another.');
  saveThemes([...mine, t]);
  A.savePrefs({ palette: t.id });
  toast(`Added ${t.name}`);
}

function themesPanel() {
  const active = A.activeTheme();
  const mode = A.themeMode();
  const mine = T.customThemes(S.prefs);
  const modeChip = (value) => h('button', {
    type: 'button',
    class: `chip${(S.prefs.theme || 'system') === value ? ' active' : ''}`,
    onclick: () => A.savePrefs({ theme: value }),
  }, MODE_LABELS[value]);
  return panelShell('Themes', [
    h('div', { class: 'list-section' }, 'Mode'),
    h('div', { class: 'filters pad-x' }, ['system', 'light', 'dark'].map(modeChip)),
    h('div', { class: 'list-section' }, 'Built-in themes'),
    h('div', { class: 'theme-grid' }, T.PRESETS.map((t) => themeCard(t, mode, t.id === active.id))),
    h('div', { class: 'list-section' }, 'Your themes'),
    mine.length
      ? h('div', { class: 'theme-grid' }, mine.map((t) => themeCard(t, mode, t.id === active.id)))
      : h('div', { class: 'empty small' }, 'Edit a theme to make your own version of it. Your themes appear here.'),
    action('edit', T.isPreset(active.id) ? `Edit a copy of ${active.name}` : `Edit ${active.name}`, () => editTheme(active)),
    action('add', 'Add a theme from a code', () => importTheme()),
    h('div', { class: 'empty small' }, 'Themes are kept on this device. To use one on another device, copy its code in the editor and add it there.'),
  ], 'settings');
}

function themeEditorPanel() {
  const t = T.customThemes(S.prefs).find((x) => x.id === themeEdit.id);
  if (!t) {
    S.panel = 'themes';
    return themesPanel();
  }
  const mode = themeEdit.mode;
  const pal = t[mode];
  const issues = T.readability(pal);
  const weak = new Set(issues.flatMap((i) => i.keys));
  const update = (fn) => saveThemes(T.customThemes(S.prefs).map((x) => (x.id === t.id ? T.cleanTheme(fn(structuredClone(x)), x.id) : x)));
  const nameInput = slots.get(`theme-name:${t.id}`, t.name, () => {
    const input = h('input', { maxlength: 40, value: t.name, 'aria-label': 'Theme name' });
    input.addEventListener('change', () => {
      const name = input.value.trim();
      if (name) update((x) => ({ ...x, name }));
      else input.value = t.name;
    });
    return input;
  });
  const colourRow = ([key, , label]) => slots.get(`theme-colour:${t.id}:${mode}:${key}`, JSON.stringify([pal[key], weak.has(key)]), () => {
    const hex = h('span', { class: 'sub mono' }, pal[key]);
    const input = h('input', { type: 'color', value: pal[key], 'aria-label': label });
    // Dragging around the picker repaints the app; letting go saves it.
    input.addEventListener('input', () => {
      hex.textContent = input.value;
      const now = T.customThemes(S.prefs).find((x) => x.id === t.id)?.[mode] || pal;
      A.applyTheme({ ...now, [key]: input.value });
    });
    input.addEventListener('change', () => update((x) => ({ ...x, [mode]: { ...x[mode], [key]: input.value } })));
    return h('label', { class: 'menu-row colour-row' }, h('div', { class: 'grow' }, h('div', null, label), hex, weak.has(key) ? h('div', { class: 'sub warn-text' }, 'Hard to read') : null), input);
  });
  const modeChip = (m) => h('button', {
    type: 'button',
    class: `chip${mode === m ? ' active' : ''}`,
    onclick: () => {
      themeEdit.mode = m;
      S.themePreview = m;
      A.applyTheme();
      render();
    },
  }, m === 'light' ? 'Light colours' : 'Dark colours');
  const base = T.PRESETS.find((x) => x.id === t.base) || T.PRESETS[0];
  return panelShell('Edit theme', [
    h('div', { class: 'card' }, h('label', { class: 'field' }, h('span', null, 'Name'), nameInput)),
    h('div', { class: 'filters pad-x' }, ['light', 'dark'].map(modeChip)),
    h('div', { class: 'empty small left' }, `You're editing the ${mode} colours. The app shows them while you edit.`),
    T.KEYS.map(colourRow),
    issues.length ? h('div', { class: 'banner warn' }, icon('info'), h('div', null, `Hard to read: ${issues.map((i) => i.label.toLowerCase()).join(', ')}.`)) : null,
    action('history', `Reset the ${mode} colours to ${base.name}`, () => update((x) => ({ ...x, [mode]: { ...base[mode] } }))),
    action('copy', 'Copy theme code', () => navigator.clipboard.writeText(T.themeCode(t)).then(() => toast('Theme code copied'), () => toast("Couldn't copy the code"))),
    action('delete', 'Delete theme', async () => {
      if (!(await confirmDialog(`Delete ${t.name}?`, 'This removes it from this device.', 'Delete', 'danger'))) return;
      saveThemes(T.customThemes(S.prefs).filter((x) => x.id !== t.id));
      if (S.prefs.palette === t.id) A.savePrefs({ palette: t.base });
      openPanel('themes');
    }),
  ], 'themes');
}

function notificationsPanel() {
  const supported = 'Notification' in window;
  return panelShell('Notifications', [
    h('div', { class: 'menu-row' }, icon('bell'), h('div', { class: 'grow' }, h('div', null, 'Desktop notifications'), h('div', { class: 'sub' }, !supported ? "This browser can't show notifications" : Notification.permission === 'denied' ? 'Blocked in your browser settings' : 'Show new messages while Tailchat is in the background')), supported ? toggle(S.prefs.notifications && Notification.permission === 'granted', (on) => (on ? enableNotifications() : A.savePrefs({ notifications: false })), 'Desktop notifications') : null),
    settingsRow('phone', 'Calls', 'Ringing notifications, ringtone and vibration', () => openPanel('call-settings')),
    h('div', { class: 'empty small' }, 'Notifications show the sender and a preview. They are generated on this device after decryption; the server never sees message text.'),
  ], 'settings');
}

let devicesCache = null;
function devicesPanel() {
  if (!devicesCache) {
    const cache = (devicesCache = { loaded: false });
    A.loadHistory().then(() => { cache.loaded = true; render(); }).catch((e) => toast(e.message));
  }
  const list = devicesCache.loaded ? S.ownDevices : [];
  return panelShell('Linked devices', [
    h(
      'div',
      { class: 'card' },
      h('p', null, `Link a phone, tablet or computer anywhere in the world: install Tailscale on it, sign in with the same account you use here (${S.me.id}), then open this address:`),
      h('div', { class: 'invite-link' }, location.origin),
      h('button', { type: 'button', class: 'btn plain', onclick: () => navigator.clipboard.writeText(location.origin).then(() => toast('Address copied')) }, 'Copy address'),
      h('p', { class: 'muted small' }, "Tailscale connects your devices over the internet wherever they are, with nothing to set up on your router. Each device gets its own encryption key, and its code below lets you check it's really yours."),
    ),
    h('div', { class: 'list-section' }, 'Chat history'),
    historyCard(list),
    h('div', { class: 'list-section' }, `${list.length} active device${list.length === 1 ? '' : 's'}`),
    list.map((d) => h(
      'div',
      { class: 'row' },
      h('div', { class: 'row-icon' }, icon('devices')),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'name ellipsis' }, d.name, d.id === S.device.id ? ' (this device)' : ''),
        A.deviceWhere(d) ? h('div', { class: 'preview ellipsis' }, A.deviceWhere(d)) : null,
        h('div', { class: 'preview' }, `Linked ${listTime(d.createdAt)} · active ${listTime(d.lastActive)}`),
        S.badKeys.has(d.id)
          ? h('div', { class: 'preview warn-text' }, "Its key isn't the one this device saw before")
          : h('div', { class: 'preview mono' }, `Code ${S.deviceCodes.get(d.id) || '…'}`),
      ),
      iconButton('edit', 'Rename', () => O.renameDeviceDialog(d)),
      d.id !== S.device.id ? h('button', { type: 'button', class: 'btn plain small', onclick: async () => {
        if (!(await confirmDialog(`Log out ${d.name}?`, 'It will stop receiving messages and its key will no longer be used.', 'Log out', 'danger'))) return;
        await api.del(`/api/devices/${encodeURIComponent(d.id)}`).catch((e) => toast(e.message));
        devicesCache = null;
        render();
      } }, 'Log out') : null,
    )),
  ], null);
}

// What this device knows about getting history from your other devices.
function historyCard(list) {
  const others = list.filter((d) => d.id !== S.device.id);
  const mine = S.history.requests.get(S.device.id);
  const by = A.ownDevice(mine?.byDevice)?.name || 'Your other device';
  const ask = (label) => h('button', {
    type: 'button',
    class: 'btn primary',
    onclick: () => A.requestHistory().then(() => toast('Asked your other devices. Approve it on one of them.')).catch((e) => toast(e.message)),
  }, label);
  if (!others.length) {
    return h('div', { class: 'card' }, h('p', { class: 'muted small' }, "Messages sent before a device was linked can't be read on it until another of your devices shares them. Link a second device to use this."));
  }
  if (mine?.state === 'pending') {
    return h(
      'div',
      { class: 'card' },
      h('p', null, 'Waiting for one of your other devices to share your chat history. Open Tailchat on it and tap Review and share, then check it shows this code:'),
      h('div', { class: 'code' }, (S.deviceCodes.get(S.device.id) || '…').split(' ').map((g) => h('span', null, g))),
      h('button', { type: 'button', class: 'btn plain', onclick: () => A.declineHistory(S.device.id).catch((e) => toast(e.message)) }, 'Cancel'),
    );
  }
  return h(
    'div',
    { class: 'card' },
    h('p', null, "Messages sent before this device was linked can't be read here until one of your other devices shares them. Your history stays end-to-end encrypted on the way."),
    mine?.state === 'done' ? h('p', { class: 'muted small' }, `${by} shared ${mine.shared} message${mine.shared === 1 ? '' : 's'} ${listTime(mine.updatedAt)}.`) : null,
    mine?.state === 'declined' && mine.byDevice !== S.device.id ? h('p', { class: 'muted small' }, `${by} didn't share ${listTime(mine.updatedAt)}.`) : null,
    ask(mine ? 'Ask again' : 'Get chat history from my other devices'),
  );
}

function helpPanel() {
  const p = (text) => h('p', null, text);
  return panelShell('Security', [
    h('div', { class: 'card' },
      p('Tailchat runs on your own server and is only reachable inside your tailnet. Tailscale tells the server who you are, so there are no passwords or phone numbers.'),
      p('Every message, file, voice note and status update is encrypted on your device with keys that never leave it. The server stores ciphertext and the minimum it needs to deliver messages: who is in which chat, when messages were sent, and file sizes.'),
      p('Each chat has a security code you can compare with the other people in it. If the codes match, nobody (including whoever runs the server) can read your messages.'),
      p('Calls connect device to device across your tailnet. Media is encrypted twice: by WebRTC and by WireGuard.'),
      h('p', { class: 'muted small' }, `Signed in as ${S.me.id} on ${S.device.name}.`),
    ),
  ], 'settings');
}

// ---------- broadcast lists (stored on this device, like on a phone) ----------

const broadcasts = () => (Array.isArray(S.prefs.broadcasts) ? S.prefs.broadcasts : []);

async function newBroadcast() {
  const ids = await O.pickUsers({ title: 'New broadcast: pick recipients', okLabel: 'Next' });
  if (!ids?.length) return;
  const name = await promptDialog('Broadcast list name', { value: ids.map(A.nameOf).join(', ').slice(0, 60), okLabel: 'Create', max: 60 });
  if (name === null) return;
  A.savePrefs({ broadcasts: [...broadcasts(), { id: crypto.randomUUID(), name: name.trim() || 'Broadcast list', members: ids }] });
  openPanel('broadcasts');
}

function broadcastDialog(list) {
  const ta = h('textarea', { rows: 4, maxlength: 65536, placeholder: 'Type a message' });
  let files = [];
  const fileLine = h('div', { class: 'muted' });
  dialog({
    title: list.name,
    content: [
      h('p', { class: 'muted' }, `Sends a separate encrypted message to each of: ${list.members.map(A.nameOf).join(', ')}. Replies arrive in your chat with each person.`),
      h('label', { class: 'field' }, ta),
      fileLine,
      h('button', { type: 'button', class: 'btn plain', onclick: () => {
        chooseFiles({ multiple: true }).then((picked) => {
          if (!picked.length) return;
          files = picked.filter((f) => !O.fileTooBig(f));
          fileLine.textContent = files.map((f) => f.name).join(', ');
        }, (err) => toast(err?.message || "Couldn't open that file"));
      } }, icon('attach'), ' Attach files'),
    ],
    actions: [
      { label: 'Delete list', onClick: (close) => { close(); A.savePrefs({ broadcasts: broadcasts().filter((b) => b.id !== list.id) }); } },
      {
        label: 'Send',
        kind: 'primary',
        onClick: async (close) => {
          const text = ta.value.trim();
          if (!text && !files.length) return;
          close();
          let sent = 0;
          for (const userId of list.members) {
            try {
              const { chat } = await api.post('/api/chats/direct', { userId });
              S.chats.set(chat.id, chat);
              if (text) await A.sendText(chat.id, text);
              for (const f of files) await A.sendFile(chat.id, f, { kind: kindFor(f) });
              sent++;
            } catch {
              // reported by the send itself
            }
          }
          toast(`Broadcast sent to ${sent} of ${list.members.length}`);
        },
      },
    ],
  });
}

function broadcastsPanel() {
  const lists = broadcasts();
  return panelShell('Broadcast lists', [
    h('div', { class: 'row short', onclick: newBroadcast }, h('div', { class: 'row-icon accent' }, icon('add')), h('div', { class: 'body' }, 'New broadcast list')),
    lists.map((b) => h('div', { class: 'row', onclick: () => broadcastDialog(b) }, h('div', { class: 'row-icon accent' }, icon('broadcast')), h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, b.name), h('div', { class: 'preview ellipsis' }, `${b.members.length} recipient${b.members.length === 1 ? '' : 's'}: ${b.members.map(A.nameOf).join(', ')}`)))),
    h('div', { class: 'empty small' }, 'Send one message to several people at once. Each person gets it as a normal private message. Broadcast lists are saved in this browser.'),
  ]);
}

function panelNodes() {
  switch (S.panel) {
    case 'new-chat':
      return newChatPanel();
    case 'new-group':
      return newGroupPanel();
    case 'archived':
      return archivedPanel();
    case 'starred':
      return starredPanel();
    case 'settings':
      return settingsPanel();
    case 'profile':
      return profilePanel();
    case 'privacy':
      return privacyPanel();
    case 'chat-settings':
      return chatSettingsPanel();
    case 'call-settings':
      return callSettingsPanel();
    case 'themes':
      return themesPanel();
    case 'theme-editor':
      return themeEditorPanel();
    case 'notifications':
      return notificationsPanel();
    case 'devices':
      return devicesPanel();
    case 'help':
      return helpPanel();
    case 'broadcasts':
      return broadcastsPanel();
    case 'channels':
      return channelsPanel();
    case 'community':
      return communityPanel();
    default:
      S.panel = null;
      return null;
  }
}

function renderSidebar() {
  if (panelKey !== S.panel) {
    panelKey = S.panel;
    panelSearchEl = null;
    if (S.panel !== 'devices') devicesCache = null;
    if (S.panel !== 'new-group') ng = null;
    if (S.panel !== 'channels') directory = null;
    S.themePreview = S.panel === 'theme-editor' ? themeEdit.mode : null;
    A.applyTheme();
  }
  let nodes = S.panel ? panelNodes() : null;
  if (!nodes) {
    let body;
    if (S.view === 'status') body = updatesTab();
    else if (S.view === 'communities') body = communitiesTab();
    else if (S.view === 'calls') body = callsTab();
    else body = chatsTab();
    nodes = [topbar(), body];
  }
  reconcile(sidebarEl, nodes);
}

// ---------- shell ----------

function welcome() {
  const tip = (iconName, title, text) => h('div', { class: 'tip' }, h('span', { class: 'tip-icon' }, icon(iconName)), h('div', null, h('div', { class: 'tip-title' }, title), h('div', { class: 'muted small' }, text)));
  return h(
    'div',
    { class: 'welcome' },
    h('div', { class: 'welcome-logo' }, logoMark()),
    h('h1', null, 'Tailchat'),
    h('p', null, 'Message, call and share files with people on your tailnet.'),
    h(
      'div',
      { class: 'tips' },
      tip('edit', 'Start a chat', 'Anyone signed in to your tailnet can be messaged.'),
      tip('devices', 'Use it everywhere', 'Open Tailchat on your other devices to chat from them too.'),
      tip('phone', 'Call over the tailnet', 'Voice and video go device to device.'),
    ),
    h('div', { class: 'lock' }, icon('lock'), 'Your personal messages are end-to-end encrypted'),
  );
}

// The main pane for a machine of yours that hasn't opened Tailchat yet.
function machinePane(m) {
  const seen = lastSeenText(m);
  return slots.get('machine-pane', JSON.stringify([m.id, m.name, seen, location.origin]), () => h(
    'div',
    { class: 'conversation machine-pane' },
    h(
      'header',
      { class: 'topbar' },
      iconButton('back', 'Back', () => { S.machine = null; render(); }, { class: 'icon-btn back-btn' }),
      avatar({ id: m.id, name: m.name }),
      h('div', { class: 'title' }, h('div', { class: 'name ellipsis' }, m.name), h('div', { class: 'sub ellipsis' }, seen ? `${seen} on your tailnet` : 'Your device on the tailnet')),
    ),
    h(
      'div',
      { class: 'welcome' },
      icon('devices'),
      h('h1', null, `Chat with ${m.name}`),
      h('p', null, `${m.name} is one of your devices on the tailnet. To send it messages and files, open this address on it once, in any browser:`),
      h('div', { class: 'invite-link' }, location.origin),
      h('button', {
        type: 'button',
        class: 'btn plain',
        onclick: () => navigator.clipboard.writeText(location.origin).then(() => toast('Address copied'), () => toast("Couldn't copy the address")),
      }, 'Copy address'),
      h('p', { class: 'muted small' }, 'Its chat then takes the place of this one. Only that device and this one can read what you send in it.'),
      h('div', { class: 'lock' }, icon('lock'), 'End-to-end encrypted between your devices'),
    ),
  ));
}

function update() {
  let chat = S.active ? S.chats.get(S.active) : null;
  if (S.active && !chat) S.active = null;
  let machine = null;
  if (!chat && S.machine) {
    // It opened Tailchat while you were looking: show its chat instead,
    // once that's there.
    const opened = [...S.chats.values()].find((c) => A.isDeviceChat(c) && A.ownDevice(A.devicePeer(c))?.machine?.id === S.machine);
    machine = opened ? null : S.machines.list.find((m) => m.id === S.machine) || null;
    if (!machine) S.machine = null;
    if (opened) {
      A.openChat(opened.id);
      chat = S.chats.get(opened.id);
    }
  }
  root.classList.toggle('chat-open', !!chat || !!machine);
  reconcile(railEl, [rail()]);
  renderSidebar();
  reconcile(mainEl, [chat ? convEl : machine ? machinePane(machine) : welcomeEl, chat && S.details ? detailsEl : null]);
  if (chat) renderConversation(convEl, chat);
  if (chat && S.details) renderDetails(detailsEl, chat);
  O.renderCalls();
  A.updateTitle();
}

function onKey(e) {
  if (e.key !== 'Escape' || document.getElementById('layer').children.length) return;
  if (S.details) S.details = null;
  else if (S.panel) S.panel = null;
  else return;
  render();
}

export function mount() {
  root = document.getElementById('app');
  railEl = h('nav', { class: 'rail', 'aria-label': 'Sections' });
  sidebarEl = h('aside', { class: 'sidebar' });
  mainEl = h('section', { class: 'main' });
  convEl = h('div', { class: 'conversation' });
  detailsEl = h('aside', { class: 'details' });
  welcomeEl = welcome();
  root.replaceChildren(railEl, sidebarEl, mainEl);
  A.onRender(update);
  native.on('status', () => render());
  document.addEventListener('keydown', onKey);
  // Files dropped on the open chat go to the attach dialog.
  convEl.addEventListener('dragover', (e) => e.preventDefault());
  convEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const chat = S.chats.get(S.active);
    const files = [...(e.dataTransfer?.files || [])];
    if (chat && files.length && !canSend(chat)) attachDialog(chat, files);
  });
  update();
  const invite = /^\/invite\/([A-Za-z0-9_-]{6,64})$/.exec(location.pathname);
  if (invite) O.handleInvite(invite[1]);
}
