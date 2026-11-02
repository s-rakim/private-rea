// Voice and video calls, Tailchat's own: WebRTC from device to device,
// directly across the tailnet. Tailscale addresses reach every device, so no
// STUN or TURN servers are configured and nothing about a call leaves your
// tailnet or touches a server other than your own. WebRTC encrypts the
// audio and video (DTLS-SRTP) on top of WireGuard, and the setup messages
// are sealed to the other device's key like a message, so the Tailchat
// server that relays them can't swap the encryption keys and listen in.
//
// How a call is put together:
// - Every pair of devices in a call has one RTCPeerConnection. The device
//   that joins later starts it (the "initiator") and is the only one that
//   ever sends offers, so the two never offer at the same time.
// - The initiator creates three transceivers, the same on every device:
//   0 microphone, 1 camera, 2 screen. Turning the camera on or off, flipping
//   it, sharing the screen or changing the microphone swaps the track on a
//   transceiver (replaceTrack) and needs no new offer.
// - A data channel on the same connection carries who is muted, whose
//   camera is off, who is sharing, and reactions.
// - When the connection drops (a phone changing networks) the initiator
//   restarts ICE; the other side asks it to. If the WebSocket to the server
//   drops, the server keeps the device in the call for a while and the call
//   carries on when it reconnects.
import { newMessageId } from './crypto.js';
import {
  DEFAULT_QUALITY, REACTIONS, RATED_CODECS, SPEAKING, audioConstraints, audioKbps, codecScores, grade, nextLevel,
  orderCodecs, quality as qualityOf, readStats, rms, tuneOpus, videoConstraints, videoKbps,
} from './rtc.js';
import * as tones from './tones.js';

