// Configuration: where the herdr socket is, where this plugin keeps its token,
// and which address the web client listens on.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 7777;

/**
 * Socket resolution mirrors herdr's own order: explicit flag, then the
 * injected env of a plugin/pane, then a named session, then the default socket.
 */
export function resolveSocketPath({ explicit, env = process.env, home = os.homedir() } = {}) {
  if (explicit) return explicit;
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (env.HERDR_SESSION) {
    return path.join(env.HERDR_CONFIG_DIR ?? path.join(home, '.config', 'herdr'), 'sessions', env.HERDR_SESSION, 'herdr.sock');
  }
  return path.join(env.HERDR_CONFIG_DIR ?? path.join(home, '.config', 'herdr'), 'herdr.sock');
}

export function resolveDataDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.HERDR_PLUGIN_STATE_DIR) return env.HERDR_PLUGIN_STATE_DIR;
  if (env.HERDR_PLUGIN_CONFIG_DIR) return env.HERDR_PLUGIN_CONFIG_DIR;
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(stateHome, 'herdr-mobile');
}

/** Create the pairing token on first use; later starts reuse it. */
export function loadOrCreateToken(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'token');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export function loadConfig(argv = [], env = process.env, home = os.homedir()) {
  const args = parseArgs(argv);
  const dataDir = args['data-dir'] ?? resolveDataDir({ env, home });
  return {
    port: Number(args.port ?? env.HERDR_MOBILE_PORT ?? DEFAULT_PORT),
    host: args.host ?? env.HERDR_MOBILE_HOST ?? '127.0.0.1',
    dataDir,
    socketPath: resolveSocketPath({ explicit: args.socket, env, home }),
    token: args.token ?? loadOrCreateToken(dataDir),
    publicUrl: args['public-url'] ?? env.HERDR_MOBILE_PUBLIC_URL ?? undefined,
    webRoot: args['web-root'],
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

export { parseArgs };
