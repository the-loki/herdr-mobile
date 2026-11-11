// Probe 3: does `pane.send_input` type, or does it paste?
//
// pi's command palette opens when `/` is *typed* at the start of the composer.
// This checks which herdr call actually types: send_text, send_input, or
// send_text followed by Enter.
//
//   node container/probe3.mjs
import { HerdrClient } from '../src/herdr.mjs';

const socketPath = process.env.HERDR_SOCKET_PATH ?? '/root/.config/herdr/herdr.sock';
const client = new HerdrClient({ socketPath, timeoutMs: 20000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function spawnPi(label) {
  const created = await client.rpc('workspace.create', { cwd: '/tmp/proj', label, focus: false });
  const pane = created.root_pane.pane_id;
  await client.rpc('pane.send_input', { pane_id: pane, text: 'pi', keys: ['Enter'] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    const list = await client.rpc('agent.list', {});
    if ((list.agents ?? []).some((agent) => agent.pane_id === pane && agent.agent === 'pi')) break;
  }
  await sleep(6000); // let pi finish booting and draw its composer
  return { pane, workspace: created.workspace.workspace_id };
}

async function visible(pane) {
  const read = await client.rpc('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
  return read.read?.text ?? '';
}

const report = {};

// A: pane.send_text
{
  const { pane, workspace } = await spawnPi('probe-typed');
  await client.rpc('pane.send_text', { pane_id: pane, text: '/' });
  await sleep(2000);
  const text = await visible(pane);
  report.send_text_opens_palette = text.includes('Open settings menu');
  report.send_text_saw_slash = text.includes('/');
  await client.rpc('workspace.close', { workspace_id: workspace });
}

// B: pane.send_input without keys
{
  const { pane, workspace } = await spawnPi('probe-pasted');
  await client.rpc('pane.send_input', { pane_id: pane, text: '/' });
  await sleep(2000);
  const text = await visible(pane);
  report.send_input_opens_palette = text.includes('Open settings menu');
  await client.rpc('workspace.close', { workspace_id: workspace });
}

// C: send_text + Enter commits the highlighted row
{
  const { pane, workspace } = await spawnPi('probe-commit');
  await client.rpc('pane.send_text', { pane_id: pane, text: '/' });
  await sleep(1500);
  await client.rpc('pane.send_keys', { pane_id: pane, keys: ['Enter'] });
  await sleep(2500);
  const text = await visible(pane);
  report.enter_commits = /settings|Model|Theme|Thinking/i.test(text) && !text.includes('(1/73)');
  report.after_enter_tail = text.split('\n').slice(-8).join(' | ');
  await client.rpc('workspace.close', { workspace_id: workspace });
}

console.log(JSON.stringify(report, null, 1));