const RTC_CONFIG = { iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
export const AUDIO = 0;
export const CAMERA = 1;
export const SCREEN = 2;

const MAX_RESTARTS = 8;
const CONNECT_TIMEOUT = 40_000;

// Why a call ended, as the call screen says it.
export const END_TEXT = {
  ended: 'Call ended',
  cancelled: 'Call cancelled',
  declined: 'Declined',
  busy: 'Busy on another call',
  missed: 'No answer',
  failed: "Couldn't connect",
  error: 'Call failed',
};

export class CallManager {
  // seal(callId, toDevice, toUser, data) -> envelope string, and
  // open(callId, fromDevice, fromUser, envelope) -> data, which throws unless
  // the envelope was sealed by fromDevice and fromDevice belongs to fromUser.
  // settings() -> { quality, hdAudio, ringtone, vibrate } from preferences.
  constructor({ realtime, seal, open, settings, onChange, onIncoming, onIncomingEnd, onState, onLevels, onReaction, onError }) {
    this.rt = realtime;
    this.seal = seal;
    this.open = open;
    this.settings = settings || (() => ({}));
    this.onChange = onChange || (() => {});
    this.onIncoming = onIncoming || (() => {});
    this.onIncomingEnd = onIncomingEnd || (() => {});
    this.onState = onState || (() => {});
    this.onLevels = onLevels || (() => {});
    this.onReaction = onReaction || (() => {});
    this.onError = onError || (() => {});
    this.call = null; // the call this device is in
    this.incoming = new Map(); // callId -> ring, for calls ringing here
    this.ended = null; // the call that just ended, shown for a moment
    this.queue = Promise.resolve(); // events are handled one at a time, in order
    this.meter = new Meter();
    this.devices = { mics: [], cams: [], speakers: [] };
    this.codecInfo = null;
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.listDevices());
  }

  send(msg) {
    this.rt.send({ type: 'call', ...msg });
  }

  warn(err) {
    console.warn('call:', err);
  }

  // ---------- starting, answering, ending ----------

  newCall(callId, chatId, video, direction) {
    const s = this.settings();
    return {
      callId, chatId, video, direction,
      status: 'starting', // starting, calling, ringing, connecting, active, reconnecting
      createdAt: Date.now(), startedAt: null,
      local: new MediaStream(), mic: null, cam: null, meterMic: null, screen: null,
      muted: false, cameraOff: true, sharing: false, facing: 'user',
      quality: s.quality || DEFAULT_QUALITY, hdAudio: s.hdAudio !== false, audioMode: 'voice',
      micId: '', camId: '', outputId: '',
      peers: new Map(), // deviceId -> Peer
      ringing: new Set(), // devices that said they are ringing
      declined: null,
      unreachable: false,
      timers: [],
    };
  }

  async start(chatId, video) {
    if (this.call) throw new Error('You are already in a call');
    tones.unlockAudio();
    this.ended = null;
    const call = this.newCall(newMessageId(), chatId, video, 'out');
    this.call = call;
    this.onChange();
    try {
      await this.capture(call, video);
    } catch (err) {
      if (this.call === call) this.call = null;
      this.onChange();
      throw err;
    }
    if (this.call !== call) {
      this.release(call);
      return;
    }
    call.status = 'calling';
    this.send({ action: 'ring', callId: call.callId, chatId, video });
    // Nothing rang yet: the other device may be offline or asleep.
    call.timers.push(setTimeout(() => {
      if (this.call === call && call.status === 'calling') {
        call.unreachable = true;
        this.onChange();
      }
    }, 6000));
    this.begin(call);
  }

  // accept(callId, { video: false }) answers a video call with the camera off.
  async accept(callId, { video } = {}) {
    const ring = this.incoming.get(callId);
    if (!ring) return;
    tones.unlockAudio();
    this.ringGone(callId, 'accepted');
    if (this.call) this.hangup(); // call waiting: end this one, answer the new one
    this.ended = null;
    const wantVideo = video ?? ring.video;
    const call = this.newCall(callId, ring.chatId, ring.video, 'in');
    call.status = 'connecting';
    this.call = call;
    this.onChange();
    try {
      await this.capture(call, wantVideo);
    } catch (err) {
      if (this.call === call) this.call = null;
      this.send({ action: 'decline', callId });
      this.onChange();
      throw err;
    }
    if (this.call !== call) {
      this.release(call);
      return;
    }
    this.send({ action: 'accept', callId });
    call.timers.push(setTimeout(() => {
      if (this.call === call && call.status !== 'active') this.failed(call);
    }, CONNECT_TIMEOUT));
    this.begin(call);
  }

  decline(callId, reason) {
    const ring = this.incoming.get(callId);
    if (!ring) return;
    this.send({ action: 'decline', callId, ...(reason ? { reason } : {}) });
    this.ringGone(callId, 'declined');
  }

  hangup() {
    const call = this.call;
    if (!call) return;
    if (call.status !== 'starting') this.send({ action: 'hangup', callId: call.callId });
    this.finish(call, call.startedAt ? 'ended' : 'cancelled');
  }

  // Ask the server to ring the people (or your devices) not in the call.
  invite() {
    if (this.call?.peers.size) this.send({ action: 'invite', callId: this.call.callId });
  }

  begin(call) {
    this.listDevices();
    this.loops(call);
    this.onState(call);
    this.onChange();
  }

  failed(call) {
    this.send({ action: 'hangup', callId: call.callId });
    this.finish(call, 'failed');
  }

  finish(call, reason) {
    if (this.call !== call) return;
    const wasActive = !!call.startedAt;
    this.release(call);
    this.call = null;
    tones.stop('ringback');
    if (wasActive || reason === 'cancelled') tones.ended();
    else if (reason === 'declined' || reason === 'busy') tones.busy();
    this.ended = {
      chatId: call.chatId, video: call.video, direction: call.direction, reason,
      seconds: wasActive ? Math.round((Date.now() - call.startedAt) / 1000) : 0, at: Date.now(),
    };
    const shown = this.ended;
    setTimeout(() => {
      if (this.ended === shown) {
        this.ended = null;
        this.onChange();
      }
    }, reason === 'ended' || reason === 'cancelled' ? 1800 : 4000);
    this.updateRinging();
    this.onState(null);
    this.onChange();
  }

  release(call) {
    for (const t of call.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    for (const p of call.peers.values()) p.close();
    call.peers.clear();
    for (const t of [call.mic, call.cam, call.meterMic, call.screen]) t?.stop();
    this.meter.clear();
    call.wakeLock?.release().catch(() => {});
  }

  // Back online after the WebSocket dropped: carry on with the call, and
  // find out whether calls that were ringing here are still ringing.
  resume() {
    if (this.call && this.call.status !== 'starting') this.send({ action: 'rejoin', callId: this.call.callId });
    for (const callId of this.incoming.keys()) this.send({ action: 'rejoin', callId });
  }

  // ---------- microphone and camera ----------

  async capture(call, video) {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new Error('Calls need a browser with camera and microphone access, opened over HTTPS');
    let stream;
    try {
      stream = await md.getUserMedia({ audio: audioConstraints(call.audioMode, call.micId), video: video ? videoConstraints(call.quality, { facing: call.facing }) : false });
    } catch (err) {
      if (!video) throw mediaError(err, false);
      // No camera, or it's busy: carry on with just the microphone.
      try {
        stream = await md.getUserMedia({ audio: audioConstraints(call.audioMode, call.micId) });
      } catch {
        throw mediaError(err, true);
      }
      this.onError(new Error(`Your camera didn't start (${mediaError(err, true).reason}), so you're on voice for now`));
    }
    const mic = stream.getAudioTracks()[0] || null;
    const cam = stream.getVideoTracks()[0] || null;
    this.useMic(call, mic);
    if (cam) this.useCam(call, cam);
  }

  useMic(call, mic) {
    if (call.mic) call.local.removeTrack(call.mic);
    call.mic?.stop();
    call.meterMic?.stop();
    call.mic = mic;
    call.meterMic = null;
    if (!mic) return;
    mic.contentHint = call.audioMode === 'music' ? 'music' : 'speech';
    mic.enabled = !call.muted;
    call.micId = mic.getSettings?.().deviceId || call.micId;
    call.local.addTrack(mic);
    // A copy that stays on while you're muted, for "You're muted" when you
    // start talking.
    call.meterMic = mic.clone();
    call.meterMic.enabled = true;
    this.meter.watch('self', call.meterMic);
    for (const p of call.peers.values()) p.setTrack(AUDIO, mic);
  }

  useCam(call, cam) {
    if (call.cam) call.local.removeTrack(call.cam);
    call.cam?.stop();
    call.cam = cam;
    call.cameraOff = !cam;
    if (cam) {
      cam.contentHint = 'motion';
      const settings = cam.getSettings?.() || {};
      call.camId = settings.deviceId || call.camId;
      if (settings.facingMode) call.facing = settings.facingMode === 'environment' ? 'environment' : 'user';
      call.local.addTrack(cam);
      call.video = true;
    }
    call.preview = cam ? new MediaStream([cam]) : null;
    for (const p of call.peers.values()) p.setTrack(CAMERA, cam);
  }

  toggleMute() {
    const call = this.call;
    if (!call) return;
    call.muted = !call.muted;
    if (call.mic) call.mic.enabled = !call.muted;
    this.shareState();
  }

  async toggleCamera() {
    const call = this.call;
    if (!call) return;
    if (call.cam) {
      this.useCam(call, null);
    } else {
      const cam = await this.openCamera(call);
      if (this.call !== call) return cam.stop();
      this.useCam(call, cam);
    }
    this.shareState();
    this.onState(call);
  }

  async openCamera(call, { facing = call.facing, deviceId } = {}) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(call.quality, { facing, deviceId }) });
      return s.getVideoTracks()[0];
    } catch (err) {
      throw mediaError(err, true);
    }
  }

  // Front and back camera on a phone; the next camera on a computer.
  async flipCamera() {
    const call = this.call;
    if (!call?.cam) return;
    const mobile = !!call.cam.getSettings?.().facingMode;
    const cams = this.devices.cams;
    let next = {};
    if (mobile || cams.length < 2) next = { facing: call.facing === 'user' ? 'environment' : 'user' };
    else next = { deviceId: cams[(cams.findIndex((d) => d.deviceId === call.camId) + 1) % cams.length].deviceId };
    // Phones can't keep two cameras open, so the old one stops first.
    const old = { facing: call.facing, deviceId: call.camId };
    call.cam.stop();
    let cam;
    try {
      cam = await this.openCamera(call, next);
    } catch (err) {
      cam = await this.openCamera(call, old).catch(() => null);
      if (!cam) {
        this.useCam(call, null);
        this.shareState();
      }
      if (cam) this.useCam(call, cam);
      throw err;
    }
    if (this.call !== call) return cam.stop();
    if (next.facing) call.facing = next.facing;
    this.useCam(call, cam);
    this.onChange();
  }

  async useDevice(kind, deviceId) {
    const call = this.call;
    if (!call) return;
    if (kind === 'speaker') {
      call.outputId = deviceId;
    } else if (kind === 'mic') {
      call.micId = deviceId;
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(call.audioMode, deviceId) }).catch((err) => {
        throw mediaError(err, false);
      });
      if (this.call !== call) return s.getTracks().forEach((t) => t.stop());
      this.useMic(call, s.getAudioTracks()[0]);
    } else if (kind === 'cam') {
      call.cam?.stop();
      const cam = await this.openCamera(call, { deviceId });
      if (this.call !== call) return cam.stop();
      this.useCam(call, cam);
      this.shareState();
    }
    this.onChange();
  }

  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const named = (list, fallback) => list.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
      this.devices = {
        mics: named(all.filter((d) => d.kind === 'audioinput' && d.deviceId), 'Microphone'),
        cams: named(all.filter((d) => d.kind === 'videoinput' && d.deviceId), 'Camera'),
        speakers: 'setSinkId' in HTMLMediaElement.prototype ? named(all.filter((d) => d.kind === 'audiooutput' && d.deviceId), 'Speaker') : [],
      };
      this.onChange();
    } catch {
      // no device list: the call screen just doesn't offer a choice
    }
  }

  // ---------- screen sharing ----------

  async toggleScreen() {
    const call = this.call;
    if (!call) return;
    if (call.screen) return this.stopScreen();
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser can't share its screen");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (this.call !== call) return track.stop();
    track.contentHint = 'detail';
    track.addEventListener('ended', () => this.call === call && call.screen === track && this.stopScreen());
    call.screen = track;
    call.sharing = true;
    call.screenPreview = new MediaStream([track]);
    for (const p of call.peers.values()) p.setTrack(SCREEN, track);
    this.shareState();
  }

  stopScreen() {
    const call = this.call;
    if (!call?.screen) return;
    call.screen.stop();
    call.screen = null;
    call.screenPreview = null;
    call.sharing = false;
    for (const p of call.peers.values()) p.setTrack(SCREEN, null);
    this.shareState();
  }

  // ---------- quality ----------

  async setQuality(key) {
    const call = this.call;
    if (!call) return;
    call.quality = key;
    const q = qualityOf(key);
    await call.cam?.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps, max: 60 } }).catch(() => {});
    for (const p of call.peers.values()) p.tune();
    this.onChange();
  }

  setHdAudio(on) {
    const call = this.call;
    if (!call) return;
    call.hdAudio = on;
    for (const p of call.peers.values()) p.tune();
    this.onChange();
  }

  // 'voice' (echo cancelling and noise suppression on) or 'music' (original
  // sound, stereo, more bits).
  async setAudioMode(mode) {
    const call = this.call;
    if (!call || call.audioMode === mode) return;
    const before = call.audioMode;
    call.audioMode = mode;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(mode, call.micId) });
      if (this.call !== call) return s.getTracks().forEach((t) => t.stop());
      this.useMic(call, s.getAudioTracks()[0]);
    } catch (err) {
      call.audioMode = before;
      throw mediaError(err, false);
    }
    for (const p of call.peers.values()) p.tune();
    this.onChange();
  }

  // Which video codecs this device encodes well, asked once.
  async codecs() {
    if (this.codecInfo) return this.codecInfo;
    const info = {};
    const caps = navigator.mediaCapabilities;
    if (caps?.encodingInfo) {
      await Promise.all(RATED_CODECS.map(async (mime) => {
        try {
          const r = await caps.encodingInfo({ type: 'webrtc', video: { contentType: `video/${mime.slice(6).toUpperCase()}`, width: 1920, height: 1080, bitrate: 6_000_000, framerate: 30 } });
          info[mime] = { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
        } catch {
          // this browser doesn't rate WebRTC codecs
        }
      }));
    }
    this.codecInfo = codecScores(info);
    return this.codecInfo;
  }

  // ---------- what's shared with the other devices ----------

  shareState() {
    const call = this.call;
    if (!call) return;
    for (const p of call.peers.values()) p.sendState();
    this.onState(call);
    this.onChange();
  }

  react(emoji) {
    const call = this.call;
    if (!call || !REACTIONS.includes(emoji)) return;
    for (const p of call.peers.values()) p.message({ t: 'react', emoji });
    this.onReaction(null, emoji);
  }

  // ---------- the running call ----------

  loops(call) {
    // Voice levels for the speaking rings, ten times a second.
    call.timers.push(setInterval(() => {
      if (this.call !== call) return;
      this.meter.sample();
      this.onLevels(this.meter.levels);
    }, 100));
    // Connection statistics every two seconds.
    call.timers.push(setInterval(() => this.readStats(call), 2000));
  }

  async readStats(call) {
    if (this.call !== call) return;
    let worst = null;
    for (const p of call.peers.values()) {
      try {
        const report = await p.pc.getStats();
        p.stats = readStats(report, p.stats);
        p.grade = grade(p.stats);
        if (!worst || rank(p.grade) > rank(worst)) worst = p.grade;
      } catch {
        // closed in the meantime
      }
    }
    const before = call.grade;
    call.grade = worst || 'unknown';
    if (before !== call.grade || call.peers.size) this.onChange();
  }

  peerConnected(peer) {
    const call = this.call;
    if (!call || peer.call !== call) return;
    if (call.status !== 'active') {
      const first = !call.startedAt;
      call.status = 'active';
      call.startedAt ??= Date.now();
      tones.stop('ringback');
      if (first) tones.connected();
      if (call.video && navigator.wakeLock && !call.wakeLock) {
        navigator.wakeLock.request('screen').then((lock) => {
          if (this.call === call) call.wakeLock = lock;
          else lock.release();
        }).catch(() => {});
      }
      this.onState(call);
    }
    this.onChange();
  }

  peerTrouble() {
    const call = this.call;
    if (!call || call.status !== 'active') return;
    const peers = [...call.peers.values()];
    if (peers.length && peers.every((p) => p.state !== 'connected')) {
      call.status = 'reconnecting';
      this.onChange();
    }
  }

  peerFailed(peer) {
    const call = this.call;
    if (!call || peer.call !== call) return;
    const peers = [...call.peers.values()];
    if (peers.every((p) => p.gaveUp)) this.failed(call);
  }

  connect(deviceId, userId, initiator) {
    const call = this.call;
    let p = call.peers.get(deviceId);
    if (p) return p;
    p = new Peer(this, call, deviceId, userId, initiator);
    call.peers.set(deviceId, p);
    return p;
  }

  dropPeer(deviceId) {
    const call = this.call;
    const p = call?.peers.get(deviceId);
    if (!p) return;
    p.close();
    call.peers.delete(deviceId);
    this.meter.unwatch(deviceId);
    for (const other of call.peers.values()) other.tune();
  }

  // ---------- events from the server ----------

  handle(event) {
    const run = this.queue.then(() => this.process(event));
    this.queue = run.catch(() => {});
    return run;
  }

  async process(event) {
    const { action, callId } = event;
    if (action === 'ring') {
      if (this.call?.callId === callId || this.incoming.has(callId)) return;
      const ring = { ...event, at: Date.now(), waiting: !!this.call };
      ring.expire = setTimeout(() => this.ringGone(callId, 'missed'), 60_000);
      this.incoming.set(callId, ring);
      this.send({ action: 'ringing', callId });
      this.updateRinging();
      this.onIncoming(ring);
      this.onChange();
      return;
    }
    if (this.incoming.has(callId) && ['answered-elsewhere', 'missed', 'ended'].includes(action)) {
      const reason = action === 'answered-elsewhere' ? 'elsewhere' : action === 'ended' && event.reason !== 'missed' ? 'cancelled' : 'missed';
      this.ringGone(callId, reason);
      return;
    }
    const call = this.call;
    if (!call || call.callId !== callId) return;
    switch (action) {
      case 'ringing':
        call.ringing.add(event.deviceId);
        call.unreachable = false;
        if (call.status === 'calling' || call.status === 'ringing') {
          call.status = 'ringing';
          if (!tones.playing('ringback')) tones.ringback();
        }
        break;
      case 'joined':
        // We picked up: connect to everyone already in the call.
        call.video = event.video || call.video;
        for (const peer of event.peers) this.connect(peer.deviceId, peer.userId, true);
        break;
      case 'peer-joined':
        tones.stop('ringback');
        if (call.status !== 'active') call.status = 'connecting';
        this.connect(event.deviceId, event.userId, false);
        call.timers.push(setTimeout(() => {
          if (this.call === call && call.status === 'connecting') this.failed(call);
        }, CONNECT_TIMEOUT));
        break;
      case 'rejoined': {
        // Back after the WebSocket dropped. People who left meanwhile go;
        // anyone who joined offered to us while we couldn't hear it, so ask
        // them to start again.
        const there = new Set(event.peers.map((p) => p.deviceId));
        for (const deviceId of [...call.peers.keys()]) if (!there.has(deviceId)) this.dropPeer(deviceId);
        for (const peer of event.peers) {
          const known = call.peers.get(peer.deviceId);
          if (!known) this.connect(peer.deviceId, peer.userId, false).send({ restart: true });
          else if (known.state !== 'connected') known.restartIce();
        }
        break;
      }
      case 'signal': {
        const data = await this.open(callId, event.fromDevice, event.from, event.data?.sealed);
        if (this.call !== call) return;
        const p = call.peers.get(event.fromDevice) || this.connect(event.fromDevice, event.from, false);
        if (p.userId !== event.from) return;
        await p.signal(data);
        break;
      }
      case 'peer-left':
        this.dropPeer(event.deviceId);
        break;
      case 'declined':
        call.declined = event.reason || 'declined';
        break;
      case 'ended':
        this.finish(call, event.reason === 'missed' && call.direction === 'out' ? 'missed' : event.reason === 'declined' || event.reason === 'busy' ? event.reason : 'ended');
        return;
      case 'error':
        this.finish(call, 'error');
        this.onError(new Error(event.message || 'The call failed'));
        return;
      default:
        break;
    }
    this.onChange();
  }

  ringGone(callId, reason) {
    const ring = this.incoming.get(callId);
    if (!ring) return;
    clearTimeout(ring.expire);
    this.incoming.delete(callId);
    this.updateRinging();
    this.onIncomingEnd(ring, reason);
    this.onChange();
  }

  // The ringtone plays while a call rings here, the call-waiting beeps
  // instead while you're in another call.
  updateRinging() {
    const s = this.settings();
    if (!this.incoming.size) {
      tones.stop('ringtone');
      tones.stop('waiting');
    } else if (this.call) {
      tones.stop('ringtone');
      if (!tones.playing('waiting')) tones.waiting();
    } else {
      tones.stop('waiting');
      if (!tones.playing('ringtone')) tones.ringtone({ sound: s.ringtone !== false, vibrate: s.vibrate !== false });
    }
  }

  // Quiet the ringing without declining (the volume button on a phone).
  silence() {
    tones.stop('ringtone');
    tones.stop('waiting');
  }
}

