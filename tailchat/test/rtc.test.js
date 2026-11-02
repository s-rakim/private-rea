// The parts of a call that are plain functions: quality settings, the Opus
// settings in a session description, codec order, connection statistics and
// voice levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITIES, DEFAULT_QUALITY, quality, videoConstraints, audioConstraints, videoKbps, audioKbps,
  tuneOpus, codecScores, orderCodecs, readStats, grade, resolutionLabel, rms, nextLevel, SPEAKING, REACTIONS,
} from '../public/rtc.js';

test('the best quality asks the camera for 4K, and unknown keys fall back to it', () => {
  assert.equal(DEFAULT_QUALITY, 'best');
  assert.deepEqual([QUALITIES.best.width, QUALITIES.best.height], [3840, 2160]);
  assert.equal(quality('nonsense'), QUALITIES.best);
  const c = videoConstraints('best', { facing: 'environment' });
  assert.deepEqual(c.width, { ideal: 3840 });
  assert.deepEqual(c.height, { ideal: 2160 });
  assert.deepEqual(c.facingMode, { ideal: 'environment' });
  // A chosen camera replaces the facing mode.
  const d = videoConstraints('hd', { deviceId: 'cam-2' });
  assert.deepEqual(d.deviceId, { exact: 'cam-2' });
  assert.equal(d.facingMode, undefined);
  assert.deepEqual(d.width, { ideal: 1280 });
});

test('voice keeps echo cancelling on; original sound turns it off and goes stereo', () => {
  const voice = audioConstraints('voice');
  assert.equal(voice.echoCancellation, true);
  assert.equal(voice.noiseSuppression, true);
  assert.deepEqual(voice.channelCount, { ideal: 1 });
  const music = audioConstraints('music', 'mic-1');
  assert.equal(music.echoCancellation, false);
  assert.equal(music.autoGainControl, false);
  assert.deepEqual(music.channelCount, { ideal: 2 });
  assert.deepEqual(music.deviceId, { exact: 'mic-1' });
});

test('bitrates: video is shared out between devices down to a floor, HD audio is full band', () => {
  assert.equal(videoKbps('best', 1), 16000);
  assert.equal(videoKbps('best', 4), 4000);
  assert.equal(videoKbps('best', 20), 1200);
  assert.equal(videoKbps('saver', 5), 500); // never more than the quality allows
  assert.equal(audioKbps({ hd: true }), 128);
  assert.equal(audioKbps({ hd: true, mode: 'music' }), 192);
  assert.equal(audioKbps({ hd: false, mode: 'music' }), 40);
});

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:0 PCMU/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n');

test('tuneOpus sets stereo, a high bitrate and error correction, and leaves the rest alone', () => {
  const out = tuneOpus(SDP, { kbps: 192 });
  const fmtp = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111 '));
  const params = Object.fromEntries(fmtp.slice('a=fmtp:111 '.length).split(';').map((p) => p.split('=')));
  assert.equal(params.stereo, '1');
  assert.equal(params['sprop-stereo'], '1');
  assert.equal(params.maxaveragebitrate, '192000');
  assert.equal(params.useinbandfec, '1');
  assert.equal(params.usedtx, '0');
  assert.equal(params.minptime, '10');
  assert.ok(out.includes('a=fmtp:63 111/111'), 'other formats are untouched');
  assert.ok(out.includes('a=rtpmap:96 VP8/90000'));
  // Mono when asked, and an Opus line without parameters gets them.
  const bare = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n', '');
  const added = tuneOpus(bare, { stereo: false, kbps: 64 });
  const line = added.split('\r\n').find((l) => l.startsWith('a=fmtp:111 '));
  assert.ok(line.includes('stereo=0') && line.includes('maxaveragebitrate=64000'), line);
  assert.equal(tuneOpus(null), null);
  assert.equal(tuneOpus('v=0\r\nm=video 9 RTP 96\r\n'), 'v=0\r\nm=video 9 RTP 96\r\n');
});

