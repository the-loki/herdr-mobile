// Probe 4: herdr's live terminal frame stream (terminal session observe/control).
//
// wherdr (github.com/derekr/wherdr) documents this as a subprocess NDJSON protocol
// on 0.7.2+: ANSI frames, base64 inside JSON, `full` vs delta, and a resize
// command. This checks it on the version we target.
//
//   node container/probe4.mjs
import { spawn } from 'node:child_process';
import { HerdrClient } from '../src/herdr.mjs';

const socketPath = process.env.HERDR_SOCKET_PATH ?? '/root/.config/herdr/herdr.sock';
const client = new HerdrClient({ socketPath, timeoutMs: 20000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const created = await client.rpc('workspace.create', { cwd: '/tmp', label: 'frames', focus: false });
const pane = created.root_pane.pane_id;
await client.rpc('pane.send_input', {
  pane_id: pane,
  text: `printf '\\033[31mRED\\033[0m plain\\n'; sleep 0.4; printf '\\033[42mGREENBG\\033[0m done\\n'`,
  keys: ['Enter'],
});
await sleep(1200);

const report = { pane, frames: [], control: {} };

function observe(mode, { onFrame, command }) {
  const args = ['terminal', 'session', mode, pane, '--cols', '40', '--rows', '10'];
  if (mode === 'control') args.push('--takeover');
  const child = spawn('herdr', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      onFrame(frame);
    }
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  if (command) child.stdin.write(JSON.stringify(command) + '\n');
  return {
    child,
    stderr: () => stderr,
    send: (message) => child.stdin.write(JSON.stringify(message) + '\n'),
    stop: () => child.kill('SIGTERM'),
  };
}

// --- read-only observe -------------------------------------------------------
const observed = observe('observe', {
  onFrame(frame) {
    if (report.frames.length >= 6 && frame.type !== 'terminal.closed') return;
    const decoded = frame.bytes ? Buffer.from(frame.bytes, 'base64').toString('utf8') : '';
    report.frames.push({
      type: frame.type,
      seq: frame.seq,
      encoding: frame.encoding,
      size: `${frame.width}x${frame.height}`,
      full: frame.full,
      bytes: frame.bytes?.length ?? 0,
      hasSgr: /\u001b\[[0-9;]*m/.test(decoded),
      hasCursorHome: decoded.includes('\u001b[H'),
      hasSyncGuard: decoded.includes('\u001b[?2026h'),
      containsRed: decoded.includes('RED'),
      containsGreenBg: /\u001b\[[0-9;]*48;5;2|42/.test(decoded),
      sample: decoded.replace(/\u001b/g, 'ESC').slice(0, 120),
    });
  },
});
await sleep(1500);
observed.stop();
report.observeStderr = observed.stderr().slice(0, 200);

// --- control: input + resize ------------------------------------------------
const controlled = observe('control', {
  onFrame(frame) {
    if (frame.type === 'terminal.frame') {
      report.control.frames = (report.control.frames ?? 0) + 1;
      report.control.lastSize = `${frame.width}x${frame.height}`;
      const text = Buffer.from(frame.bytes ?? '', 'base64').toString('utf8');
      if (text.includes('FROM-CONTROL')) report.control.sawTypedEcho = true;
    }
  },
});
await sleep(500);
controlled.send({ type: 'terminal.resize', cols: 60, rows: 20 });
await sleep(400);
controlled.send({ type: 'terminal.input', text: 'echo FROM-CONTROL\r' });
await sleep(1200);
controlled.stop();
await sleep(200);

await client.rpc('workspace.close', { workspace_id: created.workspace.workspace_id });
console.log(JSON.stringify(report, null, 1));