const rank = (g) => ({ unknown: 0, good: 1, fair: 2, poor: 3 })[g] ?? 0;

function mediaError(err, video) {
  const what = video ? 'camera or microphone' : 'microphone';
  const reason = err?.name === 'NotAllowedError' ? 'access is blocked'
    : err?.name === 'NotFoundError' ? `no ${video ? 'camera' : 'microphone'} was found`
      : err?.name === 'NotReadableError' ? 'another app is using it'
        : err?.message || 'it is unavailable';
  const e = new Error(`Can't use your ${what}: ${reason}`);
  e.reason = reason;
  return e;
}

// ---------- one connection to one other device ----------

class Peer {
  constructor(manager, call, deviceId, userId, initiator) {
    this.mgr = manager;
    this.call = call;
    this.deviceId = deviceId;
    this.userId = userId;
    this.initiator = initiator;
    this.state = 'connecting';
    this.stream = new MediaStream(); // their microphone and camera
    this.audio = new MediaStream(); // just the microphone, for the speaker
    this.screen = null; // their shared screen
    this.remote = { muted: false, cameraOff: !call.video, sharing: false, known: false };
    this.pending = [];
    this.candidates = [];
    this.outbox = Promise.resolve();
    this.restarts = 0;
    this.gaveUp = false;
    this.closed = false;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    // Both sides make the same channel (negotiated, id 0), so neither waits
    // for the other to announce it.
    this.dc = pc.createDataChannel('tailchat', { negotiated: true, id: 0 });
    this.dc.onopen = () => this.sendState();
    this.dc.onmessage = (e) => this.onMessage(e.data);

    if (initiator) {
      const q = qualityOf(call.quality);
      pc.addTransceiver(call.mic || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(call.cam || 'video', { direction: 'sendrecv', sendEncodings: [{ maxBitrate: q.kbps * 1000, maxFramerate: q.fps }] });
      pc.addTransceiver(call.screen || 'video', { direction: 'sendrecv', sendEncodings: [{ maxBitrate: q.kbps * 1000, maxFramerate: 30 }] });
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      this.candidates.push(e.candidate.toJSON());
      // A few at a time: each message is sealed separately.
      this.flush ??= setTimeout(() => {
        this.flush = null;
        const list = this.candidates.splice(0);
        if (list.length) this.send({ candidates: list });
      }, 40);
    };
    pc.onnegotiationneeded = () => this.negotiate();
    pc.ontrack = (e) => this.onTrack(e);
    pc.onconnectionstatechange = () => this.onState();
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') this.tune();
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.flush);
    clearTimeout(this.retry);
    try {
      this.dc.close();
    } catch {
      // already closed
    }
    this.pc.close();
  }

