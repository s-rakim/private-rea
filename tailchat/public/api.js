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
export class Realtime {
  constructor(api, { onEvent, onOpen, onStatus }) {
    this.api = api;
    this.onEvent = onEvent;
    this.onOpen = onOpen;
    this.onStatus = onStatus;
    this.backoff = 500;
    this.queue = [];
    this.stopped = false;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.api.token }));
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        this.backoff = 500;
        this.onStatus?.(true);
        for (const m of this.queue.splice(0)) ws.send(m);
        this.onOpen?.();
        return;
      }
      this.onEvent(msg);
    };
    ws.onclose = (e) => {
      this.onStatus?.(false);
      if (this.stopped) return;
      if (e.code === 4003) {
        this.onEvent({ type: 'auth-failed' });
        return;
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    };
  }

  send(msg) {
    const data = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (msg.type !== 'typing') this.queue.push(data);
  }

  stop() {
    this.stopped = true;
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
