// Runtime settings, all from environment variables so the server can run as a
// systemd unit next to tailscaled without a config file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export function loadConfig(env = process.env) {
  const auth = env.TAILCHAT_AUTH || 'serve';
  if (!['serve', 'direct', 'dev'].includes(auth)) {
    throw new Error(`TAILCHAT_AUTH must be serve, direct or dev, got "${auth}"`);
  }
  // serve and dev only ever accept connections from this machine: in serve
  // mode tailscaled is the only client, and dev mode must never be reachable
  // from the network because anyone could pick any identity.
  const defaultHost = auth === 'direct' ? '' : '127.0.0.1';
  const host = env.TAILCHAT_HOST ?? defaultHost;
  if (auth === 'dev' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('TAILCHAT_AUTH=dev only listens on loopback (set TAILCHAT_HOST=127.0.0.1)');
  }
  if (auth === 'direct' && !host) {
    throw new Error('TAILCHAT_AUTH=direct needs TAILCHAT_HOST set to this machine\'s Tailscale IP (tailscale ip -4)');
  }
  return {
    auth,
    host,
    port: int('TAILCHAT_PORT', 8443),
    dataDir: path.resolve(env.TAILCHAT_DATA || path.join(root, 'data')),
    publicDir: path.join(root, 'public'),
    tlsCert: env.TAILCHAT_TLS_CERT || '',
    tlsKey: env.TAILCHAT_TLS_KEY || '',
    tailscaleSocket: env.TAILSCALE_SOCKET || '/var/run/tailscale/tailscaled.sock',
    maxUploadBytes: int('TAILCHAT_MAX_UPLOAD_MB', 2048) * 1024 * 1024,
    statusHours: int('TAILCHAT_STATUS_HOURS', 24),
    editWindowSeconds: int('TAILCHAT_EDIT_WINDOW_S', 15 * 60),
    deleteWindowSeconds: int('TAILCHAT_DELETE_WINDOW_S', 2 * 24 * 3600),
  };
}