  // Sealing is async; the outbox keeps messages in the order they were made.
  send(data) {
    const { mgr, call } = this;
    this.outbox = this.outbox
      .then(async () => {
        const sealed = await mgr.seal(call.callId, this.deviceId, this.userId, data);
        if (mgr.call === call && !this.closed) mgr.send({ action: 'signal', callId: call.callId, toDevice: this.deviceId, data: { sealed } });
      })
      .catch((err) => mgr.warn(err));
  }

  async negotiate() {
    if (!this.initiator || this.closed) return;
    const pc = this.pc;
    try {
      await this.preferCodecs();
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable' || this.closed) return;
      await pc.setLocalDescription(offer);
      this.send({ sdp: pc.localDescription.toJSON() });
    } catch (err) {
      this.mgr.warn(err);
    }
  }

  async signal(data) {
    const pc = this.pc;
    if (this.closed || !data || typeof data !== 'object') return;
    const sdp = data.sdp;
    if (sdp && typeof sdp.sdp === 'string' && (sdp.type === 'offer' || sdp.type === 'answer')) {
      const desc = { type: sdp.type, sdp: tuneOpus(sdp.sdp, { stereo: true }) };
      if (desc.type === 'offer') {
        // Only the device that joined later offers; an offer the other way
        // round is ignored.
        if (this.initiator) return;
        await pc.setRemoteDescription(desc);
        this.attach();
        await this.preferCodecs();
        await pc.setLocalDescription(await pc.createAnswer());
        this.send({ sdp: pc.localDescription.toJSON() });
      } else {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(desc);
      }
      for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    }
    if (Array.isArray(data.candidates)) {
      for (const c of data.candidates.slice(0, 50)) {
        if (!c || typeof c !== 'object') continue;
        if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
        else if (this.pending.length < 200) this.pending.push(c);
      }
    }
    if (data.restart) this.restartIce();
  }

