// Call sounds: the trill you hear while the other side rings, the ringtone
// for an incoming call, the call-waiting beeps and short chimes for
// connecting and hanging up. They are made on the spot with Web Audio, so
// there are no sound files and nothing is fetched.

let ctx = null;
let master = null;
let idle = null;
const loops = new Map(); // name -> { bus, timer, buzz }

function audio() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  clearTimeout(idle);
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// A quiet audio context is put to sleep, so it doesn't keep the phone's
// sound hardware awake between calls.
function sleepSoon() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (!loops.size && ctx?.state === 'running') ctx.suspend().catch(() => {});
  }, 4000);
}

// Browsers only allow sound once the page has been touched. The first tap
// or key press wakes the audio, so a call that comes in later can ring.
export function unlockAudio() {
  if (audio()) sleepSoon();
}
if (typeof addEventListener === 'function') {
  const once = () => {
    unlockAudio();
    for (const ev of ['pointerdown', 'keydown']) removeEventListener(ev, once, true);
  };
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, once, true);
}

function bus(c) {
  const g = c.createGain();
  g.gain.value = 1;
  g.connect(master);
  return g;
}

// A steady tone made of one or more sine waves, with soft edges.
function tone(c, out, at, dur, freqs, level) {
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(level, at + 0.015);
  g.gain.setValueAtTime(level, at + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, at + dur);
  g.connect(out);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(at);
    o.stop(at + dur + 0.05);
  }
}

// A struck, glassy note: a fundamental with a little octave and twelfth,
// fading out like a marimba bar.
function bell(c, out, at, f, level, decay = 0.9) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  g.connect(out);
  for (const [mult, amp] of [[1, 1], [2, 0.3], [3.01, 0.08]]) {
    const o = c.createOscillator();
    const og = c.createGain();
    o.frequency.value = f * mult;
    og.gain.value = amp;
    o.connect(og);
    og.connect(g);
    o.start(at);
    o.stop(at + decay + 0.05);
  }
}

// A repeating sound. Notes are scheduled a little ahead on the audio clock,
// so a busy page doesn't make the rhythm stumble.
function loop(name, period, pattern, buzz) {
  stop(name);
  const c = audio();
  if (!c) return;
  const out = bus(c);
  let next = c.currentTime + 0.05;
  const schedule = () => {
    if (next < c.currentTime) next = c.currentTime + 0.05;
    while (next < c.currentTime + 1.5) {
      pattern(c, out, next);
      next += period;
    }
  };
  schedule();
  const entry = { bus: out, timer: setInterval(schedule, 300), buzz: null };
  if (buzz && navigator.vibrate) {
    const shake = () => navigator.vibrate(buzz);
    shake();
    entry.buzz = setInterval(shake, period * 1000);
  }
  loops.set(name, entry);
}

function once(pattern) {
  const c = audio();
  if (!c) return;
  const out = bus(c);
  pattern(c, out, c.currentTime + 0.03);
  setTimeout(() => out.disconnect(), 3000);
  sleepSoon();
}

export function stop(name) {
  const entry = loops.get(name);
  if (!entry) return;
  loops.delete(name);
  clearInterval(entry.timer);
  if (entry.buzz) {
    clearInterval(entry.buzz);
    navigator.vibrate?.(0);
  }
  if (ctx) {
    entry.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    setTimeout(() => entry.bus.disconnect(), 300);
  }
  sleepSoon();
}

export function stopAll() {
  for (const name of [...loops.keys()]) stop(name);
}

export const playing = (name) => loops.has(name);

// Outgoing: two tones, 400 and 450 Hz, beating against each other into a
// trill, rung twice and then a pause.
export function ringback() {
  loop('ringback', 3, (c, out, t) => {
    tone(c, out, t, 0.4, [400, 450], 0.13);
    tone(c, out, t + 0.6, 0.4, [400, 450], 0.13);
  });
}

// Incoming: a rising arpeggio and an answer, every 2.4 seconds, with the
// phone buzzing along where it can.
export function ringtone({ sound = true, vibrate = true } = {}) {
  if (!sound && !vibrate) return;
  loop('ringtone', 2.4, (c, out, t) => {
    if (!sound) return;
    [659.25, 830.61, 987.77, 1318.51].forEach((f, i) => bell(c, out, t + i * 0.12, f, 0.22));
    bell(c, out, t + 0.72, 1244.51, 0.2);
    bell(c, out, t + 0.86, 987.77, 0.24, 1.2);
  }, vibrate ? [450, 250, 450] : null);
}

// A second call while you're in one: two soft beeps every few seconds.
export function waiting() {
  loop('waiting', 4, (c, out, t) => {
    tone(c, out, t, 0.16, [440], 0.1);
    tone(c, out, t + 0.3, 0.16, [440], 0.1);
  });
}

export function connected() {
  once((c, out, t) => {
    bell(c, out, t, 1046.5, 0.16, 0.5);
    bell(c, out, t + 0.1, 1567.98, 0.16, 0.7);
  });
}

export function ended() {
  once((c, out, t) => {
    bell(c, out, t, 783.99, 0.14, 0.5);
    bell(c, out, t + 0.14, 523.25, 0.14, 0.8);
  });
}

// Declined or busy: three short beeps.
export function busy() {
  once((c, out, t) => {
    for (let i = 0; i < 3; i++) tone(c, out, t + i * 0.5, 0.25, [480, 620], 0.1);
  });
}
