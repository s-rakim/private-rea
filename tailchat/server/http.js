// Small HTTP helpers: a path router, JSON bodies and typed errors.
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => {
  throw new HttpError(status, message);
};

export const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readJson(req, limit = 1024 * 1024) {
  const type = req.headers['content-type'] || '';
  // Requiring application/json means a cross-site form post can never reach
  // the API: browsers preflight it, and the server answers no preflights.
  if (!type.startsWith('application/json')) fail(415, 'Expected application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object');
    return value;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    fail(400, 'Malformed JSON');
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
          keys.push(key);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, regex, keys, handler, options });
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// Validation helpers used by the API handlers.
export const str = (value, field, { max = 200, min = 0, optional = false } = {}) => {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(400, `${field} is required`);
  }
  if (typeof value !== 'string') fail(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) fail(400, `${field} is too short`);
  if (trimmed.length > max) fail(400, `${field} is too long (max ${max})`);
  return trimmed;
};

export const int = (value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) => {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(400, `${field} is required`);
  }
  if (!Number.isInteger(value) || value < min || value > max) fail(400, `${field} must be an integer between ${min} and ${max}`);
  return value;
};

export const bool = (value, field, { optional = true } = {}) => {
  if (value === undefined) {
    if (optional) return undefined;
    fail(400, `${field} is required`);
  }
  if (typeof value !== 'boolean') fail(400, `${field} must be true or false`);
  return value;
};
