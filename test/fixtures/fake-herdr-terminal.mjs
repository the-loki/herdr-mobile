// A stand-in for `herdr terminal session observe <pane> --cols N --rows M`.
// Writes the protocol herdr writes: one JSON object per line on stdout. The
// first frame carries its own argv so tests can see which geometry was asked
// for; after two frames it announces the terminal is closed.
const argv = process.argv.slice(2);
const cols = argv[argv.indexOf('--cols') + 1] ?? '0';
const rows = argv[argv.indexOf('--rows') + 1] ?? '0';

const frame = (seq, full, text) =>
  JSON.stringify({
    type: 'terminal.frame',
    seq,
    encoding: 'ansi',
    width: Number(cols),
    height: Number(rows),
    full,
    bytes: Buffer.from(text, 'utf8').toString('base64'),
  }) + '\n';

process.stdout.write(frame(1, true, `\u001b[2Jhello cols ${cols} rows ${rows}`));
setTimeout(() => {
  process.stdout.write(frame(2, false, 'delta'));
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'terminal.closed', reason: 'pane exited' }) + '\n');
    setTimeout(() => process.exit(0), 100);
  }, 250);
}, 60);
