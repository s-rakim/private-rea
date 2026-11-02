// The call screens: a call ringing here, the call itself, the call made
// small while you chat, and picture-in-picture. calls.js makes the calls;
// this module draws them.
import { S, calls, render, sendText, openChat, callableDevices, isOwnChat, callPeerName as peerName, callPeerAvatar as peerAvatar, callParty as party, ringInfo, callView } from './app.js';
import { h, icon, avatar, toast, reconcile, duration, colorFor, Slots } from './ui.js';
import { END_TEXT } from './calls.js';
import { QUALITIES, REACTIONS, SPEAKING, resolutionLabel } from './rtc.js';
import * as native from './native.js';

const layer = () => document.getElementById('layer');

const ui = {
  slots: new Slots(), // built parts, kept while they look the same
  root: null, // the call screen
  part: {}, // its fixed parts
  callId: null,
  videos: new Map(), // key -> <video>
  audios: new Map(), // deviceId -> <audio>
  audioBox: null,
  levels: new Map(), // level key -> Set of elements that show it
  ring: null, // the incoming call screen
  mini: null, // the minimised call
  minimized: false,
  sheet: null, // null | 'more' | 'quality' | 'devices' | 'info'
  idle: false,
  idleTimer: null,
  corner: 'br',
  swap: false, // your own video big, theirs small
  fit: null, // 'cover' | 'contain', chosen by double tap
  pip: null, // { kind: 'doc' | 'video', win?, video?, stop? }
  nativePip: false,
  clock: null,
  mutedTalk: 0,
  hint: null,
  wasIdle: false,
};

// A part of the screen that is rebuilt only when what it shows changes, so
// a button doesn't vanish under your finger and a video doesn't flicker.
const slot = (key, sig, build) => ui.slots.get(key, sig, build);

function statusText(call) {
  switch (call.status) {
    case 'starting': return 'Starting…';
    case 'calling': return call.unreachable ? 'Calling… waiting for the other device' : 'Calling…';
    case 'ringing': return 'Ringing…';
    case 'connecting': return 'Connecting…';
    case 'reconnecting': return 'Reconnecting…';
    default: return clock(call);
  }
}

const clock = (call) => duration((Date.now() - (call.startedAt || Date.now())) / 1000);

function tint(el, id) {
  el.style.setProperty('--tint', colorFor(id || ''));
  return el;
}

// ---------- entry points ----------

export function renderCalls() {
  if (!calls) return;
  renderRinging();
  renderCall();
}

export async function startCall(chat, video) {
  if (!chat) return;
  if (isOwnChat(chat) && !callableDevices().length) {
    toast('Open Tailchat on another of your devices first, then you can call it');
    return;
  }
  try {
    await calls.start(chat.id, video);
  } catch (err) {
    toast(err.message);
  }
}

export const minimizeCall = () => {
  ui.minimized = true;
  ui.sheet = null;
  render();
};

export const expandCall = () => {
  ui.minimized = false;
  render();
};

// Called from calls.js ten times a second with everyone's voice level.
export function showLevels(levels) {
  for (const [key, els] of ui.levels) {
    const level = levels.get(key) || 0;
    for (const el of els) {
      el.style.setProperty('--level', level.toFixed(3));
      el.classList.toggle('speaking', level > SPEAKING);
    }
  }
  // Talking while muted: say so.
  const call = calls?.call;
  if (call?.muted && (levels.get('self') || 0) > SPEAKING + 0.08) {
    if (++ui.mutedTalk === 12) flash("You're muted", 3000);
  } else ui.mutedTalk = 0;
}

export function showReaction(peer, emoji) {
  const box = ui.part.reacts;
  if (!box) return;
  const who = peer ? peerName(peer) : 'You';
  const el = h('div', { class: 'callx-react' }, h('span', { class: 'emoji' }, emoji), h('span', { class: 'who' }, who));
  el.style.setProperty('--x', `${10 + Math.random() * 70}%`);
  el.style.setProperty('--drift', `${Math.round(Math.random() * 60 - 30)}px`);
  box.append(el);
  setTimeout(() => el.remove(), 3200);
}

callView.levels = showLevels;
callView.reaction = showReaction;

// ---------- a call ringing here ----------

function renderRinging() {
  const rings = [...calls.incoming.values()];
  // In a call, a new one shows as a card on the call screen instead.
  const ring = calls.call ? null : rings[rings.length - 1];
  if (!ring) {
    ui.ring?.remove();
    ui.ring = null;
    return;
  }
  if (ui.ring?.dataset.callId === ring.callId) return;
  ui.ring?.remove();
  ui.ring = ringScreen(ring);
  layer().append(ui.ring);
  ui.ring.querySelector('.answer')?.focus({ preventScroll: true });
}

