// REST client, realtime socket and this device's key storage.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Api {
  constructor() {
    this.token = null;
  }

  async call(method, url, body) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    } catch {
      throw new ApiError(0, 'Can\'t reach Tailchat. Check that this device is connected to your tailnet.');
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
    return data;
  }

  get = (url) => this.call('GET', url);
  post = (url, body = {}) => this.call('POST', url, body);
  patch = (url, body) => this.call('PATCH', url, body);
  put = (url, body) => this.call('PUT', url, body);
  del = (url) => this.call('DELETE', url);

  // XHR rather than fetch: it reports upload progress.
  upload(blob, { isPublic = false, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/files${isPublic ? '?public=1' : ''}`);
      xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // fall through
        }
        if (xhr.status === 200) resolve(data);
        else reject(new ApiError(xhr.status, data?.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Upload failed: connection lost'));
      xhr.send(blob);
    });
  }

  download(fileId, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `/api/files/${encodeURIComponent(fileId)}`);
      xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.responseType = 'arraybuffer';
      xhr.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => (xhr.status === 200 ? resolve(xhr.response) : reject(new ApiError(xhr.status, 'This file is no longer available')));
      xhr.onerror = () => reject(new ApiError(0, 'Download failed: connection lost'));
      xhr.send();
    });
  }
}

// Reconnecting WebSocket. Events go to onEvent; onOpen fires after every
// (re)connect so the app can catch up on anything it missed.
//
// A connection can die without either end hearing about it: a computer
// waking from sleep, a phone moving between Wi-Fi and mobile data, Tailscale
// reconnecting. The browser then keeps a socket that looks open but gets
// nothing, and no message, call or notification arrives until a reload. So
// the page pings the server every little while, and a socket that doesn't
// answer is dropped and opened again.
const PING_MS = 20_000;
const ANSWER_MS = 8_000;

export class Realtime {
  constructor(api, { onEvent, onOpen, onStatus }) {
    this.api = api;
    this.onEvent = onEvent;
    this.onOpen = onOpen;
    this.onStatus = onStatus;
    this.backoff = 500;
    this.queue = [];
    this.stopped = false;
    this.heardAt = 0; // when the open socket last got anything
    this.pingAt = 0; // when it was last pinged
    this.retry = null;
    this.beat = setInterval(() => this.check(), PING_MS);
  }

  connect() {
    clearTimeout(this.retry);
    this.retry = null;
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    this.ready = false;
    this.heardAt = Date.now();
    this.pingAt = 0;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.api.token }));
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.heardAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'ready') {
        this.backoff = 500;
        this.ready = true;
        this.onStatus?.(true);
        for (const m of this.queue.splice(0)) ws.send(m);
        this.onOpen?.();
        return;
      }
      this.onEvent(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return; // one we already gave up on
      this.ws = null;
      this.ready = false;
      this.onStatus?.(false);
      if (this.stopped) return;
      if (e.code === 4003) {
        this.onEvent({ type: 'auth-failed' });
        return;
      }
      this.later();
    };
  }

  later() {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15_000);
  }

  // Is the connection still alive? Called on a timer, and straight away when
  // the page comes back on screen or the network comes back.
  check() {
    if (this.stopped) return;
    const ws = this.ws;
    if (!ws) {
      // Waiting to reconnect: don't wait out the backoff once you're back.
      if (this.retry && document.visibilityState === 'visible') {
        clearTimeout(this.retry);
        this.retry = null;
        this.backoff = 500;
        this.connect();
      }
      return;
    }
    const now = Date.now();
    // Pinged, and nothing came back in time: this socket is dead.
    if (this.pingAt && this.heardAt < this.pingAt && now - this.pingAt > ANSWER_MS) {
      this.drop(ws);
      return;
    }
    // Still connecting for too long counts the same.
    if (ws.readyState === WebSocket.CONNECTING && now - this.heardAt > PING_MS) {
      this.drop(ws);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN || !this.ready) return;
    if (this.pingAt && this.heardAt < this.pingAt) return; // still waiting for the answer
    this.pingAt = now;
    try {
      ws.send('{"type":"ping"}');
    } catch {
      this.drop(ws);
      return;
    }
    // Check the answer without waiting for the next beat.
    setTimeout(() => this.check(), ANSWER_MS + 500);
  }

  drop(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.ready = false;
    try {
      ws.close();
    } catch {
      // already gone
    }
    this.onStatus?.(false);
    this.backoff = 500;
    this.connect();
  }

  send(msg) {
    const data = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (msg.type !== 'typing') this.queue.push(data);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.beat);
    clearTimeout(this.retry);
    this.ws?.close();
  }
}

// ---------- IndexedDB: this device's identity ----------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tailchat', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvDelete(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
