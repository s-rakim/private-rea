// App shell and the left column: chat list, status, calls, and the panels
// that slide over it (new chat, new group, settings, starred, archived).
import * as A from './app.js';
import { S, api, render } from './app.js';
import { kvDelete } from './api.js';
import { h, icon, iconButton, avatar, toast, menu, dialog, confirmDialog, promptDialog, listTime, duration, reconcile, Slots, toggle } from './ui.js';
import { resizePhoto, kindFor } from './media.js';
import * as O from './overlays.js';
import { renderConversation, drafts, clearChat, deleteChat, exitGroup, exitLabel, attachDialog, canSend, followChannel, openCommunity } from './conversation.js';
import { renderDetails, starredRow, inviteDialog, addMembers, deactivateCommunity } from './details.js';

const slots = new Slots();
let root;
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
      : { label: A.isGroupish(chat) ? `Delete ${A.noun(chat)}` : 'Delete chat', icon: 'delete', danger: true, onClick: () => deleteChat(chat) },
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
    tick: last && last.kind === 'msg' && A.isMe(last.senderId) && !last.deletedAt ? A.tickState(last, chat) : null,
    prefix: last && A.showsSender(chat) && last.kind === 'msg' && !last.deletedAt && !A.isMe(last.senderId) ? `${A.nameOf(last.senderId)}: ` : '',
    preview: last ? A.previewText(last) : A.isGroupish(chat) ? 'No messages yet' : A.isDeviceChat(chat) ? 'Send messages and files to this device' : '',
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
        class: `row${d.selected ? ' selected' : ''}`,
        onclick: () => {
          S.panel = null;
          A.openChat(chat.id);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          chatMenu(S.chats.get(chat.id) || chat, { x: e.clientX, y: e.clientY });
        },
      },
      avatar(d.av, 'md'),
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
  if (chats.length) nodes.push(h('div', { class: 'list-section' }, 'Chats'), chats.map(chatRow));
  const direct = new Set(chats.filter((c) => c.type === 'direct').map((c) => A.otherMember(c)));
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
      if (S.filter === 'groups') return c.type === 'group' || c.type === 'community';
      return true;
    }));
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
      !shown.length
        ? h('div', { class: 'empty' }, S.filter === 'unread' ? 'No unread chats' : S.filter === 'groups' ? 'No groups yet' : 'No chats yet. Start one with the new chat button.')
        : null,
      shown.length ? h('div', { class: 'empty small' }, icon('lock'), ' Your personal messages are end-to-end encrypted') : null,
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
    h('button', { type: 'button', class: 'fab', 'aria-label': 'New chat', title: 'New chat', onclick: () => openPanel('new-chat') }, icon('chat')),
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
      h('p', { class: 'muted small' }, icon('info'), " Anyone on your tailnet can find and follow your channel. Like WhatsApp channels, posts aren't end-to-end encrypted, and followers can't see each other."),
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