function ringScreen(ring) {
  const who = ringInfo(ring);
  const chat = S.chats.get(ring.chatId);
  const accept = (video) => calls.accept(ring.callId, { video }).catch((e) => toast(e.message));
  const replies = !who.own && chat && !chat.me?.left ? ["Can't talk now", "I'll call you back", 'On my way'] : [];
  const reply = (text) => {
    calls.decline(ring.callId);
    sendText(ring.chatId, text).catch((e) => toast(e.message));
  };
  const el = tint(h(
    'div',
    { class: 'ringx', role: 'alertdialog', 'aria-label': `${who.sub} from ${who.title}`, dataset: { callId: ring.callId } },
    h('div', { class: 'ringx-glow' }),
    h(
      'div',
      { class: 'ringx-card' },
      h('div', { class: 'ringx-brand' }, icon('lock'), 'Tailchat · end-to-end encrypted'),
      h('div', { class: 'ringx-who' },
        h('div', { class: 'pulse' }, h('span'), h('span'), h('span'), avatar(who.av, 'xl')),
        h('div', { class: 'ringx-name' }, who.title),
        h('div', { class: 'ringx-sub' }, icon(ring.video ? 'video' : 'phone'), who.sub)),
      replies.length ? h('div', { class: 'ringx-replies' }, replies.map((t) => h('button', { type: 'button', onclick: () => reply(t) }, icon('chat'), t))) : null,
      h(
        'div',
        { class: 'ringx-actions' },
        actionButton('hangup', 'Decline', 'decline', () => calls.decline(ring.callId)),
        ring.video ? actionButton('phone', 'Voice only', 'answer alt', () => accept(false)) : null,
        actionButton(ring.video ? 'video' : 'phone', ring.ongoing ? 'Join' : 'Answer', 'answer', () => accept(ring.video)),
      ),
    ),
  ), who.caller.id);
  return el;
}

function actionButton(name, label, cls, onClick) {
  return h('div', { class: `ringx-btn ${cls}` },
    h('button', { type: 'button', class: cls, 'aria-label': label, onclick: onClick }, icon(name)),
    h('span', null, label));
}

// ---------- the call ----------

function renderCall() {
  const call = calls.call;
  const ended = !call ? calls.ended : null;
  if (!call && !ended) {
    teardown();
    return;
  }
  if (!ui.root) build();
  if (call && ui.callId !== call.callId) {
    ui.callId = call.callId;
    ui.minimized = false;
    ui.swap = false;
    ui.sheet = null;
    ui.fit = null;
    poke();
  }
  if (!call) {
    renderEnded(ended);
    return;
  }
  ui.root.classList.remove('ended');
  reconcile(ui.part.ended, []);
  const peers = [...call.peers.values()];
  const who = party(call.chatId, peers);
  const sharer = peers.find((p) => p.sharing) || null;
  const remoteVideo = peers.length === 1 ? peers[0].video : null;
  const mode = sharer ? 'screen' : peers.length > 1 ? 'group' : remoteVideo || call.cam ? 'video' : 'voice';
  const r = ui.root;
  r.dataset.mode = mode;
  r.classList.toggle('minimized', ui.minimized);
  r.classList.toggle('sheet-open', !!ui.sheet);
  r.classList.toggle('in-pip', !!ui.pip && ui.pip.kind === 'doc' || ui.nativePip);
  r.classList.toggle('idle', ui.idle && mode !== 'voice' && !ui.sheet && call.status === 'active');
  tint(r, who.av.id);
  ui.levels.clear();

  // Their audio, through hidden <audio> elements that stay put whatever
  // the screen does.
  renderAudio(call, peers);

  // The stage: who you see.
  let main = null;
  let hero = null;
  let self = null;
  if (mode === 'screen') {
    main = stageVideo(`${sharer.deviceId}:screen`, sharer.screen, { fit: 'contain' });
  } else if (mode === 'group') {
    main = groupGrid(call, peers);
  } else if (mode === 'video') {
    if (remoteVideo && !ui.swap) {
      main = stageVideo(`${peers[0].deviceId}:cam`, peers[0].stream, { fit: ui.fit, badge: peers[0].remote.muted ? slot('main-muted', '', () => h('div', { class: 'badge' }, icon('micOff'), 'Muted')) : null });
      self = call.cam ? selfView(call) : null;
    } else if (call.cam) {
      main = stageVideo('self', call.preview, { mirror: call.facing === 'user', fit: 'cover', self: true });
      if (remoteVideo) self = selfView(call, peers[0]);
      else hero = heroBlock(call, who, peers);
    } else {
      hero = heroBlock(call, who, peers);
    }
  } else {
    hero = heroBlock(call, who, peers);
  }
  if (mode === 'screen' || mode === 'group') self = call.cam ? selfView(call) : null;

  reconcile(ui.part.stage, [main, hero]);
  reconcile(ui.part.selfBox, [self]);
  ui.part.selfBox.dataset.corner = ui.corner;
  reconcile(ui.part.strip, mode === 'screen' ? strip(call, peers) : []);
  ambient(mode === 'video' && remoteVideo && !ui.swap ? peers[0].stream : mode === 'screen' ? sharer.screen : null);

  // Top: minimise, who and how long, quality.
  ui.part.title.textContent = who.title;
  ui.part.status.textContent = statusText(call);
  ui.part.status.classList.toggle('live', call.status === 'active');
  reconcile(ui.part.badges, [qualityChip(call, peers), canInvite(call) ? glassButton('personAdd', 'Add people', () => invite()) : null]);

  // Hints over the stage.
  const hints = [];
  if (call.status === 'reconnecting') hints.push(h('div', { class: 'callx-hint warn' }, 'Reconnecting…'));
  else if (call.grade === 'poor' && call.status === 'active') hints.push(h('div', { class: 'callx-hint warn' }, 'Poor connection'));
  if (call.sharing) hints.push(h('div', { class: 'callx-hint' }, icon('screen'), "You're sharing your screen", h('button', { type: 'button', onclick: () => calls.stopScreen() }, 'Stop')));
  if (ui.hint) hints.push(h('div', { class: 'callx-hint' }, ui.hint));
  reconcile(ui.part.hints, hints);

  reconcile(ui.part.dock, dock(call));
  const sheetSig = ui.sheet ? JSON.stringify([ui.sheet, call.quality, call.hdAudio, call.audioMode, call.sharing, !!call.cam, call.micId, call.camId, call.outputId, calls.devices, call.peers.size, ui.sheet === 'info' ? peers.map((p) => [p.stats?.counters?.size, p.grade, p.state, Date.now() >> 11]) : 0, !!document.fullscreenElement]) : '';
  reconcile(ui.part.sheet, ui.sheet ? slot('sheet', sheetSig, () => sheet(call, peers)) : []);
  ui.part.sheet.classList.toggle('open', !!ui.sheet);
  reconcile(ui.part.waiting, waitingCards());

  renderMini(call, who, peers, remoteVideo);
  startClock();
  setMediaSession(call);
}

