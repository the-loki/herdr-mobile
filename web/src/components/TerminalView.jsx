// A real terminal for a pane, fed by herdr's own frame stream.
//
// herdr already emulated the application and hands out the result as ANSI
// frames over a subprocess (`terminal session observe`, see src/terminal.mjs).
// So this is not a mirror of someone's screen: xterm renders the same cells the
// pane has, with colours and glyphs, and reading it never resizes the pane.
//
// Two facts shape this component:
//   - `observe` *crops* to the viewport it is given, it does not reflow, so the
//     server asks for the pane's own size (from herdr's layout) and we never ask
//     for a phone-sized viewport that would cut the right side off.
//   - therefore the column count is fixed by the pane, and the only thing that
//     adapts to a phone is the font: down to a readable floor, and past it the
//     screen scrolls sideways rather than turning into unreadable 5px text.
//
// When the stream cannot start (no herdr on PATH in a plugin pane, an older
// herdr without the bridge), the caller falls back to the polled text view
// instead of showing an empty box.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const FIRST_FRAME_TIMEOUT_MS = 4000;
const MIN_FONT = 8;
const MAX_FONT = 15;

/** base64 → bytes, because the server forwards herdr's frames untouched. */
function decodeFrame(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The screen as lines, for the text fallback, menus and screen readers. */
function bufferLines(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

export function TerminalView({ paneId, onScreen, onState, className = '' }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const [screen, setScreen] = useState('');
  const [state, setState] = useState('connecting');

  // Keep the callbacks out of the connection effect's dependencies, so a parent
  // re-render does not tear the stream down.
  const screenRef = useRef(onScreen);
  screenRef.current = onScreen;
  const stateRef = useRef(onState);
  stateRef.current = onState;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !paneId) return undefined;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: false,
      disableStdin: true, // watching is not typing: replies go through the box below
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      theme: {
        background: '#0b0f14',
        foreground: '#d7dee8',
        cursor: '#7cc4ff',
        selectionBackground: '#2a3a4d',
      },
      scrollback: 5000,
      allowProposedApi: true,
    });
    term.open(host);
    termRef.current = term;

    const syncScreen = () => {
      const text = bufferLines(term).join('\n');
      setScreen(text);
      screenRef.current?.(text);
    };

    /**
     * One column count to rule the screen; only the font adapts. Shrinking text
     * stops at MIN_FONT — below that the pane stays legible and pans sideways.
     */
    const fitFont = () => {
      const container = host.parentElement ?? host;
      const available = Math.max(0, (container.clientWidth || host.clientWidth) - 12);
      const screenNode = host.querySelector('.xterm-screen');
      const rendered = screenNode?.getBoundingClientRect().width ?? 0;
      if (!available || !rendered || !term.cols) return;
      const cellNow = rendered / term.cols;
      const cellWanted = available / term.cols;
      const scaled = Math.round(((term.options.fontSize ?? 12) * cellWanted) / cellNow);
      const next = Math.min(MAX_FONT, Math.max(MIN_FONT, scaled));
      if (next !== term.options.fontSize) term.options.fontSize = next;
    };

    const publish = (next) => {
      setState(next);
      stateRef.current?.(next);
    };

    let closed = false;
    const source = new EventSource(`/api/pane/${encodeURIComponent(paneId)}/terminal`, {
      withCredentials: true,
    });

    let frames = 0;
    const firstFrame = setTimeout(() => {
      if (frames === 0 && !closed) {
        // No frames: the bridge is missing on this host. Let the caller fall
        // back to the text view instead of staring at an empty rectangle.
        source.close();
        publish('unavailable');
      }
    }, FIRST_FRAME_TIMEOUT_MS);

    source.addEventListener('frame', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      frames += 1;
      if (frames === 1) {
        clearTimeout(firstFrame);
        publish('live');
      }
      // The frame is the pane at its own size; matching it is what keeps lines
      // from wrapping in the wrong place.
      if (frame.width && frame.height && (frame.width !== term.cols || frame.height !== term.rows)) {
        term.resize(frame.width, frame.height);
        fitFont();
      }
      term.write(decodeFrame(frame.bytes), syncScreen);
    });

    const end = (reason) => {
      clearTimeout(firstFrame);
      source.close();
      publish(frames > 0 ? 'closed' : 'unavailable');
      if (frames > 0) term.write(`\r\n\x1b[2m[${reason}]\x1b[0m\r\n`, syncScreen);
    };

    source.addEventListener('error', (event) => {
      let reason = 'the terminal stream ended';
      try {
        reason = JSON.parse(event.data)?.message ?? reason;
      } catch {
        /* an unnamed transport error */
      }
      end(reason);
    });
    source.addEventListener('closed', (event) => {
      let reason = 'herdr closed this terminal';
      try {
        reason = JSON.parse(event.data)?.reason ?? reason;
      } catch {
        /* keep the default */
      }
      end(reason);
    });

    // The window changes: only the font follows, the columns belong to the pane.
    const observer = new ResizeObserver(() => fitFont());
    observer.observe(host.parentElement ?? host);

    return () => {
      closed = true;
      clearTimeout(firstFrame);
      observer.disconnect();
      source.close();
      term.dispose();
      termRef.current = null;
    };
  }, [paneId]);

  return (
    <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#0b0f14] ${className}`}>
      <div
        ref={hostRef}
        data-testid="terminal"
        className="min-h-0 flex-1 overflow-auto overscroll-contain px-1.5 py-1"
      />
      {/* The same screen as text: menus and taps have something to read, and a
          screenshot test can tell what the pane is showing. */}
      <pre data-testid="terminal-screen" aria-hidden="true" className="sr-only">
        {screen}
      </pre>
      {state === 'unavailable' ? (
        <div className="absolute inset-x-0 bottom-0 bg-raised/90 px-3 py-2 text-[11px] text-muted">
          这个宿主的 herdr 没有终端帧桥（需要 0.7.2+，且 herdr 在 PATH 里），已退回文本视图。
        </div>
      ) : null}
    </div>
  );
}
