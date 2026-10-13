// Right-hand panel: contact and group info, shared media, starred
// messages and message search for the open chat.
import * as A from './app.js';
import { S, api, render } from './app.js';
import { h, icon, iconButton, avatar, toast, menu, dialog, promptDialog, confirmDialog, listTime, dayLabel, timeOf, fileSize, disappearingLabel, lastSeenText, richText, reconcile, Slots, toggle } from './ui.js';
import { extensionOf, resizePhoto } from './media.js';
import * as O from './overlays.js';
import { jumpTo, clearChat, deleteChat, exitGroup, blockUser } from './conversation.js';

const slots = new Slots();
let mediaTab = 'media';
let searchInput = null;

function panelHeader(title, back) {
  return h('header', { class: 'topbar' }, iconButton(back ? 'back' : 'close', back ? 'Back' : 'Close', () => { S.details = back || null; render(); }), h('div', { class: 'title' }, h('div', { class: 'name' }, title)));
}

function menuRow(iconName, label, sub, onClick, { danger = false, right = null } = {}) {
  return h('button', { type: 'button', class: `menu-row${danger ? ' danger' : ''}`, onclick: onClick }, icon(iconName), h('div', { class: 'grow' }, h('div', { class: danger ? 'danger' : '' }, label), sub ? h('div', { class: 'sub' }, sub) : null), right);
}

function canEditInfo(chat) {
  return chat.type === 'group' && !chat.me.left && (!chat.adminsOnlyEdit || chat.me.role === 'admin');
}

function mediaMessages(chat) {
  const media = [];
  const docs = [];
  const links = [];
  for (const m of A.box(chat.id).list) {
    if (m.viewOnce) continue;
    const c = A.contentOf(m)?.ok;
    if (!c) continue;
    if (c.type === 'media') {
      if (['image', 'video', 'gif'].includes(c.kind)) media.push({ m, c });
      else if (c.kind === 'document' || c.kind === 'audio') docs.push({ m, c });
    }
    const text = c.type === 'text' ? c.text : c.caption;
    if (typeof text === 'string') for (const url of text.match(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g) || []) links.push({ m, url });
  }
  return { media: media.reverse(), docs: docs.reverse(), links: links.reverse() };
}

function mediaCell({ m, c }) {
  const fs = c.file?.id ? S.files.get(c.file.id) : null;
  const src = (c.kind !== 'video' && fs?.url) || O.safeThumb(c.thumb);
  return h('button', { type: 'button', class: 'cell', onclick: () => O.openMedia(m, c) }, src ? h('img', { src, alt: '' }) : icon(c.kind === 'video' ? 'video' : 'image'));
}

async function changeGroupPhoto(chat) {
  const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const blob = await resizePhoto(file);
      const { id } = await api.upload(blob, { isPublic: true });
      await api.patch(`/api/chats/${encodeURIComponent(chat.id)}`, { avatar: id });
    } catch (err) {
      toast(err.message);
    }
  });
  document.body.append(input);
  input.click();
}

function groupPhotoMenu(chat, anchor) {
  menu(anchor, [
    { label: 'Upload photo', icon: 'image', onClick: () => changeGroupPhoto(chat) },
    chat.avatar ? { label: 'Remove photo', icon: 'delete', onClick: () => api.patch(`/api/chats/${encodeURIComponent(chat.id)}`, { avatar: null }).catch((e) => toast(e.message)) } : null,
  ]);
}

async function editGroupField(chat, field) {
  const isName = field === 'name';
  const value = await promptDialog(isName ? 'Group name' : 'Group description', {
    value: (isName ? chat.name : chat.description) || '',
    max: isName ? 100 : 2048,
    multiline: !isName,
    okLabel: 'Save',
  });
  if (value === null) return;
  if (isName && !value.trim()) return toast("Group name can't be empty");
  try {
    await api.patch(`/api/chats/${encodeURIComponent(chat.id)}`, { [field]: isName ? value.trim() : value });
  } catch (err) {
    toast(err.message);
  }
}