function build() {
  const p = ui.part;
  p.ambientBox = h('div', { class: 'callx-ambient' });
  p.stage = h('div', { class: 'callx-stage', onclick: (e) => stageTap(e), ondblclick: (e) => stageDouble(e) });
  p.strip = h('div', { class: 'callx-strip' });
  p.selfBox = h('div', { class: 'callx-selfbox' });
  p.title = h('div', { class: 'callx-title ellipsis' });
  p.status = h('div', { class: 'callx-status' });
  p.badges = h('div', { class: 'callx-badges' });
  p.hints = h('div', { class: 'callx-hints' });
  p.reacts = h('div', { class: 'callx-reacts', 'aria-hidden': 'true' });
  p.dock = h('div', { class: 'callx-dock', role: 'toolbar', 'aria-label': 'Call controls' });
  p.sheet = h('div', { class: 'callx-sheet' });
  p.waiting = h('div', { class: 'callx-waiting' });
  p.ended = h('div', { class: 'callx-ended' });
  ui.root = h(
    'div',
    { class: 'callx', role: 'dialog', 'aria-label': 'Call', onpointermove: (e) => e.pointerType === 'mouse' && poke(), onpointerdown: () => { ui.wasIdle = ui.idle; poke(); } },
    h('div', { class: 'callx-aurora' }, h('i'), h('i'), h('i')),
    p.ambientBox,
    p.stage,
    p.strip,
    p.selfBox,
    h('div', { class: 'callx-top' },
      glassButton('minimize', 'Minimise call', () => minimizeCall(), 'min'),
      h('div', { class: 'callx-island' }, h('div', { class: 'callx-lock' }, icon('lock')), h('div', { class: 'grow' }, p.title, p.status)),
      p.badges),
    p.hints,
    p.reacts,
    p.waiting,
    p.dock,
    p.sheet,
    p.ended,
  );
  ui.audioBox = h('div', { class: 'callx-audio', 'aria-hidden': 'true' });
  layer().append(ui.root, ui.audioBox);
  document.addEventListener('keydown', onKey);
}

function teardown() {
  if (!ui.root && !ui.mini) return;
  closePip();
  ui.root?.remove();
  ui.audioBox?.remove();
  ui.mini?.remove();
  for (const v of ui.videos.values()) v.srcObject = null;
  for (const a of ui.audios.values()) a.srcObject = null;
  Object.assign(ui, { root: null, part: {}, callId: null, mini: null, sheet: null, minimized: false, swap: false, hint: null });
  ui.videos.clear();
  ui.audios.clear();
  ui.levels.clear();
  ui.slots.clear();
  clearInterval(ui.clock);
  ui.clock = null;
  document.removeEventListener('keydown', onKey);
  setMediaSession(null);
}

function renderEnded(ended) {
  const who = party(ended.chatId);
  const r = ui.root;
  r.classList.add('ended');
  r.classList.remove('minimized', 'idle');
  r.dataset.mode = 'voice';
  closePip();
  ui.mini?.remove();
  ui.mini = null;
  for (const a of ui.audios.values()) a.srcObject = null;
  reconcile(ui.part.stage, []);
  reconcile(ui.part.selfBox, []);
  reconcile(ui.part.strip, []);
  reconcile(ui.part.dock, []);
  reconcile(ui.part.sheet, []);
  reconcile(ui.part.hints, []);
  reconcile(ui.part.waiting, waitingCards());
  ambient(null);
  ui.part.title.textContent = who.title;
  ui.part.status.textContent = END_TEXT[ended.reason] || 'Call ended';
  const chat = S.chats.get(ended.chatId);
  const again = ended.reason !== 'ended' && ended.reason !== 'cancelled' && chat && !chat.me?.left;
  reconcile(ui.part.ended, [
    h('div', { class: 'pulse still' }, avatar(who.av, 'xl')),
    h('div', { class: 'callx-ended-title' }, END_TEXT[ended.reason] || 'Call ended'),
    h('div', { class: 'callx-ended-sub' }, ended.seconds ? duration(ended.seconds) : who.title),
    h('div', { class: 'callx-ended-actions' },
      again ? h('button', { type: 'button', class: 'again', onclick: () => startCall(chat, ended.video) }, icon(ended.video ? 'video' : 'phone'), 'Call again') : null,
      h('button', { type: 'button', onclick: () => { calls.ended = null; render(); } }, 'Close')),
  ]);
}

// ---------- the stage ----------

