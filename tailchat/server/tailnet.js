// Who is on the other end of a connection. Tailchat has no passwords: the
// tailnet already knows who every device belongs to, so identity comes from
// Tailscale.
//
//   serve  - run behind `tailscale serve`. tailscaled terminates HTTPS with the
//            machine's ts.net certificate and adds Tailscale-User-* headers.
//            Only connections from loopback (tailscaled itself) are accepted.
//   direct - listen on the Tailscale IP and ask the local tailscaled who owns
//            the connecting address (LocalAPI whois).
//   dev    - local testing only: pick a user at /dev/login. Loopback only.
import http from 'node:http';
import net from 'node:net';

export class IdentityError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(addr) {
  return LOOPBACK.has(addr);
}

// 100.64.0.0/10 (Tailscale IPv4) and fd7a:115c:a1e0::/48 (Tailscale IPv6).
export function isTailnetAddress(addr) {
  if (!addr) return false;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return net.isIPv6(addr) && addr.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

// Tailscale-User-Name is RFC 2047 encoded when it is not plain ASCII.
export function decodeHeaderWord(value) {
  if (!value) return '';
  return value.replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_, enc, text) => {
    if (enc.toLowerCase() === 'b') return Buffer.from(text, 'base64').toString('utf8');
    const bytes = text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const DEV_USER = /^[a-z0-9._-]{1,32}$/;

export function createIdentityResolver(config) {
  const whoisCache = new Map();

  function whois(addr, port) {
    const key = `${addr}:${port}`;
    const hit = whoisCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.promise;
    const host = net.isIPv6(addr) ? `[${addr}]` : addr;
    const promise = new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: config.tailscaleSocket,
          path: `/localapi/v0/whois?addr=${encodeURIComponent(`${host}:${port}`)}`,
          headers: { Host: 'local-tailscaled.sock' },
          timeout: 3000,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new IdentityError(`tailscaled whois failed (${res.statusCode})`));
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new IdentityError('tailscaled whois returned bad JSON'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new IdentityError('tailscaled whois timed out', 503)));
      req.on('error', (err) => reject(err instanceof IdentityError ? err : new IdentityError(`cannot reach tailscaled: ${err.message}`, 503)));
      req.end();
    });
    whoisCache.set(key, { promise, expires: Date.now() + 60_000 });
    promise.catch(() => whoisCache.delete(key));
    return promise;
  }

  // Returns { login, name, avatarUrl } or throws IdentityError.
  return async function identify(req) {
    const addr = req.socket.remoteAddress;
    if (config.auth === 'serve') {
      if (!isLoopback(addr)) throw new IdentityError('Tailchat only accepts connections through `tailscale serve`.');
      const login = req.headers['tailscale-user-login'];
      if (!login) {
        throw new IdentityError(
          'No Tailscale identity on this request. Open Tailchat at its https://<machine>.<tailnet>.ts.net address from a device signed in to your tailnet (tagged devices have no user identity).',
          401,
        );
      }
      return {
        login: String(login).toLowerCase(),
        name: decodeHeaderWord(req.headers['tailscale-user-name']) || String(login).split('@')[0],
        avatarUrl: req.headers['tailscale-user-profile-pic'] || null,
      };
    }
    if (config.auth === 'direct') {
      if (!isTailnetAddress(addr)) throw new IdentityError('Tailchat only accepts connections from your tailnet.');
      const info = await whois(addr.replace(/^::ffff:/, ''), req.socket.remotePort);
      const profile = info.UserProfile || {};
      if (info.Node?.Tags?.length || !profile.LoginName || profile.LoginName === 'tagged-devices') {
        throw new IdentityError('Tagged devices have no user identity, so they cannot use Tailchat.');
      }
      return {
        login: profile.LoginName.toLowerCase(),
        name: profile.DisplayName || profile.LoginName.split('@')[0],
        avatarUrl: profile.ProfilePicURL || null,
      };
    }
    // dev
    if (!isLoopback(addr)) throw new IdentityError('Dev mode only accepts loopback connections.');
    const user = parseCookies(req.headers.cookie).tailchat_dev_user || req.headers['x-dev-user'];
    if (!user || !DEV_USER.test(user)) throw new IdentityError('Dev mode: pick a user at /dev/login', 401);
    return { login: `${user}@dev`, name: user[0].toUpperCase() + user.slice(1), avatarUrl: null };
  };
}
