// Request authentication: one bearer token, accepted from a header, a query
// parameter (the pairing link) or the session cookie it gets exchanged for.
import crypto from 'node:crypto';

const COOKIE_NAME = 'hmw';

export function verifyToken(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual throws on a length mismatch
  return crypto.timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      const name = part.trim();
      if (name) out[name] = '';
      continue;
    }
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function extractToken(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match) return match[1].trim();
  }
  const url = req.url ?? '/';
  const query = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?') + 1);
  const fromQuery = new URLSearchParams(query).get('token');
  if (fromQuery) return fromQuery;
  const cookie = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  return cookie || undefined;
}

export function sessionCookie(token, { secure = false, maxAgeSeconds = 60 * 60 * 24 * 30 } = {}) {
  return cookieHeader(token, maxAgeSeconds, secure);
}

export function clearSessionCookie({ secure = false } = {}) {
  return cookieHeader('', 0, secure);
}

function cookieHeader(value, maxAgeSeconds, secure) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export { COOKIE_NAME };