test('codecs: one the device encodes in hardware wins, an unsupported one goes last', () => {
  const plain = codecScores({});
  assert.ok(plain['video/vp9'] > plain['video/h264'] && plain['video/h264'] > plain['video/vp8']);
  const hw = codecScores({ 'video/h264': { supported: true, smooth: true, powerEfficient: true }, 'video/av1': { supported: false } });
  assert.ok(hw['video/h264'] > hw['video/vp9']);
  assert.ok(hw['video/av1'] < hw['video/vp8']);
  const caps = [
    { mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }, { mimeType: 'video/H264', sdpFmtpLine: 'a' },
    { mimeType: 'video/VP9' }, { mimeType: 'video/ulpfec' }, { mimeType: 'video/H264', sdpFmtpLine: 'b' }, { mimeType: 'video/AV1' },
  ];
  const order = orderCodecs(caps, hw).map((c) => c.mimeType + (c.sdpFmtpLine || ''));
  assert.deepEqual(order, ['video/H264a', 'video/H264b', 'video/VP9', 'video/VP8', 'video/AV1', 'video/rtx', 'video/ulpfec']);
});

function report(entries) {
  return new Map(entries.map((e) => [e.id, e]));
}

test('readStats reads sizes, bitrates, loss and the route from a stats report', () => {
  const first = readStats(report([
    { id: 'in-v', type: 'inbound-rtp', kind: 'video', bytesReceived: 1_000_000, packetsLost: 0, packetsReceived: 1000, timestamp: 1000, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 29.6, codecId: 'c-vp9' },
    { id: 'in-s', type: 'inbound-rtp', kind: 'video', bytesReceived: 0, timestamp: 1000 }, // the screen, not shared
    { id: 'out-a', type: 'outbound-rtp', kind: 'audio', bytesSent: 10_000, timestamp: 1000, codecId: 'c-opus' },
    { id: 'c-vp9', type: 'codec', mimeType: 'video/VP9' },
    { id: 'c-opus', type: 'codec', mimeType: 'audio/opus' },
    { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
    { id: 'p', type: 'candidate-pair', currentRoundTripTime: 0.012, localCandidateId: 'l', remoteCandidateId: 'r' },
    { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
    { id: 'r', type: 'remote-candidate', candidateType: 'host', address: '100.64.0.7' },
  ]));
  assert.equal(first.video.in.width, 3840);
  assert.equal(first.video.in.fps, 30);
  assert.equal(first.video.in.codec, 'VP9');
  assert.equal(first.video.in.kbps, null, 'no bitrate from a single report');
  assert.equal(first.rtt, 12);
  assert.deepEqual(first.path, { local: 'host', remote: 'host', protocol: 'udp', address: '100.64.0.7', relayed: false });
  const second = readStats(report([
    { id: 'in-v', type: 'inbound-rtp', kind: 'video', bytesReceived: 3_000_000, packetsLost: 10, packetsReceived: 1990, timestamp: 3000, frameWidth: 3840, frameHeight: 2160 },
    { id: 'out-a', type: 'outbound-rtp', kind: 'audio', bytesSent: 42_000, timestamp: 3000 },
  ]), first);
  assert.equal(second.video.in.kbps, 8000); // 2 MB in 2 s
  assert.equal(second.audio.out.kbps, 128);
  assert.equal(second.loss, 1); // 10 lost of 1000
});

test('grades and resolution labels', () => {
  assert.equal(grade({}), 'unknown');
  assert.equal(grade({ rtt: 30, loss: 0 }), 'good');
  assert.equal(grade({ rtt: 300, loss: 0 }), 'fair');
  assert.equal(grade({ rtt: 30, loss: 15 }), 'poor');
  assert.equal(resolutionLabel(3840, 2160), '4K');
  assert.equal(resolutionLabel(2160, 3840), '4K'); // a phone held upright
  assert.equal(resolutionLabel(1920, 1080), '1080p');
  assert.equal(resolutionLabel(1280, 720), '720p');
  assert.equal(resolutionLabel(640, 360), '360p');
  assert.equal(resolutionLabel(0, 0), '');
});

test('voice levels rise at once and fall slowly', () => {
  assert.equal(rms(new Float32Array([0, 0, 0])), 0);
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-9);
  const loud = nextLevel(0, 0.25); // about -12 dBFS
  assert.ok(loud > 0.95 && loud <= 1);
  assert.ok(loud > SPEAKING);
  const after = nextLevel(loud, 0);
  assert.ok(after < loud && after > loud * 0.8, 'falls gradually');
  assert.equal(nextLevel(0, 0.0005), 0); // below -60 dBFS is silence
  assert.ok(REACTIONS.includes('👍'));
});
