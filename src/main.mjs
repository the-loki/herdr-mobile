#!/usr/bin/env node
// Entry point: serve the Herdr web client. Runs identically in a plugin pane,
// under systemd, or by hand.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, DEFAULT_WEB_ROOT } from './app.mjs';
import { loadConfig } from './config.mjs';

const HELP = `herdr-mobile-web — a web client (desktop and phone) for your Herdr session

Usage: node src/main.mjs [options]

  --port <n>          Listen port (default 7777, env HERDR_MOBILE_PORT)
  --host <addr>       Bind address (default 127.0.0.1; use 0.0.0.0 for a phone)
  --socket <path>     Herdr socket (default $HERDR_SOCKET_PATH or ~/.config/herdr/herdr.sock)
  --data-dir <path>   Where the pairing token lives (default under XDG state)
  --public-url <url>  Address to print in the pairing link (a Tailscale or proxy URL)
  --token <value>     Fixed token, instead of the generated one
  --web-root <path>   Built web assets (default web/dist)
  --help              This text
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig(argv);
  const webRoot = typeof config.webRoot === 'string' ? config.webRoot : DEFAULT_WEB_ROOT;
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    process.stderr.write(
      [
        `  The web client is not built: ${path.join(webRoot, 'index.html')} is missing.`,
        '',
        '  Build it once:',
        '    npm --prefix web install',
        '    npm --prefix web run build',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  const app = createApp({ config, webRoot });
  const address = await app.start();
  const url = app.url;

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config.dataDir, 'url.txt'), url + '\n', { mode: 0o600 });

  process.stdout.write(
    [
      '',
      '  herdr web client is up',
      `  listening  ${config.host}:${address.port}`,
      `  herdr      ${config.socketPath}`,
      `  token file ${path.join(config.dataDir, 'token')}`,
      '',
      `  open this link on your phone or computer:`,
      `  ${url}`,
      '',
    ].join('\n'),
  );
  printQr(url);

  if (config.host === '127.0.0.1') {
    process.stdout.write('  reachable from this machine only; pass --host 0.0.0.0 (Tailscale or a TLS proxy) for a phone\n\n');
  }

  const shutdown = async (signal) => {
    process.stdout.write(`\n  ${signal}: shutting down\n`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printQr(url) {
  const qr = spawnSync('qrencode', ['-t', 'ansiutf8', '-m', '1', url], { encoding: 'utf8' });
  if (qr.status === 0 && qr.stdout.trim()) process.stdout.write(qr.stdout + '\n');
}

main().catch((error) => {
  process.stderr.write(`herdr web client failed: ${error.message}\n`);
  process.exit(1);
});