  // The answering side sends on the transceivers the offer made.
  attach() {
    const call = this.call;
    const tracks = [call.mic, call.cam, call.screen];
    this.pc.getTransceivers().slice(0, 3).forEach((t, i) => {
      if (t.direction === 'stopped' || t.stopped) return;
      if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
      const track = tracks[i] || null;
      if (t.sender.track !== track) t.sender.replaceTrack(track).catch((err) => this.mgr.warn(err));
    });
  }

  setTrack(index, track) {
    const t = this.pc.getTransceivers()[index];
    if (!t || t.stopped) return; // not set up yet: attach() picks it up
    t.sender.replaceTrack(track).then(() => this.tune()).catch((err) => this.mgr.warn(err));
  }

  async preferCodecs() {
    if (!globalThis.RTCRtpTransceiver?.prototype.setCodecPreferences || !globalThis.RTCRtpReceiver?.getCapabilities) return;
    const caps = RTCRtpReceiver.getCapabilities('video')?.codecs;
    if (!caps?.length) return;
    const order = orderCodecs(caps, await this.mgr.codecs());
    for (const t of this.pc.getTransceivers().slice(1, 3)) {
      try {
        t.setCodecPreferences(order);
      } catch {
        // keep the browser's own order
      }
    }
  }

  // Bitrates and priorities for what this device sends.
  async tune() {
    if (this.closed) return;
    const call = this.call;
    const [audio, cam, screen] = this.pc.getTransceivers();
    const q = qualityOf(call.quality);
    const kbps = videoKbps(call.quality, call.peers.size);
    await setParams(audio?.sender, { maxBitrate: audioKbps({ hd: call.hdAudio, mode: call.audioMode }) * 1000, priority: 'high', networkPriority: 'high' });
    // A shared screen gets the bandwidth; the camera steps back meanwhile.
    await setParams(cam?.sender, { maxBitrate: (call.screen ? Math.min(kbps, 1500) : kbps) * 1000, maxFramerate: q.fps, priority: 'medium', networkPriority: 'medium' }, 'balanced');
    await setParams(screen?.sender, { maxBitrate: kbps * 1000, maxFramerate: 30, priority: 'medium', networkPriority: 'medium' }, 'maintain-resolution');
  }

