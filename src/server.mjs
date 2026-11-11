// HTTP transport: token gate, JSON API, static app shell, and an SSE stream
// that pokes the browser when herdr state changes.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { clearSessionCookie, extractToken, parseCookies, sessionCookie, verifyToken } from './auth.mjs';
import { GEOMETRY, PaneTerminal, parseGeometry } from './terminal.mjs';

const MAX_BODY = 256 * 1024;
const HEARTBEAT_MS = 25000;
const PANE_ID = /^[A-Za-z0-9_.:@-]{1,64}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
  'cache-control': 'no-store',
};

export function createServer({
  api,
  token,
  webRoot,
  secureCookies = false,
  herdrBin = process.env.HERDR_BIN ?? 'herdr',
  spawnTerminal = (options) => new PaneTerminal(options),
}) {
  const streams = new Set();
  const terminals = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      sendJson(res, 500, { error: { code: 'internal_error', message: error.message } });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // The pairing link is `/?token=…`, so the shell request must exchange it
    // for the cookie too, not only the API requests behind it.
    const queryToken = url.searchParams.get('token');
    if (req.method === 'GET' && queryToken && verifyToken(queryToken, token)) {
      res.setHeader('set-cookie', sessionCookie(token, { secure: secureCookies }));
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorized(req)) return unauthorized(req, res);
      return openStream(req, res);
    }

    if (pathname.startsWith('/api/')) {
      if (!authorized(req)) return unauthorized(req, res);
      const terminal = terminalRoute(pathname);
      if (terminal === 'invalid') return sendJson(res, 400, { error: { code: 'invalid_params', message: 'unusable pane id' } });
      if (terminal && req.method === 'GET') return openTerminal(req, res, terminal, url);
      if (terminal) return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'the terminal stream is a GET' } });
      return handleApi(req, res, url, pathname);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} is not supported here` } });
    }
    return serveStatic(req, res, pathname);
  }

  function authorized(req) {
    return verifyToken(extractToken(req), token);
  }

  function unauthorized(req, res) {
    if (parseCookies(req.headers.cookie).hmw) res.setHeader('set-cookie', clearSessionCookie({ secure: secureCookies }));
    sendJson(res, 401, { error: { code: 'unauthorized', message: 'a valid pairing token is required' } });
  }

  async function handleApi(req, res, url, pathname) {
    let body;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.includes('application/json')) {
        return sendJson(res, 415, { error: { code: 'unsupported_media_type', message: 'send application/json' } });
      }
      const read = await readBody(req);
      if (read.tooLarge) return sendJson(res, 413, { error: { code: 'payload_too_large', message: `body over ${MAX_BODY} bytes` } });
      if (read.invalid) return sendJson(res, 400, { error: { code: 'invalid_json', message: read.invalid } });
      body = read.value;
    }
    const result = await api.handle({ method: req.method, path: pathname, query: url.searchParams, body });
    sendJson(res, result.status, result.body);
  }

  function openStream(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const stream = { res, heartbeat: setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS) };
    streams.add(stream);
    const drop = () => {
      clearInterval(stream.heartbeat);
      streams.delete(stream);
    };
    req.on('close', drop);
    res.on('error', drop);
  }

  // `/api/pane/<id>/terminal?cols=&rows=` — the pane's own screen as ANSI frames.
  // Reading a terminal never resizes the pane, so the person at the desk is not
  // disturbed by someone watching on a phone (see src/terminal.mjs).
  async function openTerminal(req, res, paneId, url) {
    let geometry;
    try {
      geometry = parseGeometry(url.searchParams);
    } catch (error) {
      return sendJson(res, 400, { error: { code: 'invalid_params', message: error.message } });
    }
    // Prefer the pane's own size: `observe` crops to what it is given, so the
    // client's phone viewport would cut lines instead of showing them.
    if (typeof api.paneGeometry === 'function') {
      try {
        const actual = await api.paneGeometry(paneId);
        if (actual) geometry = { cols: Math.min(GEOMETRY.maxCols, Math.max(GEOMETRY.minCols, actual.cols)), rows: Math.min(GEOMETRY.maxRows, Math.max(GEOMETRY.minRows, actual.rows)) };
      } catch {
        /* a snapshot we cannot read is not a reason to refuse the stream */
      }
    }
    let terminal;
    try {
      terminal = spawnTerminal({ paneId, ...geometry, bin: herdrBin });
    } catch (error) {
      return sendJson(res, 500, { error: { code: 'terminal_unavailable', message: error.message } });
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = (reason) => {
      clearInterval(heartbeat);
      terminals.delete(entry);
      send('closed', { reason });
      if (!res.writableEnded) res.end();
    };
    const entry = { terminal, finish };
    terminals.add(entry);

    terminal.on('frame', (frame) => send('frame', frame));
    terminal.on('error', (error) => {
      send('error', { message: error.message });
      finish(error.message);
    });
    terminal.on('closed', (info) => finish(info?.reason ?? 'closed'));
    req.on('close', () => {
      clearInterval(heartbeat);
      terminals.delete(entry);
      terminal.stop();
    });
    res.on('error', () => terminal.stop());
    terminal.start();
  }

  function serveStatic(req, res, pathname) {
    const segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0'))) {
      return sendText(res, 404, 'not found');
    }
    const relative = segments.length ? segments.join('/') : 'index.html';
    const file = path.resolve(webRoot, relative);
    if (!file.startsWith(path.resolve(webRoot) + path.sep) && file !== path.resolve(webRoot, 'index.html')) {
      return sendText(res, 404, 'not found');
    }
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      return sendText(res, 404, 'not found');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  function broadcast(frame) {
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const stream of streams) {
      try {
        stream.res.write(payload);
      } catch {
        streams.delete(stream);
      }
    }
  }

  async function close() {
    for (const stream of streams) {
      clearInterval(stream.heartbeat);
      stream.res.end();
    }
    streams.clear();
    for (const entry of terminals) entry.terminal.stop();
    terminals.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, broadcast, close, streamCount: () => streams.size, terminalCount: () => terminals.size };
}

/** `/api/pane/w1:p1/terminal` → `w1:p1`, or null when it is another route. */
function terminalRoute(pathname) {
  const match = /^\/api\/pane\/([^/]+)\/terminal$/.exec(pathname);
  if (!match) return null;
  let paneId;
  try {
    paneId = decodeURIComponent(match[1]);
  } catch {
    return 'invalid';
  }
  return PANE_ID.test(paneId) ? paneId : 'invalid';
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk); // keep draining past the cap so the reply can be read
    });
    req.on('end', () => {
      if (size > MAX_BODY) return resolve({ tooLarge: true });
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({ value: {} });
      try {
        resolve({ value: JSON.parse(raw) });
      } catch (error) {
        resolve({ invalid: error.message });
      }
    });
    req.on('error', (error) => resolve({ invalid: error.message }));
  });
}

function sendJson(res, status, body) {
  if (res.headersSent) return res.end();
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendText(res, status, text) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
