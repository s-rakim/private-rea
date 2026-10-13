// Voice and video calls: WebRTC between devices, directly across the tailnet.
// Tailscale addresses are reachable from every device, so no STUN or TURN
// servers are configured and media never leaves the tailnet. WebRTC encrypts
// media with DTLS-SRTP on top of WireGuard.
import { newMessageId } from './crypto.js';

const RTC_CONFIG = { iceServers: [], bundlePolicy: 'max-bundle' };

export class CallManager {
  constructor({ realtime, onChange, onIncoming, onEnded }) {
    this.rt = realtime;
    this.onChange = onChange;
    this.onIncoming = onIncoming;
    this.onEnded = onEnded;
    this.call = null; // the call this device is in
    this.incoming = new Map(); // callId -> ring event
  }

  async media(video) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
    });
  }

  newCall(callId, chatId, video, direction) {
    this.call = {
      callId, chatId, video, direction,
      status: direction === 'out' ? 'ringing' : 'connecting',
      startedAt: null, local: null, peers: new Map(), muted: false, cameraOff: !video, sharing: false,
    };
    return this.call;
  }

  async start(chatId, video) {
    if (this.call) throw new Error('You are already in a call');
    const call = this.newCall(newMessageId(), chatId, video, 'out');
    try {
      call.local = await this.media(video);
    } catch (err) {
      this.call = null;
      throw new Error(`Can't use your ${video ? 'camera or microphone' : 'microphone'}: ${err.message}`);
    }
    this.rt.send({ type: 'call', action: 'ring', callId: call.callId, chatId, video });
    this.onChange();
  }

  async accept(callId) {
    const ring = this.incoming.get(callId);
    if (!ring || this.call) return;
    this.incoming.delete(callId);
    const call = this.newCall(callId, ring.chatId, ring.video, 'in');
    try {
      call.local = await this.media(ring.video);
    } catch (err) {
      this.call = null;
      this.rt.send({ type: 'call', action: 'decline', callId });
      throw new Error(`Can't use your microphone or camera: ${err.message}`);
    }
    this.rt.send({ type: 'call', action: 'accept', callId });
    this.onChange();
  }

  decline(callId) {
    this.incoming.delete(callId);
    this.rt.send({ type: 'call', action: 'decline', callId });
    this.onChange();
  }

  hangup() {
    if (!this.call) return;
    this.rt.send({ type: 'call', action: 'hangup', callId: this.call.callId });
    this.cleanup('ended');
  }

  cleanup(reason) {
    const call = this.call;
    if (!call) return;
    for (const p of call.peers.values()) p.pc.close();
    call.local?.getTracks().forEach((t) => t.stop());
    call.screen?.getTracks().forEach((t) => t.stop());
    this.call = null;
    this.onEnded?.(call, reason);
    this.onChange();
  }

  peer(deviceId, userId) {
    const call = this.call;
    let p = call.peers.get(deviceId);
    if (p) return p;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    p = { pc, userId, stream: new MediaStream(), pending: [], state: 'connecting' };
    call.peers.set(deviceId, p);
    for (const track of call.local.getTracks()) pc.addTrack(track, call.local);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(deviceId, { candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (!p.stream.getTracks().includes(e.track)) p.stream.addTrack(e.track);
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      if (pc.connectionState === 'connected' && call.status !== 'active') {
        call.status = 'active';
        call.startedAt ??= Date.now();
      }
      if (pc.connectionState === 'failed') {
        p.state = 'failed';
      }
      this.onChange();
    };
    return p;
  }

  signal(toDevice, data) {
    this.rt.send({ type: 'call', action: 'signal', callId: this.call.callId, toDevice, data });
  }

  async offer(deviceId, userId) {
    const p = this.peer(deviceId, userId);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    this.signal(deviceId, { sdp: p.pc.localDescription.toJSON() });
  }

  async handle(event) {
    const { action, callId } = event;
    if (action === 'ring') {
      this.incoming.set(callId, event);
      this.onIncoming?.(event);
      this.onChange();
      return;
    }
    if (action === 'answered-elsewhere' || (action === 'ended' && this.incoming.has(callId))) {
      this.incoming.delete(callId);
      this.onChange();
      if (action !== 'ended') return;
    }
    const call = this.call;
    if (!call || call.callId !== callId) return;
    switch (action) {
      case 'joined':
        // We just accepted: offer a connection to everyone already in the call.
        call.status = 'connecting';
        for (const peer of event.peers) await this.offer(peer.deviceId, peer.userId);
        break;
      case 'peer-joined':
        call.status = call.status === 'ringing' ? 'connecting' : call.status;
        this.peer(event.deviceId, event.userId);
        break;
      case 'signal': {
        const p = this.peer(event.fromDevice, event.from);
        const { sdp, candidate } = event.data || {};
        if (sdp) {
          await p.pc.setRemoteDescription(sdp);
          for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
          if (sdp.type === 'offer') {
            const answer = await p.pc.createAnswer();
            await p.pc.setLocalDescription(answer);
            this.signal(event.fromDevice, { sdp: p.pc.localDescription.toJSON() });
          }
        } else if (candidate) {
          if (p.pc.remoteDescription) await p.pc.addIceCandidate(candidate).catch(() => {});
          else p.pending.push(candidate);
        }
        break;
      }
      case 'peer-left': {
        const p = call.peers.get(event.deviceId);
        p?.pc.close();
        call.peers.delete(event.deviceId);
        break;
      }
      case 'declined':
        call.declined = (call.declined || 0) + 1;
        break;
      case 'ended':
      case 'error':
        this.cleanup(event.reason || event.message || 'ended');
        return;
      default:
        break;
    }
    this.onChange();
  }

  toggleMute() {
    const call = this.call;
    if (!call) return;
    call.muted = !call.muted;
    call.local.getAudioTracks().forEach((t) => (t.enabled = !call.muted));
    this.onChange();
  }

  async toggleCamera() {
    const call = this.call;
    if (!call) return;
    let track = call.local.getVideoTracks()[0];
    if (!track) {
      // An audio call can turn into a video call.
      const cam = await navigator.mediaDevices.getUserMedia({ video: true });
      track = cam.getVideoTracks()[0];
      call.local.addTrack(track);
      for (const [deviceId, p] of call.peers) {
        p.pc.addTrack(track, call.local);
        await this.offer(deviceId, p.userId);
      }
      call.cameraOff = false;
      call.video = true;
    } else {
      call.cameraOff = !call.cameraOff;
      track.enabled = !call.cameraOff;
    }
    this.onChange();
  }

  async toggleScreen() {
    const call = this.call;
    if (!call) return;
    const camTrack = call.local.getVideoTracks()[0] || null;
    const replace = async (track) => {
      for (const p of call.peers.values()) {
        const sender = p.pc.getSenders().find((s) => s.track?.kind === 'video' || (!s.track && track));
        if (sender) await sender.replaceTrack(track);
      }
    };
    if (call.sharing) {
      call.screen?.getTracks().forEach((t) => t.stop());
      call.screen = null;
      call.sharing = false;
      await replace(camTrack);
    } else {
      if (!camTrack) {
        throw new Error('Turn your camera on first, then share your screen');
      }
      call.screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = call.screen.getVideoTracks()[0];
      screenTrack.onended = () => call.sharing && this.toggleScreen();
      call.sharing = true;
      await replace(screenTrack);
    }
    this.onChange();
  }
}