function groupSettingsDialog(chat) {
  const patch = (body) => api.patch(`/api/chats/${encodeURIComponent(chat.id)}`, body).catch((e) => toast(e.message));
  dialog({
    title: 'Group settings',
    content: [
      h('div', { class: 'check-row' }, h('div', { class: 'grow' }, h('div', null, 'Only admins can edit group info'), h('div', { class: 'muted' }, 'Name, photo, description, disappearing messages and pins')), toggle(chat.adminsOnlyEdit, (v) => patch({ adminsOnlyEdit: v }), 'Only admins edit info')),
      h('div', { class: 'check-row' }, h('div', { class: 'grow' }, h('div', null, 'Only admins can send messages'), h('div', { class: 'muted' }, 'Turns the group into an announcement group')), toggle(chat.adminsOnlySend, (v) => patch({ adminsOnlySend: v }), 'Only admins send')),
    ],
    actions: [{ label: 'Done', kind: 'primary', onClick: (close) => close() }],
  });
}

async function inviteDialog(chat) {
  let code = chat.inviteCode;
  try {
    if (!code) ({ code } = await api.post(`/api/chats/${encodeURIComponent(chat.id)}/invite`));
  } catch (err) {
    toast(err.message);
    return;
  }
  const link = () => `${location.origin}/invite/${code}`;
  const text = h('div', { class: 'invite-link' }, link());
  dialog({
    title: 'Invite to group via link',
    content: [
      h('p', { class: 'muted' }, 'Anyone on your tailnet who opens this link can join the group. People outside your tailnet cannot reach it. Only share it with people you trust.'),
      text,
    ],
    actions: [
      {
        label: 'Reset link',
        onClick: async () => {
          if (!(await confirmDialog('Reset this link?', 'The current link will stop working.', 'Reset link', 'danger'))) return;
          try {
            await api.del(`/api/chats/${encodeURIComponent(chat.id)}/invite`);
            ({ code } = await api.post(`/api/chats/${encodeURIComponent(chat.id)}/invite`));
            text.textContent = link();
            toast('Invite link reset');
          } catch (err) {
            toast(err.message);
          }
        },
      },
      { label: 'Copy link', kind: 'primary', onClick: () => navigator.clipboard.writeText(link()).then(() => toast('Link copied')) },
    ],
  });
}

function memberMenu(chat, member, anchor) {
  const u = S.users.get(member.userId) || { id: member.userId, name: A.nameOf(member.userId) };
  const admin = chat.me.role === 'admin' && !chat.me.left;
  const post = (path, body) => api.post(path, body).catch((e) => toast(e.message));
  menu(anchor, [
    { label: `Message ${u.name}`, icon: 'chat', onClick: () => A.openDirect(u.id).catch((e) => toast(e.message)) },
    admin ? { label: member.role === 'admin' ? 'Dismiss as admin' : 'Make group admin', icon: 'shield', onClick: () => post(`/api/chats/${encodeURIComponent(chat.id)}/admins`, { userId: u.id, admin: member.role !== 'admin' }) } : null,
    admin ? {
      label: `Remove ${u.name}`,
      icon: 'exit',
      danger: true,
      onClick: async () => {
        if (!(await confirmDialog(`Remove ${u.name} from "${chat.name}"?`, 'They will keep the messages they already received.', 'Remove', 'danger'))) return;
        api.del(`/api/chats/${encodeURIComponent(chat.id)}/members/${encodeURIComponent(u.id)}`).catch((e) => toast(e.message));
      },
    } : null,
  ]);
}

async function addMembers(chat) {
  const ids = await O.pickUsers({ title: 'Add members', exclude: chat.members.filter((m) => !m.left).map((m) => m.userId), okLabel: 'Add' });
  if (!ids?.length) return;
  try {
    await api.post(`/api/chats/${encodeURIComponent(chat.id)}/members`, { userIds: ids });
  } catch (err) {
    toast(err.message);
  }
}

function sharedSection(chat) {
  const { media, docs, links } = mediaMessages(chat);
  const count = media.length + docs.length + links.length;
  return h(
    'div',
    { class: 'card flush' },
    menuRow('image', 'Media, links and docs', count ? String(count) : 'None', () => { S.details = 'media'; render(); }),
    media.length ? h('div', { class: 'media-grid pad' }, media.slice(0, 3).map(mediaCell)) : null,
  );
}