function videoEl(key, stream, { mirror = false, fit = null } = {}) {
  let v = ui.videos.get(key);
  if (!v) {
    v = h('video', { autoplay: true, playsInline: true, muted: true, disablePictureInPicture: false });
    v.muted = true;
    v.addEventListener('resize', () => {
      v.dataset.portrait = v.videoHeight > v.videoWidth ? '1' : '0';
    });
    ui.videos.set(key, v);
  }
  if (v.srcObject !== stream) {
    v.srcObject = stream || null;
    if (stream) v.play().catch(() => {});
  }
  v.classList.toggle('mirror', mirror);
  if (fit) v.dataset.fit = fit;
  else delete v.dataset.fit;
  return v;
}

function stageVideo(key, stream, opts = {}) {
  const v = videoEl(key, stream, opts);
  const box = slot(`main:${key}`, opts.self ? 'self' : '', () => h('div', { class: `callx-main${opts.self ? ' self' : ''}` }));
  reconcile(box, [v, opts.badge || null]);
  return box;
}

function heroBlock(call, who, peers) {
  const ringing = call.status !== 'active' && call.status !== 'reconnecting';
  const p = peers[0];
  const av = p && !who.group ? peerAvatar(p) : who.av;
  const hero = slot('hero', `${av.id}|${av.src || ''}|${who.title}`, () => {
    const rings = h('div', { class: 'pulse' }, h('span'), h('span'), h('span'), avatar(av, 'xl'));
    const el = h('div', { class: 'callx-hero' }, rings, h('div', { class: 'callx-hero-name' }, who.title), h('div', { class: 'callx-hero-sub' }));
    el.rings = rings;
    return el;
  });
  hero.rings.classList.toggle('live', !ringing);
  if (p) watchLevel(p.deviceId, hero.rings);
  const muted = p?.remote.muted;
  const sub = muted ? 'Muted' : call.status === 'active' ? (call.cam || p?.video ? '' : call.video ? 'Camera off' : 'Voice call') : statusText(call);
  const subEl = hero.lastChild;
  if (subEl.dataset.text !== sub) {
    subEl.dataset.text = sub;
    subEl.replaceChildren(...(muted ? [icon('micOff'), sub] : [sub]));
  }
  return hero;
}

function groupGrid(call, peers) {
  const n = peers.length;
  const wide = innerWidth > innerHeight;
  const cols = n <= 1 ? 1 : n === 2 ? (wide ? 2 : 1) : n <= 4 ? 2 : wide ? 3 : 2;
  const grid = h('div', { class: 'callx-grid' }, peers.map((p) => tile(p)));
  grid.style.setProperty('--cols', cols);
  return grid;
}

function tile(p, { small = false } = {}) {
  const v = p.video;
  const name = peerName(p);
  const av = peerAvatar(p);
  const t = slot(`tile:${p.deviceId}:${small ? 's' : 'l'}`, '', () => tint(h('div', { class: `callx-tile${small ? ' small' : ''}` }), av.id));
  const face = v ? videoEl(`${p.deviceId}:cam`, p.stream) : slot(`face:${p.deviceId}:${small}`, `${av.id}|${av.src || ''}`, () => h('div', { class: 'face' }, h('div', { class: 'pulse live' }, h('span'), avatar(av, small ? 'md' : 'lg'))));
  const state = p.state !== 'connected' ? (p.gaveUp ? 'Lost' : 'Connecting…') : '';
  const label = slot(`label:${p.deviceId}:${small}`, `${name}|${p.remote.muted}|${state}`, () => [
    h('div', { class: 'label' }, p.remote.muted ? icon('micOff') : null, h('span', { class: 'ellipsis' }, name)),
    state ? h('div', { class: 'tile-state' }, state) : null,
  ]);
  reconcile(t, [face, label]);
  watchLevel(p.deviceId, face.querySelector?.('.pulse') || t);
  watchLevel(p.deviceId, t);
  return t;
}

function strip(call, peers) {
  return peers.map((p) => tile(p, { small: true }));
}

function selfView(call, swapped = null) {
  const v = swapped
    ? videoEl(`${swapped.deviceId}:cam`, swapped.stream)
    : videoEl('self', call.preview, { mirror: call.facing === 'user' });
  const el = slot('self', '', () => {
    const box = h('div', { class: 'callx-self', title: 'Tap to swap, drag to move' });
    draggable(box, {
      onTap: () => {
        ui.swap = !ui.swap;
        render();
      },
      onDrop: (corner) => {
        ui.corner = corner;
      },
    });
    return box;
  });
  const badge = slot('self-badge', String(call.muted && !swapped), () => (call.muted && !swapped ? h('div', { class: 'badge' }, icon('micOff')) : null));
  reconcile(el, [v, badge]);
  return el;
}

// The video behind the video: a soft, blurred copy fills the screen round a
// picture that doesn't (a phone's tall video on a wide screen).
function ambient(stream) {
  const box = ui.part.ambientBox;
  if (!stream) {
    reconcile(box, []);
    return;
  }
  reconcile(box, [videoEl('ambient', stream)]);
}

function watchLevel(key, el) {
  if (!ui.levels.has(key)) ui.levels.set(key, new Set());
  ui.levels.get(key).add(el);
}

