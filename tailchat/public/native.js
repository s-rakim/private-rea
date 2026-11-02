// The Android app runs Tailchat in a WebView and adds what a web page can't
// do on its own: ringing over other apps and the lock screen, keeping a
// call going while you use another app, and picture-in-picture. Its script
// sets window.TailchatApp before this page loads. In a browser there is no
// TailchatApp and everything here does nothing.

const bridge = typeof window !== 'undefined' && window.TailchatApp && typeof window.TailchatApp.post === 'function' ? window.TailchatApp : null;

export const app = bridge ? { platform: String(bridge.platform || 'android'), version: Number(bridge.version) || 1 } : null;

// What the app has been allowed to do, as it last told us.
export const status = { overlay: null, fullScreen: null, notifications: null, background: null, battery: null, pip: null };

const handlers = new Map(); // type -> Set of functions

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
}

if (bridge) {
  // The app delivers its messages as a DOM event on window.
  window.addEventListener('tailchat-native', (e) => {
    const msg = e.detail;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type === 'status') Object.assign(status, msg.status || {});
    for (const fn of handlers.get(msg.type) || []) {
      try {
        fn(msg);
      } catch (err) {
        console.warn('app message failed', err);
      }
    }
  });
  post('hello');
}