function settingsSection(chat) {
  const muted = chat.me.mutedUntil > Date.now();
  return h(
    'div',
    { class: 'card flush' },
    menuRow('star', 'Starred messages', null, () => { S.details = 'starred'; render(); }),
    menuRow('mute', 'Mute notifications', muted ? (chat.me.mutedUntil > Date.now() + 365 * 86400_000 ? 'Always' : `Until ${dayLabel(chat.me.mutedUntil)} ${timeOf(chat.me.mutedUntil)}`) : null, () => {}, {
      right: toggle(muted, (on) => (on ? O.muteDialog(chat) : api.patch(`/api/chats/${encodeURIComponent(chat.id)}/prefs`, { mutedUntil: 0 }).catch((e) => toast(e.message))), 'Mute'),
    }),
    !chat.me.left ? menuRow('timer', 'Disappearing messages', disappearingLabel(chat.disappearing), () => {
      if (chat.type === 'group' && chat.adminsOnlyEdit && chat.me.role !== 'admin') toast('Only admins can change this');
      else O.disappearingDialog(chat);
    }) : null,
    chat.type === 'group' && chat.me.role === 'admin' && !chat.me.left ? menuRow('settings', 'Group settings', null, () => groupSettingsDialog(chat)) : null,
    menuRow('lock', 'Encryption', 'Messages and calls are end-to-end encrypted. Click to verify.', () => O.securityCodeDialog(chat)),
  );
}

function directInfo(chat) {
  const uid = A.otherMember(chat);
  const self = A.isMe(uid);
  const u = self ? S.me : S.users.get(uid) || { id: uid, name: A.nameOf(uid) };
  const groups = [...S.chats.values()].filter((c) => c.type === 'group' && c.members.some((m) => !m.left && m.userId === uid) && !c.me.left);
  return [
    panelHeader('Contact info'),
    h(
      'div',
      { class: 'scroll' },
      h(
        'div',
        { class: 'card center' },
        avatar(u, 'lg'),
        h('h2', null, u.name),
        h('h3', null, u.id),
        !self ? h('div', { class: 'muted' }, lastSeenText(u)) : null,
        !self && !chat.me.left ? h(
          'div',
          { class: 'card-actions' },
          h('button', { type: 'button', onclick: () => O.startCall(chat, false) }, icon('phone'), 'Audio'),
          h('button', { type: 'button', onclick: () => O.startCall(chat, true) }, icon('video'), 'Video'),
          h('button', { type: 'button', onclick: () => { S.details = 'search'; render(); } }, icon('search'), 'Search'),
        ) : null,
      ),
      u.about ? h('div', { class: 'card' }, h('h3', null, 'About'), h('div', { class: 'about' }, u.about)) : null,
      sharedSection(chat),
      settingsSection(chat),
      groups.length ? h(
        'div',
        { class: 'card flush' },
        h('div', { class: 'list-section' }, `${groups.length} group${groups.length === 1 ? '' : 's'} in common`),
        groups.map((g) => h('div', { class: 'row', onclick: () => A.openChat(g.id) }, avatar(A.chatAvatar(g)), h('div', { class: 'body' }, h('div', { class: 'name ellipsis' }, g.name), h('div', { class: 'preview ellipsis' }, g.members.filter((m) => !m.left).map((m) => A.nameOf(m.userId)).join(', '))))),
      ) : null,
      h(
        'div',
        { class: 'card flush' },
        !self ? menuRow('block', u.blocked ? `Unblock ${u.name}` : `Block ${u.name}`, null, () => blockUser(u), { danger: !u.blocked }) : null,
        menuRow('delete', 'Clear chat', null, () => clearChat(chat)),
        menuRow('delete', 'Delete chat', null, () => deleteChat(chat), { danger: true }),
      ),
    ),
  ];
}