function renderAudio(call, peers) {
  const keep = new Set();
  for (const p of peers) {
    keep.add(p.deviceId);
    let a = ui.audios.get(p.deviceId);
    if (!a) {
      a = h('audio', { autoplay: true });
      ui.audios.set(p.deviceId, a);
      ui.audioBox.append(a);
    }
    if (a.srcObject !== p.audio) {
      a.srcObject = p.audio;
      a.play().catch(() => {});
    }
    if (call.outputId && a.setSinkId && a.sinkId !== call.outputId) a.setSinkId(call.outputId).catch(() => {});
  }
  for (const [id, a] of ui.audios) {
    if (!keep.has(id)) {
      a.srcObject = null;
      a.remove();
      ui.audios.delete(id);
    }
  }
}

// ---------- controls ----------

function glassButton(name, label, onClick, cls = '') {
  return slot(`glass:${name}`, `${label}|${cls}`, () => h('button', { type: 'button', class: `callx-glass ${cls}`, title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); run(onClick); } }, icon(name)));
}

function run(fn) {
  Promise.resolve()
    .then(fn)
    .catch((e) => toast(e.message));
}

function dockButton(name, label, onClick, { on = false, cls = '', key = name } = {}) {
  return slot(`dock:${key}`, `${name}|${label}|${on}|${cls}`, () => h('button', {
    type: 'button',
    class: `callx-btn ${on ? 'on' : ''} ${cls}`,
    title: label,
    'aria-label': label,
    'aria-pressed': cls === 'end' ? undefined : String(on),
    onclick: (e) => {
      e.stopPropagation();
      run(onClick);
    },
  }, icon(name)));
}

const canShare = () => !!navigator.mediaDevices?.getDisplayMedia && !native.app;
const canFlip = (call) => !!call.cam && (!!call.cam.getSettings?.().facingMode || calls.devices.cams.length > 1);
const wideScreen = () => innerWidth >= 720;

function dock(call) {
  return [
    dockButton('moreH', 'More', () => toggleSheet('more'), { on: ui.sheet === 'more' }),
    // Lit up when a video call's camera is off; in a voice call it just offers the camera.
    dockButton(call.cam || !call.video ? 'video' : 'videoOff', call.cam ? 'Turn camera off' : 'Turn camera on', () => calls.toggleCamera(), { on: call.video && !call.cam, key: 'cam' }),
    canFlip(call) ? dockButton('flip', 'Switch camera', () => calls.flipCamera()) : null,
    wideScreen() && canShare() ? dockButton('screen', call.sharing ? 'Stop sharing' : 'Share screen', () => calls.toggleScreen(), { on: call.sharing }) : null,
    dockButton(call.muted ? 'micOff' : 'mic', call.muted ? 'Unmute' : 'Mute', () => calls.toggleMute(), { on: call.muted, cls: call.muted ? 'alert' : '', key: 'mic' }),
    dockButton('hangup', 'End call', () => calls.hangup(), { cls: 'end' }),
  ];
}

function toggleSheet(name) {
  ui.sheet = ui.sheet === name ? null : name;
  render();
}

function qualityChip(call, peers) {
  if (call.status !== 'active' && call.status !== 'reconnecting') return null;
  let best = null;
  for (const p of peers) {
    const v = p.stats?.video?.in;
    if (v?.width && (!best || v.width * v.height > best.width * best.height)) best = v;
  }
  const label = best ? resolutionLabel(best.width, best.height) : call.hdAudio ? 'HD' : '';
  const bars = { good: 3, fair: 2, poor: 1 }[call.grade] || 0;
  return slot('chip', `${label}|${bars}|${call.grade}`, () => h(
    'button',
    { type: 'button', class: `callx-chip ${call.grade || ''}`, title: 'Call quality', 'aria-label': `Call quality${label ? ` ${label}` : ''}`, onclick: (e) => { e.stopPropagation(); toggleSheet('info'); } },
    label ? h('span', { class: 'res' }, label) : null,
    h('span', { class: 'bars', dataset: { n: String(bars) } }, h('i'), h('i'), h('i')),
  ));
}

function canInvite(call) {
  if (!call.peers.size) return false;
  const chat = S.chats.get(call.chatId);
  if (!chat) return false;
  if (chat.type === 'group' || chat.type === 'community') return true;
  // Your own chat rings all your devices: any not in the call can be rung.
  return isOwnChat(chat) && callableDevices().some((d) => !call.peers.has(d.id));
}

function invite() {
  calls.invite();
  flash('Ringing everyone who isn’t in the call');
}

function flash(text, ms = 2500) {
  ui.hint = text;
  render();
  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    ui.hint = null;
    render();
  }, ms);
}

// ---------- the More sheet ----------

