// A deterministic TUI menu for the end-to-end test: arrow keys move, Enter
// chooses, and the choice is printed. Same shape agents draw (marker + rows), so
// it exercises the tap-to-choose path without waiting on a real agent's boot.
const items = ['alpha', 'bravo', 'charlie', 'delta'];

let selected = 0;

function draw() {
  process.stdout.write('\x1b[2J\x1b[H');
  items.forEach((item, index) => {
    const marker = index === selected ? '→ ' : '  ';
    const description = index === 0 ? 'first item' : `item ${index + 1}`;
    process.stdout.write(`${marker}${item}      ${description}\n`);
  });
  process.stdout.write('\nEnter to select\n');
}

process.stdin.setRawMode(true);
process.stdin.resume();
// Keys arrive as a stream and may be coalesced into one write (herdr sends
// "ESC [ B ESC [ B ESC [ B CR" for three Downs and an Enter), so scan the buffer
// instead of comparing the whole chunk. A terminal in cursor-key (application)
// mode sends ESC O A/B; the normal-mode form is ESC [ A/B. Accept both.
function scan(buffer) {
  const keys = [];
  let index = 0;
  while (index < buffer.length) {
    const rest = buffer.slice(index);
    if (rest.startsWith('\x1b[B') || rest.startsWith('\x1bOB')) {
      keys.push('down');
      index += 3;
    } else if (rest.startsWith('\x1b[A') || rest.startsWith('\x1bOA')) {
      keys.push('up');
      index += 3;
    } else if (rest.startsWith('\r') || rest.startsWith('\n')) {
      keys.push('enter');
      index += 1;
    } else {
      keys.push(`other:${JSON.stringify(rest[0])}`);
      index += 1;
    }
  }
  return keys;
}

process.stdin.on('data', (chunk) => {
  for (const key of scan(chunk.toString())) {
    if (key === 'down') {
      selected = Math.min(items.length - 1, selected + 1);
    } else if (key === 'up') {
      selected = Math.max(0, selected - 1);
    } else if (key === 'enter') {
      process.stdout.write(`\nCHOSE:${items[selected]}\n`);
      return;
    } else {
      process.stdout.write(`\nUNEXPECTED:${key}\n`);
    }
  }
  draw();
});

draw();
