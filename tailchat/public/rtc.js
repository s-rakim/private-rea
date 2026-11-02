// The parts of a call that don't touch the page: video sizes and bitrates
// for each quality, how the audio is encoded, which video codec to prefer
// and what the connection statistics say. calls.js puts them to work; they
// are plain functions so the tests can run them in Node.

// Video quality. The camera is asked for this size and frame rate ("ideal",
// so a camera that can't do it gives its nearest) and the encoder is allowed
// up to this bitrate, shared out when several devices are in the call.
export const QUALITIES = {
  best: { label: 'Best, up to 4K', short: '4K', width: 3840, height: 2160, fps: 30, kbps: 16000 },
  fhd: { label: 'Full HD, 1080p', short: '1080p', width: 1920, height: 1080, fps: 30, kbps: 6000 },
  hd: { label: 'HD, 720p', short: '720p', width: 1280, height: 720, fps: 30, kbps: 2500 },
  saver: { label: 'Data saver', short: '360p', width: 640, height: 360, fps: 24, kbps: 500 },
};
export const DEFAULT_QUALITY = 'best';

export const quality = (key) => QUALITIES[key] || QUALITIES[DEFAULT_QUALITY];

export function videoConstraints(key, { facing = 'user', deviceId } = {}) {
  const q = quality(key);
  return {
    width: { ideal: q.width },
    height: { ideal: q.height },
    frameRate: { ideal: q.fps, max: 60 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } }),
  };
}

// Voice: the browser's echo cancelling, noise suppression and level control.
// Original sound (for music, or a good microphone in a quiet room) turns all
// three off and keeps stereo.
export function audioConstraints(mode = 'voice', deviceId) {
  const music = mode === 'music';
  return {
    echoCancellation: !music,
    noiseSuppression: !music,
    autoGainControl: !music,
    channelCount: { ideal: music ? 2 : 1 },
    sampleRate: { ideal: 48000 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

// Each device sends its own copy of the video to every other device, so the
// bitrate is shared between them, down to a floor that still looks good.
export function videoKbps(key, peers = 1) {
  const q = quality(key);
  const floor = Math.min(q.kbps, 1200);
  return Math.max(floor, Math.round(q.kbps / Math.max(1, peers)));
}

// Opus at 128 kbit/s is full-band, studio-like voice; original sound gets
// more for stereo music. Without HD audio it's about what phone apps use.
export function audioKbps({ hd = true, mode = 'voice' } = {}) {
  if (!hd) return 40;
  return mode === 'music' ? 192 : 128;
}
export const OPUS_MAX_KBPS = 192;

// Opus settings for a session description: stereo, a high average bitrate,
// in-band error correction and no silence suppression. The parameters on an
// Opus format line say how the device that wrote it wants to receive, and
// the other side's encoder follows them, so Tailchat applies them to the
// description it receives: that sets how this device sends. The actual
// bitrate is then set per call with RTCRtpSender.setParameters.
export function tuneOpus(sdp, { stereo = true, kbps = OPUS_MAX_KBPS } = {}) {
  if (typeof sdp !== 'string') return sdp;
  const lines = sdp.split(/\r?\n/);
  const opus = new Set();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m) opus.add(m[1]);
  }
  if (!opus.size) return sdp;
  const want = {
    minptime: '10',
    useinbandfec: '1',
    usedtx: '0',
    stereo: stereo ? '1' : '0',
    'sprop-stereo': stereo ? '1' : '0',
    maxaveragebitrate: String(Math.round(kbps * 1000)),
    maxplaybackrate: '48000',
  };
  const tuned = new Set();
  const out = [];
  for (const line of lines) {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (m && opus.has(m[1])) {
      tuned.add(m[1]);
      const params = new Map();
      for (const part of m[2].split(';')) {
        const p = part.trim();
        if (!p) continue;
        const i = p.indexOf('=');
        params.set(i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1));
      }
      for (const [k, v] of Object.entries(want)) params.set(k, v);
      out.push(`a=fmtp:${m[1]} ${[...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')}`);
      continue;
    }
    out.push(line);
    // An Opus format with no parameters line gets one, right after its rtpmap.
    const r = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (r && !lines.some((l) => l.startsWith(`a=fmtp:${r[1]} `))) {
      tuned.add(r[1]);
      out.push(`a=fmtp:${r[1]} ${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';')}`);
    }
  }
  return out.join('\r\n');
}

// How much Tailchat likes each video codec when it knows nothing about the
// hardware: VP9 looks best for its bitrate in software, AV1 is better still
// but heavy without a hardware encoder.
const CODEC_BASE = { 'video/vp9': 1.5, 'video/av1': 1.2, 'video/h264': 1, 'video/vp8': 0.5 };
export const RATED_CODECS = Object.keys(CODEC_BASE);

// info: mimeType (lower case) -> { supported, smooth, powerEfficient }, from
// navigator.mediaCapabilities.encodingInfo where the browser has it. A codec
// the device encodes in hardware wins: smoother at 4K and easier on the
// battery.
export function codecScores(info = {}) {
  const scores = {};
  for (const [mime, base] of Object.entries(CODEC_BASE)) {
    const i = info[mime];
    if (i && i.supported === false) scores[mime] = -10;
    else scores[mime] = base + (i?.powerEfficient ? 4 : 0) + (i?.smooth ? 2 : 0);
  }
  return scores;
}