  onTrack(e) {
    const index = this.pc.getTransceivers().indexOf(e.transceiver);
    const track = e.track;
    if (index === SCREEN) {
      this.screen = new MediaStream([track]);
    } else {
      if (!this.stream.getTracks().includes(track)) this.stream.addTrack(track);
      if (track.kind === 'audio') {
        this.audio.addTrack(track);
        this.mgr.meter.watch(this.deviceId, track);
      }
    }
    // Muted means no media is arriving: a camera that's off, or a stall.
    track.onmute = () => this.mgr.onChange();
    track.onunmute = () => this.mgr.onChange();
    this.mgr.onChange();
  }

  onState() {
    const s = this.pc.connectionState;
    this.state = s;
    if (s === 'connected') {
      clearTimeout(this.retry);
      this.retry = null;
      this.restarts = 0;
      this.gaveUp = false;
      this.mgr.peerConnected(this);
    } else if (s === 'disconnected') {
      // Often comes back on its own; if not, start over.
      this.restartSoon(2500);
      this.mgr.peerTrouble();
    } else if (s === 'failed') {
      this.restartSoon(0);
      this.mgr.peerTrouble();
    }
    this.mgr.onChange();
  }

  restartSoon(ms) {
    if (this.retry || this.closed) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.closed || this.pc.connectionState === 'connected') return;
      this.restartIce();
      // Keep trying while it stays down.
      this.restartSoon(5000);
    }, ms);
  }

  async restartIce() {
    if (this.closed) return;
    if (++this.restarts > MAX_RESTARTS) {
      this.gaveUp = true;
      this.mgr.peerFailed(this);
      return;
    }
    if (!this.initiator) {
      this.send({ restart: true });
      return;
    }
    const pc = this.pc;
    // An offer that never got its answer is taken back first.
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    if (pc.restartIce) pc.restartIce();
    else this.negotiate();
  }

  message(msg) {
    if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  sendState() {
    const call = this.call;
    this.message({ t: 'state', muted: call.muted, cameraOff: call.cameraOff, sharing: call.sharing });
  }

  onMessage(raw) {
    if (typeof raw !== 'string' || raw.length > 2000) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m?.t === 'state') {
      this.remote = { muted: !!m.muted, cameraOff: !!m.cameraOff, sharing: !!m.sharing, known: true };
      this.mgr.onChange();
    } else if (m?.t === 'react' && REACTIONS.includes(m.emoji)) {
      this.mgr.onReaction(this, m.emoji);
    }
  }

  // Their camera video, when it's on and arriving.
  get video() {
    const track = this.stream.getVideoTracks()[0];
    return track && track.readyState === 'live' && !track.muted && !this.remote.cameraOff ? track : null;
  }

  get sharing() {
    const track = this.screen?.getVideoTracks()[0];
    return !!track && track.readyState === 'live' && !track.muted && this.remote.sharing;
  }

  get speaking() {
    return (this.mgr.meter.levels.get(this.deviceId) || 0) > SPEAKING;
  }
}

