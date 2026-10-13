// WebSocket fan-out: pushes new messages, receipts, presence and typing to
// every connected device, and relays call signalling between devices.
import { WebSocketServer } from 'ws';

export class Hub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.byUser = new Map(); // userId -> Set<ws>
    this.onConnect = () => {};
    this.onDisconnect = () => {};
    this.onMessage = () => {};
    this.onSocketClosed = () => {};
    const ping = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);
    ping.unref();
    this.wss.on('close', () => clearInterval(ping));
  }

  // `authenticate(token)` resolves to a device row for the identified user or
  // throws; the socket is only registered once its first frame authenticates.
  accept(req, socket, head, identity, authenticate) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      const timer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);
      ws.once('message', async (raw) => {
        clearTimeout(timer);
        let device;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== 'auth') throw new Error('expected auth');
          device = await authenticate(msg.token, identity);
        } catch {
          ws.close(4003, 'auth failed');
          return;
        }
        ws.userId = device.user_id;
        ws.deviceId = device.id;
        let set = this.byUser.get(ws.userId);
        const first = !set || set.size === 0;
        if (!set) this.byUser.set(ws.userId, (set = new Set()));
        set.add(ws);
        ws.send(JSON.stringify({ type: 'ready', deviceId: device.id }));
        if (first) this.onConnect(ws.userId);
        ws.on('message', (data) => {
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          try {
            this.onMessage(ws, msg);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          }
        });
        ws.on('close', () => {
          set.delete(ws);
          if (this.closed) return; // shutting down: the database is gone
          this.onSocketClosed(ws);
          if (set.size === 0) this.onDisconnect(ws.userId);
        });
      });
    });
  }

  isOnline(userId) {
    return (this.byUser.get(userId)?.size || 0) > 0;
  }

  sendToUser(userId, event, { exceptDevice, onlyDevice } = {}) {
    const set = this.byUser.get(userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const ws of set) {
      if (exceptDevice && ws.deviceId === exceptDevice) continue;
      if (onlyDevice && ws.deviceId !== onlyDevice) continue;
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  sendToUsers(userIds, event, options) {
    for (const id of new Set(userIds)) this.sendToUser(id, event, options);
  }

  revokeDevice(deviceId) {
    for (const set of this.byUser.values()) {
      for (const ws of set) if (ws.deviceId === deviceId) ws.close(4003, 'device revoked');
    }
  }

  close() {
    this.closed = true;
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
