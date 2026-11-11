// Turning a tap on the rendered pane into the keystrokes the TUI expects.
//
// Agent TUIs draw their menus as text: a highlighted row (`→`, `❯`, `>`), maybe
// numbers, maybe checkboxes. Nobody can click those from a phone, and a fixed
// key strip cannot know which row you meant. This module reads the drawn menu
// and plans the arrow/digit/space presses that land on the row you tapped.
// Pure functions: no DOM, so the whole thing is unit-testable.

const MARKERS = '→❯▶▸>»';
const MARKER_RE = new RegExp(`^\\s*([${MARKERS}])\\s+(.*)$`);
const NUMBER_RE = /^(\d{1,2})[.)]\s+(.*)$/;
const CHECKBOX_RE = /^(\[[ xX✓✗]\]|[◉○◯●])\s*(.*)$/;
const CONFIRM_RE = /(\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[Y\/n\]|\[y\/N\])/i;
const QUESTION_HINT_RE = /(\?|continue|proceed|allow|overwrite|delete|run)\b/i;

/** Lines drawn inside a menu block that are not choices: counters, key hints, captions. */
function isMenuChrome(label) {
  return /^\(/.test(label) || label.includes('·') || /^[A-Za-z][\w ]{0,24}:/.test(label);
}

/** Split into lines, keeping indices stable so a tap maps back to its row. */
export function toRows(text) {
  return String(text ?? '').split('\n');
}

function stripIndent(line) {
  return line.replace(/^\s+/, '');
}

/** Pull apart one drawn menu row, or return null when the line is not one. */
function readOptionRow(line, row) {
  let rest = line;
  let marker = null;
  const marked = MARKER_RE.exec(rest);
  if (marked) {
    marker = marked[1];
    rest = `  ${marked[2]}`; // keep the indent shape so the next steps behave the same
  }

  const indent = /^\s+/.test(rest);
  let body = stripIndent(rest);
  let number = null;
  const numbered = NUMBER_RE.exec(body);
  if (numbered) {
    number = Number(numbered[1]);
    body = numbered[2];
  }

  let checked;
  const boxed = CHECKBOX_RE.exec(body);
  if (boxed) {
    checked = /[xX✓◉●]/.test(boxed[1]);
    body = boxed[2];
  }

  const split = /\s{2,}/.exec(body);
  let label = body;
  let description = '';
  if (split) {
    label = body.slice(0, split.index);
    description = body.slice(split.index).trim();
  }
  label = label.trim();

  // A row belongs to a menu block if it is marked, numbered, or simply indented
  // under a marked row (pi indents its option rows by four spaces). Whether it
  // is *choosable* is decided by `significant` below: a `(1/36)` counter or a
  // footer hint sits inside the block but is not an option.
  if (!label || (!indent && marker === null && number === null)) return null;
  if (!/[A-Za-z0-9]/.test(label)) return null;

  return { row, label, description, marker, number, checked };
}

/**
 * Read the pane as either a list of options, a yes/no confirmation, or nothing.
 * A list wins: a dialog that asks a question and lists choices is a list.
 */
export function parsePaneUi(text) {
  const rows = toRows(text);
  const candidates = [];
  for (let row = 0; row < rows.length; row += 1) {
    if (!rows[row].trim()) continue;
    const option = readOptionRow(rows[row], row);
    if (option) candidates.push(option);
  }

  // Contiguous runs only: a menu is drawn as a block, not scattered lines.
  const blocks = [];
  for (const option of candidates) {
    const current = blocks.at(-1);
    if (current && option.row === current.at(-1).row + 1) current.push(option);
    else blocks.push([option]);
  }

  const list = blocks
    .filter((block) => block.length >= 2)
    .filter((block) => block.some((option) => option.marker !== null) || block.every((option) => option.number !== null))
    .sort((a, b) => b.length - a.length)[0];

  if (list) {
    const hasMarker = list.some((option) => option.marker !== null);
    const options = list.map((option, index) => ({
      ...option,
      index,
      selected: option.marker !== null,
      // Inside a marked block every plain row is a choice; only the chrome around
      // it is not.
      significant:
        option.marker !== null ||
        option.number !== null ||
        option.checked !== undefined ||
        option.description !== '' ||
        (hasMarker && !isMenuChrome(option.label)),
    }));
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.selected),
    );
    return {
      kind: 'list',
      options,
      count: options.filter((option) => option.significant).length,
      selectedIndex,
      numbered: options.filter((option) => option.significant).every((option) => option.number !== null),
      confirm: null,
    };
  }

  const confirm = readConfirm(rows);
  if (confirm) return { kind: 'confirm', options: [], count: 0, selectedIndex: -1, numbered: false, confirm };
  return { kind: 'none', options: [], count: 0, selectedIndex: -1, numbered: false, confirm: null };
}

function readConfirm(rows) {
  const tail = rows.filter((row) => row.trim()).slice(-6).reverse();
  for (const row of tail) {
    const match = CONFIRM_RE.exec(row);
    if (!match) continue;
    const question = row.replace(/\s+$/, '');
    // `[Y/n]` means Enter defaults to yes, so the letters stay y and n.
    if (QUESTION_HINT_RE.test(question) || /[[(]/.test(question)) return { yes: 'y', no: 'n', question };
  }
  return null;
}

/**
 * The keys that take the tap on `tapRow` to a confirmed choice.
 * Returns null when the row is not part of a menu — ordinary output.
 */
export function planTap(text, tapRow) {
  const ui = parsePaneUi(text);
  if (ui.kind !== 'list') return null;

  const target = ui.options.find((option) => option.row === tapRow);
  if (!target || !target.significant) return null;

  if (ui.numbered && target.number !== null) {
    // A numbered menu commits on the digit; Enter would answer the next dialog.
    return { keys: [String(target.number)], note: `按 ${target.number}` };
  }

  const delta = target.index - ui.selectedIndex;
  const moves = Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up');

  if (target.checked !== undefined) {
    const checkboxCount = Math.abs(delta);
    const checkboxDirection = delta > 0 ? 'Down' : 'Up';
    return { keys: [...moves, 'Space'], note: `${checkboxDirection} ×${checkboxCount}, Space` };
  }
  // Plain words, not arrow glyphs: ⇅ and ⏎ have no face on many phones and
  // render as boxes in the toast.
  const count = Math.abs(delta);
  const direction = delta > 0 ? 'Down' : 'Up';
  return { keys: [...moves, 'Enter'], note: count ? `${direction} ×${count}, Enter` : 'Enter' };
}