async function setParams(sender, encoding, degradation) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    Object.assign(params.encodings[0], encoding);
    if (degradation) params.degradationPreference = degradation;
    await sender.setParameters(params);
  } catch {
    try {
      // Some browsers refuse a part of it; the bitrate matters most.
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      params.encodings[0].maxBitrate = encoding.maxBitrate;
      await sender.setParameters(params);
    } catch {
      // the browser keeps its own settings
    }
  }
}

// ---------- voice levels ----------

class Meter {
  constructor() {
    this.ctx = null;
    this.nodes = new Map(); // key -> { src, analyser, buf }
    this.levels = new Map(); // key -> 0..1
  }

  watch(key, track) {
    this.unwatch(key);
    if (!track) return;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx ??= new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      this.nodes.set(key, { src, analyser, buf: new Float32Array(analyser.fftSize) });
    } catch {
      // no levels: the call works the same without the rings
    }
  }

  unwatch(key) {
    const n = this.nodes.get(key);
    if (!n) return;
    n.src.disconnect();
    this.nodes.delete(key);
    this.levels.delete(key);
  }

  sample() {
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    for (const [key, n] of this.nodes) {
      n.analyser.getFloatTimeDomainData(n.buf);
      this.levels.set(key, nextLevel(this.levels.get(key) || 0, rms(n.buf)));
    }
  }

  clear() {
    for (const key of [...this.nodes.keys()]) this.unwatch(key);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