function callsTab() {
  const rows = S.calls
    .map((c) => {
      const chat = S.chats.get(c.chatId);
      if (!chat) return null;
      const outgoing = A.isMe(c.callerId);
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
      h('div', { class: 'list-section' }, 'Recent'),
      rows.length ? rows : h('div', { class: 'empty' }, 'No calls yet'),
      h('div', { class: 'empty small' }, icon('lock'), ' Calls go device to device across your tailnet and are end-to-end encrypted'),
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

function topbar() {
  const unseen = [...S.statuses.values()].some((s) => !s.seen && !A.isMe(s.userId));
  const sig = JSON.stringify([S.me, S.online, unseen]);
  return slots.get('topbar', sig, () => {
    let more;
    return h(
      'header',
      { class: 'topbar' },
      h('button', { type: 'button', class: 'avatar-btn', 'aria-label': 'Profile', onclick: () => openPanel('profile') }, avatar(S.me)),
      h('div', { class: 'title' }, h('div', { class: 'name' }, 'Tailchat'), h('div', { class: 'sub' }, S.online ? S.me.id : 'Connecting…')),
      iconButton('group', 'New group', () => startNewGroup()),
      iconButton('chat', 'New chat', () => openPanel('new-chat')),
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

function tabs() {
  let unread = 0;
  let channelUnread = false;
  for (const c of S.chats.values()) {
    const has = !c.me.archived && (c.unread || c.me.markedUnread);
    if (has && A.isChannel(c)) channelUnread = true;
    else if (has) unread++;
  }
  const unseen = channelUnread || [...S.statuses.values()].some((s) => !s.seen && !A.isMe(s.userId));
  const missed = S.calls.filter((c) => !c.answeredAt && !A.isMe(c.callerId) && c.startedAt > (S.prefs.callsSeenAt || 0)).length;
  return slots.get('tabs', JSON.stringify([S.view, unread, unseen, missed]), () => {
    const tab = (view, label, badge) => h('button', {
      type: 'button',
      class: `tab${S.view === view ? ' active' : ''}`,
      onclick: () => {
        if (view === 'calls') A.savePrefs({ callsSeenAt: Date.now() });
        setView(view);
      },
    }, label, badge);
    return h(
      'nav',
      { class: 'tabs' },
      tab('chats', 'Chats', unread ? h('span', { class: 'badge' }, String(unread)) : null),
      tab('status', 'Updates', unseen ? h('span', { class: 'badge dot' }) : null),
      tab('communities', 'Communities'),
      tab('calls', 'Calls', missed ? h('span', { class: 'badge' }, String(missed)) : null),
    );
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
    !q && S.ownDevices.length > 1 ? [
      h('div', { class: 'list-section' }, 'Your devices'),
      S.ownDevices.filter((d) => d.id !== S.device.id).map((d) => h(
        'div',
        { class: 'row', onclick: () => A.openDeviceChat(d.id).then(() => { S.panel = null; render(); }).catch((e) => toast(e.message)) },
        avatar({ id: d.id, name: d.name }, 'md'),
        h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, d.name), h('div', { class: 'preview ellipsis' }, 'Only that device and this one can read it')),
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

function startNewGroup() {
  ng = { step: 1, members: new Set(), name: null, photo: null, photoUrl: null };
  openPanel('new-group');
}

function newGroupPanel() {
  if (!ng) ng = { step: 1, members: new Set(), name: null, photo: null, photoUrl: null };
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
            ng.photo = await resizePhoto(file);
            if (ng.photoUrl) URL.revokeObjectURL(ng.photoUrl);
            ng.photoUrl = URL.createObjectURL(ng.photo);
            render();
          }),
        }, ng.photoUrl ? avatar({ id: 'new', name: '', src: ng.photoUrl }, 'lg') : h('div', { class: 'avatar lg placeholder' }, icon('camera'), h('span', null, 'Add group icon')))),
        h('label', { class: 'field' }, ng.name),
        h('div', { class: 'muted' }, `${ng.members.size} member${ng.members.size === 1 ? '' : 's'} besides you: ${[...ng.members].map(A.nameOf).join(', ') || 'none yet'}`),
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
    const { chat } = await api.post('/api/chats/group', { name, members: [...ng.members], avatar: avatarId });
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
    settingsRow('chat', 'Chats', 'Theme, enter to send', () => openPanel('chat-settings')),
    settingsRow('bell', 'Notifications', S.prefs.notifications ? 'On' : 'Off', () => openPanel('notifications')),
    settingsRow('devices', 'Linked devices', null, () => openPanel('devices')),
    settingsRow('shield', 'Security', 'How Tailchat protects your messages', () => openPanel('help')),
    settingsRow('exit', 'Log out', null, logout, true),
  ], null);
}

async function changeProfilePhoto(file) {
  const blob = await resizePhoto(file);
  const { id } = await api.upload(blob, { isPublic: true });
  await api.patch('/api/me', { avatar: id });
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
    h('div', { class: 'card center' }, (photoBtn = h('button', {
      type: 'button',
      class: 'avatar-btn',
      title: 'Change profile photo',
      onclick: () => menu(photoBtn, [
        { label: 'Upload photo', icon: 'image', onClick: () => pickImage((f) => changeProfilePhoto(f).catch((e) => toast(e.message))) },
        S.me.avatar && S.me.avatar.startsWith('/api/avatars/') ? { label: 'Remove photo', icon: 'delete', onClick: () => api.patch('/api/me', { avatar: null }).catch((e) => toast(e.message)) } : null,
      ]),
    }, avatar(S.me, 'lg')))),
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
  const theme = (value, label) => h('label', { class: 'radio-row pad' }, h('input', { type: 'radio', name: 'theme', checked: S.prefs.theme === value, onchange: () => A.savePrefs({ theme: value }) }), label);
  return panelShell('Chats', [
    h('div', { class: 'list-section' }, 'Theme'),
    theme('system', 'System default'),
    theme('light', 'Light'),
    theme('dark', 'Dark'),
    h('div', { class: 'list-section' }, 'Keyboard'),
    h('div', { class: 'menu-row' }, icon('send'), h('div', { class: 'grow' }, h('div', null, 'Enter is send'), h('div', { class: 'sub' }, 'Shift+Enter adds a new line')), toggle(S.prefs.enterToSend, (on) => A.savePrefs({ enterToSend: on }), 'Enter is send')),
  ], 'settings');
}

function notificationsPanel() {
  const supported = 'Notification' in window;
  return panelShell('Notifications', [
    h('div', { class: 'menu-row' }, icon('bell'), h('div', { class: 'grow' }, h('div', null, 'Desktop notifications'), h('div', { class: 'sub' }, !supported ? "This browser can't show notifications" : Notification.permission === 'denied' ? 'Blocked in your browser settings' : 'Show new messages and calls while Tailchat is in the background')), supported ? toggle(S.prefs.notifications && Notification.permission === 'granted', (on) => (on ? enableNotifications() : A.savePrefs({ notifications: false })), 'Desktop notifications') : null),
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
        const input = h('input', { type: 'file', multiple: true, class: 'hidden' });
        input.addEventListener('change', () => {
          files = [...input.files].filter((f) => !O.fileTooBig(f));
          fileLine.textContent = files.map((f) => f.name).join(', ');
          input.remove();
        });
        document.body.append(input);
        input.click();
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
  }
  let nodes = S.panel ? panelNodes() : null;
  if (!nodes) {
    let body;
    if (S.view === 'status') body = updatesTab();
    else if (S.view === 'communities') body = communitiesTab();
    else if (S.view === 'calls') body = callsTab();
    else body = chatsTab();
    nodes = [topbar(), tabs(), body];
  }
  reconcile(sidebarEl, nodes);
}

// ---------- shell ----------

function welcome() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '96');
  svg.setAttribute('height', '96');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/icon.svg#mark');
  svg.append(use);
  return h(
    'div',
    { class: 'welcome' },
    svg,
    h('h1', null, 'Tailchat'),
    h('p', null, 'Message, call and share files with people on your tailnet.'),
    h('p', null, 'Open Tailchat on your other devices to use it there too.'),
    h('div', { class: 'lock' }, icon('lock'), 'Your personal messages are end-to-end encrypted'),
  );
}

function update() {
  const chat = S.active ? S.chats.get(S.active) : null;
  if (S.active && !chat) S.active = null;
  root.classList.toggle('chat-open', !!chat);
  renderSidebar();
  reconcile(mainEl, [chat ? convEl : welcomeEl, chat && S.details ? detailsEl : null]);
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
  sidebarEl = h('aside', { class: 'sidebar' });
  mainEl = h('section', { class: 'main' });
  convEl = h('div', { class: 'conversation' });
  detailsEl = h('aside', { class: 'details' });
  welcomeEl = welcome();
  root.replaceChildren(sidebarEl, mainEl);
  A.onRender(update);
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