function sheet(call, peers) {
  const back = h('button', { type: 'button', class: 'callx-sheet-back', 'aria-label': 'Back', onclick: () => toggleSheet('more') }, icon('back'));
  const close = h('div', { class: 'callx-scrim', onclick: () => toggleSheet(null) });
  let body;
  if (ui.sheet === 'quality') {
    body = [
      h('div', { class: 'callx-sheet-head' }, back, 'Video quality'),
      Object.entries(QUALITIES).map(([key, q]) => option(q.label, call.quality === key, () => calls.setQuality(key).then(() => toggleSheet('more')))),
      h('p', { class: 'callx-note' }, 'Up to 4K when both cameras and your connection can do it. Each device you call gets its own copy, so big group calls send less each.'),
    ];
  } else if (ui.sheet === 'devices') {
    const d = calls.devices;
    body = [
      h('div', { class: 'callx-sheet-head' }, back, 'Devices'),
      d.mics.length ? h('div', { class: 'callx-sheet-label' }, 'Microphone') : null,
      d.mics.map((m) => option(m.label, call.micId === m.deviceId, () => calls.useDevice('mic', m.deviceId))),
      d.cams.length ? h('div', { class: 'callx-sheet-label' }, 'Camera') : null,
      d.cams.map((c) => option(c.label, call.camId === c.deviceId && !!call.cam, () => calls.useDevice('cam', c.deviceId))),
      d.speakers.length ? h('div', { class: 'callx-sheet-label' }, 'Speaker') : null,
      d.speakers.map((s) => option(s.label, (call.outputId || 'default') === s.deviceId, () => calls.useDevice('speaker', s.deviceId))),
    ];
  } else if (ui.sheet === 'info') {
    body = [h('div', { class: 'callx-sheet-head' }, 'Call info'), info(call, peers)];
  } else {
    const pip = canPip();
    const tiles = [
      canShare() && !wideScreen() ? sheetTile('screen', call.sharing ? 'Stop sharing' : 'Share screen', () => calls.toggleScreen(), call.sharing) : null,
      pip ? sheetTile('pip', 'Picture in picture', () => openPip()) : null,
      canInvite(call) ? sheetTile('personAdd', 'Add people', () => invite()) : null,
      sheetTile('hd', `Video: ${QUALITIES[call.quality]?.short || '4K'}`, () => toggleSheet('quality')),
      sheetTile('mic', call.hdAudio ? 'HD audio on' : 'HD audio off', () => calls.setHdAudio(!call.hdAudio), call.hdAudio),
      sheetTile('music', call.audioMode === 'music' ? 'Original sound on' : 'Original sound', () => calls.setAudioMode(call.audioMode === 'music' ? 'voice' : 'music'), call.audioMode === 'music'),
      calls.devices.mics.length + calls.devices.cams.length > 2 || calls.devices.speakers.length > 1 ? sheetTile('settings', 'Devices', () => toggleSheet('devices')) : null,
      document.fullscreenEnabled && !native.app ? sheetTile('fullscreen', document.fullscreenElement ? 'Exit full screen' : 'Full screen', () => toggleFullscreen()) : null,
      sheetTile('info', 'Call info', () => toggleSheet('info')),
      sheetTile('chat', 'Open chat', () => { minimizeCall(); openChat(call.chatId); }),
    ];
    body = [
      h('div', { class: 'callx-reactbar' }, REACTIONS.map((e) => h('button', { type: 'button', 'aria-label': `React ${e}`, onclick: () => { calls.react(e); } }, e))),
      h('div', { class: 'callx-tiles' }, tiles),
    ];
  }
  return [close, h('div', { class: 'callx-sheet-card', onclick: (e) => e.stopPropagation() }, body)];
}

function sheetTile(name, label, onClick, on = false) {
  return h('button', { type: 'button', class: `callx-tile-btn${on ? ' on' : ''}`, onclick: () => run(onClick) }, h('span', { class: 'ic' }, icon(name)), h('span', null, label));
}

function option(label, on, onClick) {
  return h('button', { type: 'button', class: `callx-option${on ? ' on' : ''}`, onclick: () => run(onClick) }, h('span', { class: 'grow ellipsis' }, label), on ? icon('check') : null);
}