function groupInfo(chat) {
  const members = chat.members.filter((m) => !m.left);
  const editable = canEditInfo(chat);
  const admin = chat.me.role === 'admin' && !chat.me.left;
  members.sort((a, b) => (A.isMe(b.userId) - A.isMe(a.userId)) || ((b.role === 'admin') - (a.role === 'admin')) || A.nameOf(a.userId).localeCompare(A.nameOf(b.userId)));
  let photoBtn;
  return [
    panelHeader('Group info'),
    h(
      'div',
      { class: 'scroll' },
      h(
        'div',
        { class: 'card center' },
        (photoBtn = h('button', { type: 'button', class: 'avatar-btn', disabled: !editable, title: editable ? 'Change group photo' : '', onclick: () => groupPhotoMenu(chat, photoBtn) }, avatar(A.chatAvatar(chat), 'lg'))),
        h('h2', { class: editable ? 'editable' : '', onclick: editable ? () => editGroupField(chat, 'name') : null }, chat.name, editable ? icon('edit') : null),
        h('h3', null, `Group · ${members.length} member${members.length === 1 ? '' : 's'}`),
        !chat.me.left ? h(
          'div',
          { class: 'card-actions' },
          h('button', { type: 'button', onclick: () => O.startCall(chat, false) }, icon('phone'), 'Audio'),
          h('button', { type: 'button', onclick: () => O.startCall(chat, true) }, icon('video'), 'Video'),
          admin ? h('button', { type: 'button', onclick: () => addMembers(chat) }, icon('add'), 'Add') : null,
          h('button', { type: 'button', onclick: () => { S.details = 'search'; render(); } }, icon('search'), 'Search'),
        ) : null,
      ),
      h(
        'div',
        { class: `card${editable ? ' editable' : ''}`, onclick: editable ? () => editGroupField(chat, 'description') : null },
        chat.description ? h('div', { class: 'about' }, richText(chat.description)) : h('div', { class: editable ? 'link' : 'muted' }, editable ? 'Add group description' : 'No description'),
        h('div', { class: 'muted small' }, `Created by ${A.nameOf(chat.createdBy)}, ${dayLabel(chat.createdAt).toLowerCase()} at ${timeOf(chat.createdAt)}`),
      ),
      sharedSection(chat),
      settingsSection(chat),
      h(
        'div',
        { class: 'card flush' },
        h('div', { class: 'list-section' }, `${members.length} member${members.length === 1 ? '' : 's'}`),
        admin ? menuRow('add', 'Add members', null, () => addMembers(chat)) : null,
        admin ? menuRow('link', 'Invite to group via link', null, () => inviteDialog(chat)) : null,
        members.map((m) => {
          const u = S.users.get(m.userId) || { id: m.userId, name: A.nameOf(m.userId) };
          const me = A.isMe(m.userId);
          let row;
          return (row = h(
            'div',
            { class: 'row', onclick: me ? null : () => memberMenu(chat, m, row) },
            avatar(u),
            h('div', { class: 'body' }, h('div', { class: 'line' }, h('div', { class: 'name ellipsis grow' }, me ? 'You' : u.name), m.role === 'admin' ? h('span', { class: 'tag' }, 'Group admin') : null), h('div', { class: 'preview ellipsis' }, u.about || u.id)),
          ));
        }),
      ),
      h(
        'div',
        { class: 'card flush' },
        menuRow('delete', 'Clear chat', null, () => clearChat(chat)),
        !chat.me.left ? menuRow('exit', 'Exit group', null, () => exitGroup(chat), { danger: true }) : menuRow('delete', 'Delete group', null, () => deleteChat(chat), { danger: true }),
      ),
    ),
  ];
}

function mediaPanel(chat) {
  const { media, docs, links } = mediaMessages(chat);
  const b = A.box(chat.id);
  const tab = (key, label) => h('button', { type: 'button', class: `tab${mediaTab === key ? ' active' : ''}`, onclick: () => { mediaTab = key; render(); } }, label);
  let body;
  if (mediaTab === 'media') body = media.length ? h('div', { class: 'media-grid card' }, media.map(mediaCell)) : h('p', { class: 'empty' }, 'No media');
  else if (mediaTab === 'docs') {
    body = docs.length
      ? docs.map(({ m, c }) => h(
        'button',
        { type: 'button', class: 'menu-row', onclick: () => O.downloadFile(c.file) },
        h('div', { class: 'doc-icon' }, extensionOf(c.file?.name).slice(0, 4)),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, O.str(c.file?.name, 200) || 'File'), h('div', { class: 'sub' }, `${fileSize(O.num(c.file?.size) || 0)} · ${listTime(m.createdAt)}`)),
      ))
      : h('p', { class: 'empty' }, 'No documents');
  } else {
    body = links.length
      ? links.map(({ m, url }) => h('div', { class: 'menu-row' }, icon('link'), h('div', { class: 'grow' }, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'ellipsis block' }, url), h('button', { type: 'button', class: 'sub link', onclick: () => jumpTo(chat.id, m.id) }, `${A.nameOf(m.senderId)} · ${listTime(m.createdAt)}`))))
      : h('p', { class: 'empty' }, 'No links');
  }
  return [
    panelHeader('Media, links and docs', 'info'),
    h('div', { class: 'tabs' }, tab('media', 'Media'), tab('docs', 'Docs'), tab('links', 'Links')),
    h(
      'div',
      { class: 'scroll' },
      body,
      b.hasMore ? h('button', { type: 'button', class: 'btn plain center-btn', onclick: () => loadAll(chat.id) }, b.loading ? 'Loading…' : 'Look in older messages') : null,
    ),
  ];
}