// Orders codec capabilities for RTCRtpTransceiver.setCodecPreferences: the
// best scored video codecs first, everything else (other codecs, and the
// retransmission and error-correction formats) after them as they were.
export function orderCodecs(codecs, scores) {
  const helper = (c) => /\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType);
  const score = (c) => scores[c.mimeType.toLowerCase()] ?? -5;
  const media = codecs
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !helper(c))
    .sort((a, b) => score(b.c) - score(a.c) || a.i - b.i)
    .map(({ c }) => c);
  return [...media, ...codecs.filter(helper)];
}

// ---------- statistics ----------

// Reads an RTCStatsReport (or any Map of stats) into what the call screen
// shows: the size, frame rate, codec and bitrate of the video and audio each
// way, the round trip time, packet loss and how the devices are connected.
// prev is the previous result, for bitrates and loss over the interval.
export function readStats(report, prev = null) {
  const all = new Map();
  report.forEach((s) => all.set(s.id, s));
  const counters = new Map();
  const out = { video: { in: null, out: null }, audio: { in: null, out: null }, rtt: null, loss: null, path: null, counters };
  let lost = 0;
  let received = 0;
  for (const s of all.values()) {
    if (s.type !== 'inbound-rtp' && s.type !== 'outbound-rtp') continue;
    const kind = s.kind || s.mediaType;
    if (kind !== 'video' && kind !== 'audio') continue;
    const dir = s.type === 'inbound-rtp' ? 'in' : 'out';
    const bytes = (dir === 'in' ? s.bytesReceived : s.bytesSent) || 0;
    const before = prev?.counters.get(s.id);
    counters.set(s.id, { bytes, ts: s.timestamp, lost: s.packetsLost || 0, received: s.packetsReceived || 0 });
    const kbps = before && s.timestamp > before.ts ? Math.max(0, Math.round(((bytes - before.bytes) * 8) / (s.timestamp - before.ts))) : null;
    if (dir === 'in' && before) {
      lost += Math.max(0, (s.packetsLost || 0) - before.lost);
      received += Math.max(0, (s.packetsReceived || 0) - before.received);
    }
    const codec = all.get(s.codecId)?.mimeType?.split('/')[1] || null;
    const entry = {
      kbps,
      codec,
      width: s.frameWidth || null,
      height: s.frameHeight || null,
      fps: s.framesPerSecond != null ? Math.round(s.framesPerSecond) : null,
      limited: s.qualityLimitationReason && s.qualityLimitationReason !== 'none' ? s.qualityLimitationReason : null,
    };
    // Camera and screen are both video: show the busier one.
    const slot = out[kind];
    const weight = (e) => (e.width || 0) * (e.height || 0) + (e.kbps || 0);
    if (!slot[dir] || weight(entry) > weight(slot[dir])) slot[dir] = entry;
  }
  if (lost + received > 0) out.loss = Math.round((lost / (lost + received)) * 1000) / 10;

  let pair = null;
  for (const s of all.values()) {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = all.get(s.selectedCandidatePairId) || pair;
  }
  if (!pair) {
    for (const s of all.values()) if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  }
  if (pair) {
    if (pair.currentRoundTripTime != null) out.rtt = Math.round(pair.currentRoundTripTime * 1000);
    const local = all.get(pair.localCandidateId);
    const remote = all.get(pair.remoteCandidateId);
    out.path = {
      local: local?.candidateType || null,
      remote: remote?.candidateType || null,
      protocol: local?.protocol || null,
      address: remote?.address || remote?.ip || null,
      relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
    };
  }
  return out;
}

// good, fair or poor, from the round trip time and packet loss.
export function grade({ rtt, loss } = {}) {
  if (rtt == null && loss == null) return 'unknown';
  if ((rtt ?? 0) > 600 || (loss ?? 0) > 12) return 'poor';
  if ((rtt ?? 0) > 250 || (loss ?? 0) > 4) return 'fair';
  return 'good';
}

// 4K, 1080p, 720p, ... from a frame size, landscape or portrait.
export function resolutionLabel(width, height) {
  if (!width || !height) return '';
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (short >= 2160 || long >= 3840) return '4K';
  if (short >= 1440) return '1440p';
  if (short >= 1080) return '1080p';
  if (short >= 720) return '720p';
  return `${short}p`;
}

// ---------- voice level ----------

export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

// A level from 0 to 1 for the speaking rings: -60 dBFS and below is silence,
// -12 dBFS and above is full. It rises at once and falls slowly, so the
// rings don't flicker between words.
export function nextLevel(prev, value, fall = 0.82) {
  const db = value > 0 ? 20 * Math.log10(value) : -100;
  const unit = Math.min(1, Math.max(0, (db + 60) / 48));
  return Math.max(unit, prev * fall);
}

export const SPEAKING = 0.32;

// Reactions people can send in a call; anything else is dropped.
export const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉', '🔥', '🙏'];
