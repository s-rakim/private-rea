// The Android app runs Tailchat in a WebView and adds what a web page can't
// do on its own: ringing with the phone's ringtone, calls that pop up over
// other apps and fill the lock screen, keeping a call going while you use
// another app, picture in picture, and message notifications with Reply.
// Its script sets window.TailchatApp before this page loads. In a browser
// there is no TailchatApp and everything here does nothing.

const bridge = typeof window !== 'undefined' && window.TailchatApp && typeof window.TailchatApp.post === 'function' ? window.TailchatApp : null;

export const app = bridge ? { platform: String(bridge.platform || 'android'), version: Number(bridge.version) || 1 } : null;

// What the app has been allowed to do, as it last told us.
export const status = { overlay: null, fullScreen: null, notifications: null, background: null, battery: null, pip: null };

const handlers = new Map(); // type -> Set of functions

// Messages that came before anything here listened for them, such as a tap
// on a notification that opened the app: they wait a little for a listener.
const early = [];
const EARLY_MS = 60_000;

export function post(type, data = {}) {
  if (!bridge) return;
  try {
    bridge.post({ type, ...data });
  } catch {
    // the app went away
  }
}

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  const now = Date.now();
  for (let i = 0; i < early.length; i++) {
    const { msg, at } = early[i];
    if (msg.type !== type) continue;
    early.splice(i--, 1);
    if (now - at < EARLY_MS) deliver(fn, msg);
  }
}

function deliver(fn, msg) {
  try {
    fn(msg);
  } catch (err) {
    console.warn('app message failed', err);
  }
}

if (bridge) {
  // The app delivers its messages as a DOM event on window.
  window.addEventListener('tailchat-native', (e) => {
    const msg = e.detail;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type === 'status') Object.assign(status, msg.status || {});
    const fns = handlers.get(msg.type);
    if (!fns?.size) {
      if (msg.type !== 'status') early.push({ msg, at: Date.now() });
      if (early.length > 30) early.shift();
      return;
    }
    for (const fn of fns) deliver(fn, msg);
  });
  post('hello');
}