async function loadAll(chatId) {
  const b = A.box(chatId);
  for (let i = 0; i < 100 && b.hasMore; i++) await A.loadMessages(chatId, { older: true });
}

function starredPanel(chat) {
  if (S.starred === null) {
    S.starred = [];
    A.loadStarred().catch((e) => toast(e.message));
  }
  const list = (S.starred || []).filter((m) => m.chatId === chat.id);
  return [
    panelHeader('Starred messages', 'info'),
    h('div', { class: 'scroll' }, list.length ? list.map((m) => starredRow(m)) : h('p', { class: 'empty' }, 'Star messages to find them here later. Right-click a message and choose Star.')),
  ];
}

export function starredRow(m) {
  const chat = S.chats.get(m.chatId);
  return h(
    'div',
    { class: 'row tall', onclick: () => jumpTo(m.chatId, m.id) },
    avatar(S.users.get(m.senderId) || { id: m.senderId, name: A.nameOf(m.senderId) }, 'sm'),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'line' }, h('div', { class: 'grow ellipsis small' }, `${A.nameOf(m.senderId)}${chat?.type === 'group' ? ` ▸ ${chat.name}` : ''}`), h('span', { class: 'time' }, listTime(m.createdAt))),
      h('div', { class: 'preview ellipsis' }, A.previewText(m)),
    ),
  );
}

function searchPanel(chat) {
  if (!searchInput) {
    searchInput = h('input', { type: 'search', placeholder: 'Search messages', 'aria-label': 'Search messages' });
    searchInput.addEventListener('input', () => {
      S.chatSearch = searchInput.value;
      render();
    });
    setTimeout(() => searchInput.focus(), 0);
  }
  if (searchInput.value !== S.chatSearch) searchInput.value = S.chatSearch;
  const q = S.chatSearch.trim().toLowerCase();
  const b = A.box(chat.id);
  const hits = [];
  if (q) {
    for (const m of b.list) {
      const c = A.contentOf(m)?.ok;
      if (!c || m.kind !== 'msg') continue;
      const text = [c.text, c.caption, c.file?.name, c.question, c.name].filter((x) => typeof x === 'string').join(' ');
      if (text.toLowerCase().includes(q)) hits.push({ m, text });
    }
    hits.reverse();
  }
  return [
    panelHeader('Search messages'),
    h('div', { class: 'search' }, icon('search'), searchInput),
    h(
      'div',
      { class: 'scroll' },
      !q ? h('p', { class: 'empty' }, `Search for messages in this chat. Messages are decrypted on this device, so only messages loaded here can be searched.`) : null,
      q && !hits.length ? h('p', { class: 'empty' }, 'No messages found') : null,
      hits.slice(0, 200).map(({ m, text }) => h(
        'div',
        { class: 'row tall', onclick: () => jumpTo(chat.id, m.id) },
        h(
          'div',
          { class: 'body' },
          h('div', { class: 'line' }, h('div', { class: 'grow ellipsis small muted' }, A.nameOf(m.senderId)), h('span', { class: 'time' }, listTime(m.createdAt))),
          h('div', { class: 'preview ellipsis' }, richText(text.slice(0, 300), { highlight: q })),
        ),
      )),
      q && b.hasMore ? h('button', { type: 'button', class: 'btn plain center-btn', onclick: () => loadAll(chat.id) }, b.loading ? 'Loading…' : 'Search older messages') : null,
    ),
  ];
}

export function renderDetails(el, chat) {
  if (S.details !== 'search') searchInput = null;
  let nodes;
  switch (S.details) {
    case 'media':
      nodes = mediaPanel(chat);
      break;
    case 'starred':
      nodes = starredPanel(chat);
      break;
    case 'search':
      nodes = searchPanel(chat);
      break;
    default:
      nodes = slots.get(
        'info',
        JSON.stringify([chat, chat.type === 'direct' ? S.users.get(A.otherMember(chat)) : chat.members.map((m) => S.users.get(m.userId)), A.box(chat.id).list.length, [...S.files.keys()].length]),
        () => (chat.type === 'group' ? groupInfo(chat) : directInfo(chat)),
      );
  }
  reconcile(el, nodes);
}
