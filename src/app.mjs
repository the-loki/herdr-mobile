// Wires the pieces into one runnable service. `main.mjs` is the thin CLI on top.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { EventBridge } from './bridge.mjs';
import { HerdrClient } from './herdr.mjs';
import { createServer } from './server.mjs';

export const DEFAULT_WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

export function createApp({ config, webRoot = DEFAULT_WEB_ROOT }) {
  const client = new HerdrClient({ socketPath: config.socketPath });
  const api = createApi({ client });
  const { server, broadcast, close: closeServer } = createServer({
    api,
    token: config.token,
    webRoot,
    secureCookies: Boolean(config.publicUrl?.startsWith('https://')),
  });
  const bridge = new EventBridge({ client, onFrame: (frame) => broadcast(frame) });

  return {
    server,
    url: pairingUrl({ host: config.host, port: config.port, token: config.token, publicUrl: config.publicUrl }),
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      bridge.start().catch(() => {});
      return server.address();
    },
    async close() {
      bridge.stop();
      await closeServer();
    },
    broadcast,
  };
}

/** The link you tap on the phone: it carries the token once, then becomes a cookie. */
export function pairingUrl({ host, port, token, publicUrl }) {
  const base = publicUrl ?? `http://${displayHost(host)}:${port}`;
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/?token=${encodeURIComponent(token)}`;
}

/** A wildcard bind is reachable as localhost from the same machine. */
export function displayHost(host) {
  if (!host || host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}
