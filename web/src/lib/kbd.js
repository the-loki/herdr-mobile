// One physical key → one thing to send to the pane.
//
// The composer is no longer a buffer that is posted when you finish: every key
// goes to the agent as you press it, so the agent's own completion menu, inline
// validation and multi-step dialogs appear live. This module is the pure mapping
// between a DOM keyboard event and a herdr call; the component only does I/O.
//
// herdr's key grammar (verified against 0.9.5): special keys Up/Down/Left/Right/
// Tab/Enter/Escape/Space/Backspace, F1–F12, modifier chords like `ctrl+c` /
// `alt+Up` / `shift+tab`, and a bare character for a literal keystroke. There is
// no Home/End/PageUp/PageDown/Delete.

const NAMED = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

const UNSUPPORTED = new Set(['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'F13', 'F14', 'F15']);

/**
 * @returns {{kind: 'text', text: string} | {kind: 'keys', keys: string[]} | null}
 *   null means "nothing to send": a modifier-only press, an IME in progress, or a
 *   key herdr cannot express.
 */
export function keyToAction(event) {
  const { key } = event;
  if (!key || key === 'Process' || key === 'Dead' || key === 'Unidentified' || key === 'Compose') return null;

  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const meta = Boolean(event.metaKey);
  const shift = Boolean(event.shiftKey);
  const named = NAMED[key];

  if (ctrl || alt || meta) {
    // Chords are sent as keys, never as text: the agent interprets them.
    if (named) return { kind: 'keys', keys: [chord(event, named)] };
    if (key.length === 1) return { kind: 'keys', keys: [chord(event, key)] };
    return null;
  }

  if (named) {
    if (shift && (named === 'Tab' || named === 'Enter')) return { kind: 'keys', keys: [`shift+${named.toLowerCase()}`] };
    if (shift) return { kind: 'keys', keys: [`shift+${named.toLowerCase()}`] };
    return { kind: 'keys', keys: [named] };
  }

  if (UNSUPPORTED.has(key)) return null;

  // A single printable character is typed, not pasted: herdr's send_text is what
  // makes an agent's completion menu open.
  if (key.length === 1) return { kind: 'text', text: key };
  return null;
}

function chord(event, base) {
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('cmd');
  parts.push(base.length === 1 ? base.toLowerCase() : base);
  return parts.join('+');
}

/** Paste and IME commits arrive as a whole string; they are typed in one call. */
export function textToAction(text) {
  if (!text) return null;
  return { kind: 'text', text };
}