function info(call, peers) {
  const mbps = (kbps) => (kbps == null ? '–' : kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${kbps} kbit/s`);
  const vid = (v) => (v?.width ? `${v.width}×${v.height}${v.fps ? ` · ${v.fps} fps` : ''}${v.codec ? ` · ${v.codec}` : ''} · ${mbps(v.kbps)}` : 'No video');
  const aud = (a) => (a ? `${a.codec || 'Opus'} · ${mbps(a.kbps)}` : 'No audio');
  const limited = { bandwidth: ' (held back by the connection)', cpu: ' (held back by the processor)' };
  return h(
    'div',
    { class: 'callx-info' },
    peers.length ? null : h('p', { class: 'callx-note' }, 'Statistics show up once the call connects.'),
    peers.map((p) => {
      const s = p.stats;
      const path = s?.path;
      return h(
        'div',
        { class: 'callx-info-peer' },
        h('div', { class: 'who' }, avatar(peerAvatar(p), 'sm'), h('span', { class: 'grow ellipsis' }, peerName(p)), h('span', { class: `grade ${p.grade || ''}` }, p.grade && p.grade !== 'unknown' ? p.grade : p.state)),
        row('Receiving', vid(s?.video?.in)),
        row('Sending', `${vid(s?.video?.out)}${limited[s?.video?.out?.limited] || ''}`),
        row('Audio', `in ${aud(s?.audio?.in)}, out ${aud(s?.audio?.out)}`),
        row('Delay', s?.rtt != null ? `${s.rtt} ms round trip${s.loss != null ? ` · ${s.loss}% lost` : ''}` : '–'),
        row('Route', path ? `${path.relayed ? 'Relayed' : 'Direct'} over your tailnet${path.protocol ? ` (${path.protocol.toUpperCase()})` : ''}${path.address ? ` to ${path.address}` : ''}` : '–'),
      );
    }),
    h('p', { class: 'callx-note' }, icon('lock'), ' Audio and video go straight between your devices across your tailnet, encrypted. No other server takes part.'),
  );
}

const row = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));

function waitingCards() {
  if (!calls.call && !calls.ended) return [];
  return [...calls.incoming.values()].map((ring) => slot(`wait:${ring.callId}`, String(!!calls.call), () => {
    const who = ringInfo(ring);
    return tint(h(
      'div',
      { class: 'callx-wait', role: 'alertdialog', 'aria-label': `${who.title} is calling` },
      avatar(who.av, 'md'),
      h('div', { class: 'grow' }, h('div', { class: 'name ellipsis' }, who.title), h('div', { class: 'sub ellipsis' }, `${who.sub} · waiting`)),
      h('button', { type: 'button', class: 'decline', 'aria-label': 'Decline', onclick: () => calls.decline(ring.callId, calls.call ? 'busy' : undefined) }, icon('hangup')),
      h('button', { type: 'button', class: 'answer', title: calls.call ? 'End your call and answer' : 'Answer', 'aria-label': 'End your call and answer', onclick: () => calls.accept(ring.callId).catch((e) => toast(e.message)) }, icon(ring.video ? 'video' : 'phone')),
    ), who.caller.id);
  }));
}

// ---------- the minimised call ----------

function renderMini(call, who, peers, remoteVideo) {
  if (!ui.minimized) {
    ui.mini?.remove();
    ui.mini = null;
    return;
  }
  if (!ui.mini) {
    ui.mini = h('div', { class: 'callmini', role: 'dialog', 'aria-label': 'Call, minimised' });
    ui.mini.dataset.corner = 'br';
    draggable(ui.mini, { onTap: () => expandCall(), onDrop: (corner) => { ui.mini.dataset.corner = corner; } });
    layer().append(ui.mini);
  }
  const av = peers.length === 1 ? peerAvatar(peers[0]) : who.av;
  const face = remoteVideo
    ? videoEl(`${peers[0].deviceId}:mini`, peers[0].stream)
    : call.cam && !peers.length
      ? videoEl('self:mini', call.preview, { mirror: call.facing === 'user' })
      : slot('mini-face', `${av.id}|${av.src || ''}`, () => h('div', { class: 'pulse live' }, h('span'), avatar(av, 'md')));
  if (!remoteVideo && peers.length === 1) watchLevel(peers[0].deviceId, face);
  tint(ui.mini, who.av.id);
  ui.mini.classList.toggle('has-video', !!remoteVideo || (!!call.cam && !peers.length));
  const faceBox = slot('mini-facebox', '', () => h('div', { class: 'face' }));
  reconcile(faceBox, [face]);
  const meta = slot('mini-meta', who.title, () => h('div', { class: 'meta' }, h('div', { class: 'name ellipsis' }, who.title), h('div', { class: 'time', dataset: { clock: '1' } })));
  meta.lastChild.textContent = statusText(call);
  const btns = slot('mini-btns', String(call.muted), () => h('div', { class: 'btns' },
    h('button', { type: 'button', class: call.muted ? 'on' : '', 'aria-label': call.muted ? 'Unmute' : 'Mute', onclick: (e) => { e.stopPropagation(); calls.toggleMute(); } }, icon(call.muted ? 'micOff' : 'mic')),
    h('button', { type: 'button', class: 'end', 'aria-label': 'End call', onclick: (e) => { e.stopPropagation(); calls.hangup(); } }, icon('hangup'))));
  reconcile(ui.mini, [faceBox, meta, btns]);
}

// ---------- gestures ----------

// Drag a floating video to any corner; a tap does something else.
function draggable(el, { onTap, onDrop }) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 8) return;
      moved = true;
      el.classList.add('dragging');
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) {
        if (ev.type === 'pointerup') onTap?.();
        return;
      }
      // Snap to the nearest corner, gliding there from where it was let go.
      const before = el.getBoundingClientRect();
      const corner = `${before.top + before.height / 2 < innerHeight / 2 ? 't' : 'b'}${before.left + before.width / 2 < innerWidth / 2 ? 'l' : 'r'}`;
      el.classList.remove('dragging');
      el.style.transform = '';
      onDrop?.(corner);
      if (el.parentElement?.dataset.corner !== undefined) el.parentElement.dataset.corner = corner;
      const after = el.getBoundingClientRect();
      el.style.transition = 'none';
      el.style.transform = `translate(${before.left - after.left}px, ${before.top - after.top}px)`;
      el.getBoundingClientRect();
      el.style.transition = '';
      el.style.transform = '';
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// In a video call the controls fade away after a few seconds; a tap brings
// them back.
function poke() {
  clearTimeout(ui.idleTimer);
  if (ui.idle) {
    ui.idle = false;
    ui.root?.classList.remove('idle');
  }
  ui.idleTimer = setTimeout(() => {
    ui.idle = true;
    render();
  }, 4500);
}

function stageTap(e) {
  if (e.target.closest('button')) return;
  if (ui.sheet) {
    toggleSheet(null);
    return;
  }
  const mode = ui.root?.dataset.mode;
  if (mode === 'voice' || ui.wasIdle) return; // that tap brought the controls back
  clearTimeout(ui.idleTimer);
  ui.idle = true;
  render();
}

function stageDouble(e) {
  if (!e.target.closest('.callx-main')) return;
  ui.fit = ui.fit === 'contain' ? 'cover' : 'contain';
  render();
}

function onKey(e) {
  if (!calls.call || ui.minimized || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
  if (e.key === 'Escape') {
    if (ui.sheet) toggleSheet(null);
    else minimizeCall();
  } else if (e.key === 'm' || e.key === 'M') {
    calls.toggleMute();
  } else if (e.key === 'v' || e.key === 'V') {
    run(() => calls.toggleCamera());
  } else return;
  e.preventDefault();
}

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  return ui.root.requestFullscreen();
}

function startClock() {
  if (ui.clock) return;
  ui.clock = setInterval(() => {
    const call = calls.call;
    if (!call) return;
    if (call.status === 'active') {
      const t = clock(call);
      if (ui.part.status) ui.part.status.textContent = t;
      ui.mini?.querySelector('[data-clock]')?.replaceChildren(t);
    }
  }, 1000);
}

// ---------- picture in picture ----------

function canPip() {
  return !!native.app || !!window.documentPictureInPicture || !!document.pictureInPictureEnabled;
}

export async function openPip() {
  const call = calls.call;
  if (!call) return;
  if (native.app) {
    native.post('pip');
    return;
  }
  ui.sheet = null;
  if (window.documentPictureInPicture) {
    await docPip();
  } else if (document.pictureInPictureEnabled) {
    const main = ui.part.stage?.querySelector('.callx-main video') || ui.part.stage?.querySelector('video');
    if (main) await main.requestPictureInPicture();
    else await canvasPip(call);
  } else {
    throw new Error("This browser can't show the call in a floating window");
  }
  render();
}

// Chrome and Edge on a computer: the whole call screen moves into a small
// window that stays on top of other apps.
async function docPip() {
  if (ui.pip?.kind === 'doc') return;
  const win = await window.documentPictureInPicture.requestWindow({ width: 400, height: 560 });
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const l = win.document.createElement('link');
    l.rel = 'stylesheet';
    l.href = link.href;
    win.document.head.append(l);
  }
  win.document.documentElement.style.cssText = document.documentElement.style.cssText;
  if (document.documentElement.dataset.theme) win.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  win.document.title = 'Tailchat call';
  win.document.body.classList.add('pip-body');
  ui.pip = { kind: 'doc', win };
  win.document.body.append(ui.root);
  win.addEventListener('pagehide', () => {
    if (ui.pip?.win !== win) return;
    ui.pip = null;
    if (ui.root) layer().append(ui.root);
    render();
  });
}

// Elsewhere, for a voice call: a little live picture of who you're talking
// to, drawn on a canvas and shown as a floating video.
async function canvasPip(call) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext('2d');
  const video = h('video', { muted: true, playsInline: true });
  video.srcObject = canvas.captureStream(10);
  const draw = () => {
    const c = calls.call;
    if (!c) return;
    const peers = [...c.peers.values()];
    const who = party(c.chatId, peers);
    const color = colorFor(who.av.id || '');
    const level = peers[0] ? calls.meter.levels.get(peers[0].deviceId) || 0 : 0;
    g.fillStyle = '#121112';
    g.fillRect(0, 0, 640, 360);
    const grad = g.createRadialGradient(200, 180, 10, 200, 180, 300);
    grad.addColorStop(0, `${color}88`);
    grad.addColorStop(1, '#12111200');
    g.fillStyle = grad;
    g.fillRect(0, 0, 640, 360);
    g.beginPath();
    g.arc(170, 180, 78 + level * 26, 0, Math.PI * 2);
    g.fillStyle = `${color}44`;
    g.fill();
    g.beginPath();
    g.arc(170, 180, 70, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.fillStyle = '#fff';
    g.font = '600 52px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText((who.title.trim()[0] || '?').toUpperCase(), 170, 182);
    g.textAlign = 'left';
    g.font = '600 34px Inter, system-ui, sans-serif';
    g.fillText(who.title.slice(0, 18), 280, 160);
    g.fillStyle = '#c9c6c4';
    g.font = '28px Inter, system-ui, sans-serif';
    g.fillText(statusText(c), 280, 210);
  };
  draw();
  const timer = setInterval(draw, 100);
  await video.play();
  await video.requestPictureInPicture();
  ui.pip = { kind: 'video', video, stop: () => clearInterval(timer) };
  video.addEventListener('leavepictureinpicture', () => {
    clearInterval(timer);
    if (ui.pip?.video === video) ui.pip = null;
  });
}

function closePip() {
  const pip = ui.pip;
  ui.pip = null;
  if (!pip) {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    return;
  }
  if (pip.kind === 'doc') {
    if (ui.root && ui.root.ownerDocument !== document) layer().append(ui.root);
    pip.win.close();
  } else {
    pip.stop?.();
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  }
}

// Switching tabs or apps mid-call can open picture in picture by itself
// (Chrome asks the page through Media Session).
let sessionCall = null;
function setMediaSession(call) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const id = call?.callId || null;
  if (id === sessionCall) return;
  sessionCall = id;
  try {
    ms.setActionHandler('enterpictureinpicture', id ? () => openPip().catch(() => {}) : null);
  } catch {
    // this browser doesn't know the action
  }
  for (const [action, fn] of [['togglemicrophone', () => calls.toggleMute()], ['togglecamera', () => run(() => calls.toggleCamera())], ['hangup', () => calls.hangup()]]) {
    try {
      ms.setActionHandler(action, id ? fn : null);
    } catch {
      // not supported here
    }
  }
}

// The Android app's own picture in picture: only the video shows.
native.on('pip', (m) => {
  ui.nativePip = !!m.on;
  if (m.on) ui.sheet = null;
  render();
});
