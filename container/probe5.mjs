// Probe 5: does `terminal session observe --cols/--rows` disturb the real pane?
//
// afloury/wherdr's lab notes say a *second viewer* sets the terminal size and herdr
// then shows a top-left cut-out, and that only `control --takeover` (then released)
// gives the size back. If plain `observe` with our own geometry also resizes the
// operator's pane, the whole "real terminal in a modal" plan needs a different
// default. So measure it: the pane prints a known-width ruler, we record the pane's
// own size and the ruler, observe at 40x10, then record again.
//
//   node container/probe5.mjs
import { spawn } from 'node:child_process';
import { HerdrClient } from '../src/herdr.mjs';

const socketPath = process.env.HERDR_SOCKET_PATH ?? '/root/.config/herdr/herdr.sock';
const client = new HerdrClient({ socketPath, timeoutMs: 20000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const created = await client.rpc('workspace.create', { cwd: '/tmp', label: 'geometry', focus: false });
const pane = created.root_pane.pane_id;

// A 100-column ruler, then a still screen (no further output).
await client.rpc('pane.send_input', {
  pane_id: pane,
  text: `clear; python3 -c "print(''.join(str(i%10) for i in range(1,101)))"; sleep 600`,
  keys: ['Enter'],
});
await sleep(2000);

async function snapshot(label) {
  const info = await client.rpc('pane.get', { pane_id: pane });
  const read = await client.rpc('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
  const lines = String(read.read?.text ?? '').split('\n');
  return {
    label,
    paneCols: info.pane?.cols ?? info.pane?.width ?? info.cols,
    paneRows: info.pane?.rows ?? info.pane?.height ?? info.rows,
    paneKeys: Object.keys(info.pane ?? {}).filter((key) => /col|row|width|height|size/.test(key)),
    readRevision: read.read?.revision,
    rulerWidth: lines.find((line) => /^[0-9]{20,}$/.test(line.trim()))?.trim().length ?? 0,
    lastLine: lines.filter((line) => line.trim()).slice(-1)[0]?.slice(0, 60),
  };
}

const report = [];
report.push(await snapshot('before'));

// Observe at 40x10 — our phone-ish geometry — while the pane stays quiet.
const child = spawn('herdr', ['terminal', 'session', 'observe', pane, '--cols', '40', '--rows', '10'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let frames = 0;
let frameSize = '';
child.stdout.setEncoding('utf8');
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const frame = JSON.parse(line);
      if (frame.type === 'terminal.frame') {
        frames += 1;
        frameSize = `${frame.width}x${frame.height}`;
      }
    } catch {
      /* ignore */
    }
  }
});
await sleep(1500);
report.push(await snapshot('while observing at 40x10'));
report.push({ label: 'observer', frames, frameSize });

child.kill('SIGTERM');
await sleep(1200);
report.push(await snapshot('after observer closed'));

await client.rpc('workspace.close', { workspace_id: created.workspace.workspace_id });
console.log(JSON.stringify(report, null, 1));
