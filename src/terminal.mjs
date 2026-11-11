// The live terminal: herdr hands a client the pane's own screen as ANSI frames
// through a subprocess (`herdr terminal session observe <pane> --cols --rows`),
// not through the socket API. One JSON object per line:
//
//   {"type":"terminal.frame","seq":1,"encoding":"ansi","width":60,"height":12,
//    "full":true,"bytes":"<base64 ANSI>"}
//   {"type":"terminal.closed","reason":"…"}
//
// `observe` is read-only and does not resize the pane, so the person at the desk
// keeps their own terminal: verified by measuring a 100-column ruler in a pane
// before, during and after an observer at 40x10 (container/probe5.mjs). That is
// why reads watch and never take over; writes keep going through pane.send_text
// and pane.send_keys.
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// A phone asks for something narrow, a desktop for something wide; anything far
// outside real terminals is a bug or an attack, not a layout.
export const GEOMETRY = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200 };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 12 * 1024 * 1024;

/** Clamp a requested viewport into something a terminal can actually be. */
export function parseGeometry(query) {
  const cols = toInt(query?.get?.('cols') ?? query?.cols, 80);
  const rows = toInt(query?.get?.('rows') ?? query?.rows, 24);
  if (cols === null || rows === null) throw new RangeError('cols and rows must be integers');
  return {
    cols: Math.min(GEOMETRY.maxCols, Math.max(GEOMETRY.minCols, cols)),
    rows: Math.min(GEOMETRY.maxRows, Math.max(GEOMETRY.minRows, rows)),
  };
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

/**
 * One observer of one pane. Emits `frame`, `error` and `closed`; `stop()` is the
 * only way out, and it always kills the child.
 */
export class PaneTerminal extends EventEmitter {
  constructor({ paneId, cols = 80, rows = 24, bin = 'herdr', spawn = nodeSpawn, env = process.env, maxFrames } = {}) {
    super();
    if (!paneId) throw new TypeError('paneId is required');
    this.paneId = paneId;
    this.cols = cols;
    this.rows = rows;
    this.bin = bin;
    this.spawn = spawn;
    this.env = env;
    this.maxFrames = maxFrames;
    this.frames = 0;
    this.child = null;
    this.buffer = '';
    this.stopped = false;
  }

  start() {
    if (this.child || this.stopped) return this;
    const args = ['terminal', 'session', 'observe', this.paneId, '--cols', String(this.cols), '--rows', String(this.rows)];
    let child;
    try {
      child = this.spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
    } catch (error) {
      queueMicrotask(() => this.fail(error));
      return this;
    }
    this.child = child;
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this.consume(chunk));
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.lastStderr = text.slice(0, 2000);
    });
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => {
      if (this.stopped) return;
      this.stopped = true;
      this.child = null;
      this.emit('closed', { reason: this.lastStderr || (signal ? `signal ${signal}` : `exit ${code}`) });
    });
    return this;
  }

  /** Feed raw stdout; split into lines and turn each into a frame. */
  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) {
      // A stream we cannot parse is worse than no stream: keep the newest tail
      // and let the next full repaint fix the screen.
      const keep = this.buffer.lastIndexOf('\n');
      this.buffer = keep === -1 ? '' : this.buffer.slice(keep + 1);
      this.emit('error', new Error('terminal stream line too long'));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // half-written or foreign output: ignore, the next frame repaints
    }
    if (message?.type === 'terminal.closed') {
      this.stop();
      this.emit('closed', { reason: String(message.reason ?? 'herdr closed the terminal').slice(0, 200) });
      return;
    }
    if (message?.type !== 'terminal.frame') return;
    const frame = normalizeFrame(message);
    if (!frame) return;
    this.frames += 1;
    if (this.maxFrames && this.frames > this.maxFrames) {
      this.fail(new Error(`terminal sent more than ${this.maxFrames} frames`));
      return;
    }
    this.emit('frame', frame);
  }

  fail(error) {
    if (this.stopped) return;
    this.emit('error', error);
    this.stop();
  }

  stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.buffer = '';
  }
}

/** Accept only a frame we can hand to a terminal emulator unexamined. */
function normalizeFrame(message) {
  const bytes = message.bytes;
  if (typeof bytes !== 'string' || bytes.length > MAX_FRAME_BYTES) return null;
  if (bytes && !/^[A-Za-z0-9+/=\s]*$/.test(bytes)) return null;
  const width = Number(message.width);
  const height = Number(message.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    seq: Number.isFinite(Number(message.seq)) ? Number(message.seq) : null,
    encoding: typeof message.encoding === 'string' ? message.encoding : 'ansi',
    width: Math.trunc(width),
    height: Math.trunc(height),
    full: Boolean(message.full),
    bytes,
  };
}
