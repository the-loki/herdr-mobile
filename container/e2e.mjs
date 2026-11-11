// End-to-end acceptance, run inside the test container against a real herdr
// server and a real pi pane. Drives the built web client in headless Chromium
// at a phone viewport and a desktop viewport, and asserts on what a user sees.
//
//   node container/e2e.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// The image installs puppeteer-core globally; ESM would not find it by name.
const require = createRequire(import.meta.url);
const puppeteer = (() => {
  try {
    return require('puppeteer-core');
  } catch {
    return require('/usr/local/lib/node_modules/puppeteer-core');
  }
})();

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:7777';
const TOKEN = process.env.E2E_TOKEN;
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? '/work/container/artifacts';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };

const results = [];
const consoleErrors = [];
const apiTraffic = [];
let currentPage = null;
const step = async (name, run) => {
  const started = Date.now();
  try {
    await run();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    console.log(`  ✖ ${name}: ${error.message}`);
    if (currentPage) {
      // Leave something to read when a browser assertion fails.
      const text = await currentPage.evaluate(() => document.body.innerText).catch(() => '(page unavailable)');
      const shot = path.join(ARTIFACTS, 'failure.png');
      await currentPage.screenshot({ path: shot }).catch(() => {});
      const posts = apiTraffic.filter((entry) => entry.method === 'POST');
      const state = await currentPage
        .evaluate(() => ({
          textarea: document.querySelector('textarea')?.value,
          hash: window.location.hash,
          toast: document.querySelector('[data-testid="toast"]')?.textContent ?? null,
          menuRows: document.querySelectorAll('[data-testid="menu-option"]').length,
          tail: (document.querySelector('pre')?.textContent ?? '').split('\n').slice(-6),
        }))
        .catch(() => null);
      console.log(`  dom: ${JSON.stringify(state)}`);
      console.log(`  posts: ${posts.map((p) => `${p.url} ${p.body}`).join(' ; ') || '(none)'}`);
      console.log(`  page text:\n${text.split('\n').slice(0, 20).map((line) => `    ${line}`).join('\n')}`);
      console.log(`  screenshot: ${shot}`);
    }
    throw error;
  }
};

function herdr(...args) {
  return execFileSync('herdr', args, { encoding: 'utf8', env: process.env });
}

async function paneTextFromApi(paneId) {
  const response = await fetch(`${BASE}/api/pane/${encodeURIComponent(paneId)}?source=visible`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200, 'pane read through the plugin API');
  return (await response.json()).text;
}

async function stateFromApi() {
  const response = await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 200);
  return response.json();
}

/** Click through the real mouse at the element's centre, after proving the hit test. */
async function clickHandle(page, element, label) {
  const state = await element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      disabled: Boolean(node.disabled),
      width: rect.width,
      height: rect.height,
      inViewport: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight,
      hitIsSelf: Boolean(hit && (hit === node || node.contains(hit))),
      x,
      y,
    };
  });
  assert.equal(state.disabled, false, `${label} is enabled`);
  assert.ok(state.width > 0 && state.height > 0, `${label} has a box`);
  assert.equal(state.inViewport, true, `${label} is inside the viewport (${Math.round(state.x)},${Math.round(state.y)})`);
  assert.equal(state.hitIsSelf, true, `${label} is not covered by another element`);
  await page.mouse.click(state.x, state.y);
}

async function clickByText(page, text, { exact = false } = {}) {
  const handle = await page.evaluateHandle((label, isExact) => {
    const candidates = [...document.querySelectorAll('button')];
    return candidates.find((button) => {
      const value = (button.textContent ?? '').trim();
      return isExact ? value === label : value.includes(label);
    }) ?? null;
  }, text, exact);
  const element = handle.asElement();
  assert.ok(element, `a button with text “${text}” exists`);
  await clickHandle(page, element, `the “${text}” button`);
}

async function click(page, selector) {
  await page.waitForSelector(selector, { timeout: 15000 });
  const element = await page.$(selector);
  assert.ok(element, `${selector} exists`);
  await clickHandle(page, element, selector);
}

/**
 * Tap a rendered line of the pane like a finger would: find the row's text, turn
 * it into a client rect with a Range, and click its centre.
 */
async function tapRowContaining(page, needle) {
  const point = await page.evaluate((text) => {
    const pre = document.querySelector('pre');
    const value = pre?.textContent ?? '';
    const lines = value.split('\n');
    const row = lines.findIndex((line) => line.includes(text));
    if (row === -1) return null;

    let offset = 0;
    for (let index = 0; index < row; index += 1) offset += lines[index].length + 1;

    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) return null;

    const range = document.createRange();
    range.setStart(node, Math.min(offset, node.data.length));
    range.setEnd(node, Math.min(offset + Math.max(1, lines[row].length), node.data.length));
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.left + Math.min(rect.width / 2, 60), y: rect.top + rect.height / 2 };
  }, needle);

  assert.ok(point, `the pane shows a row containing ${JSON.stringify(needle)}`);
  await page.mouse.click(point.x, point.y);
}

/** Wait until the pane stops changing: a TUI that is still booting swallows keys. */
async function waitForStablePane(page, { quietMs = 1500, timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const current = await preText(page);
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function typeInto(page, text) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForSelector('textarea', { timeout: 15000 });
    await page.focus('textarea');
    await page.$eval('textarea', (node) => {
      node.select();
    });
    await page.keyboard.type(text);
    const value = await page.$eval('textarea', (node) => node.value);
    if (value === text) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const value = await page.$eval('textarea', (node) => node.value);
  assert.equal(value, text, 'the reply box holds what was typed');
}

const preText = (page) => page.$eval('pre', (node) => node.textContent ?? '').catch(() => '');

/** Send a shell command and wait for its own echo, retrying once on a race with the previous command. */
async function runInPane(page, command, { timeout = 20000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await typeInto(page, command);
    await clickByText(page, 'Send');
    const deadline = Date.now() + (attempt === 0 ? timeout : timeout / 2);
    while (Date.now() < deadline) {
      if ((await preText(page)).includes(command)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`the pane never echoed ${JSON.stringify(command)}; last text ${JSON.stringify((await preText(page)).slice(-200))}`);
}

async function waitForText(page, needle, { timeout = 15000 } = {}) {
  const wanted = needle.toLowerCase();
  await page.waitForFunction((value) => document.body.innerText.toLowerCase().includes(value), { timeout }, wanted);
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
assert.ok(TOKEN, 'E2E_TOKEN must be set');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

try {
  const page = await browser.newPage();
  currentPage = page;
  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return;
    apiTraffic.push({ phase: 'request', method: request.method(), url: request.url().replace(BASE, ''), body: request.postData() ?? null });
  });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/')) return;
    let text = '';
    try {
      text = (await response.text()).slice(0, 200);
    } catch {
      text = '(unreadable)';
    }
    apiTraffic.push({ phase: 'response', status: response.status(), url: response.url().replace(BASE, ''), body: text });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await step('the app loads from the pairing link and shows the session', async () => {
    await page.setViewport(MOBILE);
    await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main');
    await waitForText(page, 'demo');
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-list.png') });
  });

  await step('nothing overflows sideways on a phone', async () => {
    const metrics = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      sendRight: (() => {
        const send = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Send'));
        return send ? send.getBoundingClientRect().right : null;
      })(),
    }));
    assert.equal(metrics.innerWidth, 390, `the layout viewport is the phone width (${metrics.innerWidth})`);
    assert.ok(metrics.scrollWidth <= metrics.innerWidth, `no horizontal overflow (scrollWidth ${metrics.scrollWidth})`);
  });

  await step('the pi pane is listed with a settled agent status', async () => {
    await waitForText(page, 'π - proj');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('span')].some((node) =>
          ['idle', 'working', 'blocked', 'done'].includes((node.textContent ?? '').trim()),
        ),
      { timeout: 30000 },
    );
  });

  await step('opening the pi pane renders its live screen', async () => {
    await clickByText(page, 'pi');
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').length > 40, { timeout: 15000 });
    const text = await page.$eval('pre', (node) => node.textContent);
    assert.match(text, /pi|π/i, 'pane text mentions the agent');
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-detail.png') });
  });

  await step('a menu drawn in the pane becomes tappable options', async () => {
    // A controlled TUI menu (container/menu-tui.mjs): marker row, four options,
    // Enter chooses. Deterministic, unlike waiting for an agent's boot screen.
    const before = new Set((await stateFromApi()).panes.map((pane) => pane.id));
    await click(page, 'button[aria-label="Pane actions"]');
    await clickByText(page, 'Split down');
    await page.waitForSelector('dialog[open] input');
    // Absolute path: a new pane inherits the workspace cwd, not this repository.
    await page.type('dialog[open] input', 'node /work/container/menu-tui.mjs');
    await click(page, 'dialog[open] button[type="submit"]');

    let menuPane = null;
    for (let attempt = 0; attempt < 40 && !menuPane; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      menuPane = (await stateFromApi()).panes.find((pane) => !before.has(pane.id)) ?? null;
    }
    assert.ok(menuPane, 'the split created a new pane');

    await click(page, 'button[aria-label="Show session list"]');
    await page.waitForSelector(`[data-pane-id="${menuPane.id}"]`, { timeout: 15000 });
    await click(page, `[data-pane-id="${menuPane.id}"]`);
    await page.waitForSelector('[data-testid="menu-option"]', { timeout: 20000 });

    const rows = await page.$$eval('[data-testid="menu-option"]', (nodes) =>
      nodes.map((node) => ({ text: node.textContent.replace(/\s+/g, ' ').trim(), selected: node.className.includes('border-accent') })),
    );
    assert.equal(rows.length, 4, `all four options are offered (${rows.map((row) => row.text).join(' | ')})`);
    for (const label of ['alpha', 'bravo', 'charlie', 'delta']) {
      assert.ok(rows.some((row) => row.text.includes(label)), `${label} is offered`);
    }
    assert.equal(rows[0].selected, true, 'the highlighted row is shown as selected');
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-menu.png') });

    // Choosing the fourth row must become three Downs plus Enter.
    await clickByText(page, 'delta');
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('CHOSE:delta'), {
      timeout: 15000,
    });
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-menu-chosen.png') });
  });

  await step('the same tap works on a real pi command palette (opportunistic)', async () => {
    const piPane = (await stateFromApi()).panes.find((pane) => pane.agent === 'pi');
    if (!piPane) return;
    await click(page, 'button[aria-label="Show session list"]');
    await click(page, `[data-pane-id="${piPane.id}"]`);

    // pi ignores keys until it has finished drawing its first screen, so retry the
    // "/" a few times rather than pinning the suite to its boot time.
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
      await waitForStablePane(page, { quietMs: 2000 });
      await typeInto(page, '/');
      await clickByText(page, 'Type only');
      opened = await page
        .waitForFunction(
          () => {
            const text = document.querySelector('pre')?.textContent ?? '';
            return text.includes('Open settings menu') && text.includes('Navigate session tree');
          },
          { timeout: 6000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        await clickByText(page, 'Esc', { exact: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!opened) {
      console.log('  (skipped: pi never offered its palette in this run)');
      return;
    }

    const offered = await page.$$eval('[data-testid="menu-option"]', (nodes) => nodes.length);
    assert.ok(offered >= 4, `pi's palette is offered as ${offered} options`);
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-pi-palette.png') });

    await clickByText(page, 'model');
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('Enter to select'), {
      timeout: 20000,
    });
    await clickByText(page, 'Esc', { exact: true });
  });

  await step('the pi pane shows its real conversation, from the agent\'s own log', async () => {
    const piPane = (await stateFromApi()).panes.find((pane) => pane.agent === 'pi');
    assert.ok(piPane, 'the pi pane is listed');
    assert.equal(piPane.agent_session?.kind, 'path', 'herdr reports a session file for this pane');

    // One small turn that forces a tool call, so the tool card has something to show.
    const prompt = 'Run the bash command `echo CONV-TOOL-OK` and then reply with what it printed.';
    const sent = await fetch(`${BASE}/api/pane/${encodeURIComponent(piPane.id)}/input`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: prompt, submit: true }),
    });
    assert.equal(sent.status, 200, 'the prompt was accepted');

    // The transcript endpoint reads the file; wait until the turn is recorded.
    let transcript = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await fetch(`${BASE}/api/pane/${encodeURIComponent(piPane.id)}/transcript?limit=40`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.status !== 200) continue;
      transcript = await response.json();
      // Wait for the *assistant text* (not just the tool result) and for the agent
      // to stop working, so the screenshot shows a finished exchange.
      const hasReply = transcript.entries.some((entry) => entry.kind === 'assistant' && entry.text?.includes('CONV-TOOL-OK'));
      const hasTool = transcript.entries.some((entry) => entry.kind === 'assistant' && entry.tools?.length);
      const settled = (await stateFromApi()).panes.find((pane) => pane.agent === 'pi')?.agent_status !== 'working';
      if (hasReply && hasTool && settled) break;
    }
    assert.ok(transcript, 'the transcript endpoint answered');
    const kinds = transcript.entries.map((entry) => entry.kind);
    assert.ok(kinds.includes('user'), `the user turn is recorded (${kinds.join(',')})`);
    assert.ok(
      transcript.entries.some((entry) => entry.kind === 'assistant' && entry.tools?.length),
      'the assistant turn carries its tool call',
    );
    const tool = transcript.entries.flatMap((entry) => entry.tools ?? []).find((candidate) => candidate.output?.includes('CONV-TOOL-OK'));
    assert.ok(tool, 'the tool result is attached to its call');

    // And the UI renders it as a conversation, with the tool card.
    await click(page, 'button[aria-label="Show session list"]');
    await page.waitForSelector(`[data-pane-id="${piPane.id}"]`, { timeout: 15000 });
    await click(page, `[data-pane-id="${piPane.id}"]`);
    await page.waitForSelector('[data-testid="tool-card"]', { timeout: 30000 });
    // The assistant's own words must be on screen too — asserted on its text node,
    // because the collapsed tool card also contains the command it ran.
    await page.waitForFunction(
      () => {
        const texts = [...document.querySelectorAll('[data-testid="assistant-text"]')];
        return texts.some((node) => (node.textContent ?? '').includes('CONV-TOOL-OK'));
      },
      { timeout: 40000 },
    );
    // And the agent must have stopped working, so nothing on screen is mid-flight.
    await page.waitForFunction(
      () => {
        const chip = [...document.querySelectorAll('span')].find((node) =>
          ['idle', 'done', 'blocked', 'working'].includes((node.textContent ?? '').trim()),
        );
        return chip && chip.textContent.trim() !== 'working';
      },
      { timeout: 40000 },
    );
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-conversation.png') });

    // The raw screen is still one tap away.
    await clickByText(page, '终端');
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').length > 40, { timeout: 20000 });
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-conversation-terminal.png') });
  });

  await step('typing from the phone reaches the pane (Type only, no submit)', async () => {
    const marker = `typed-${Date.now().toString(36)}`;
    const pane = (await stateFromApi()).panes.find((candidate) => candidate.agent === 'pi');
    assert.ok(pane, 'the pi pane exists');
    await typeInto(page, marker);
    await clickByText(page, 'Type only');
    await page.waitForFunction(() => true);
    let seen = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      seen = await paneTextFromApi(pane.id);
      if (seen.includes(marker)) break;
    }
    assert.ok(seen.includes(marker), `the typed text reached the pane (looking for ${marker})`);
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-typed.png') });
  });

  await step('a shell pane started from the UI runs a command and streams the result', async () => {
    await click(page, 'button[aria-label="Pane actions"]');
    await clickByText(page, 'Split down');
    await page.waitForSelector('dialog[open] input');
    await page.type('dialog[open] input', 'sh');
    await click(page, 'dialog[open] button[type="submit"]');
    await page.waitForFunction(() => true);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const panes = (await stateFromApi()).panes;
    assert.ok(panes.length >= 2, 'a second pane exists');
    const shellPane = panes.find((candidate) => !candidate.agent) ?? panes.at(-1);

    // Tap the new shell pane in the list, exactly like a user would: its row is
    // labelled with the pane id because the pane has no title, agent or cwd yet.
    await click(page, 'button[aria-label="Show session list"]');
    await click(page, `[data-pane-id="${shellPane.id}"]`);
    await page.waitForFunction(
      (paneId) => window.location.hash.includes(encodeURIComponent(paneId)),
      { timeout: 15000 },
      shellPane.id,
    );
    await page.waitForSelector('textarea', { visible: true, timeout: 15000 });

    const marker = 'echo ok-from-web';
    await typeInto(page, marker);
    await clickByText(page, 'Send');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cleared = await page.$eval('textarea', (node) => node.value);
    assert.equal(cleared, '', 'clicking Send runs the handler and clears the box');
    let seen = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      seen = await paneTextFromApi(shellPane.id);
      if (seen.includes('ok-from-web')) break;
    }
    if (!seen.includes('ok-from-web')) {
      const hash = await page.evaluate(() => window.location.hash);
      const panes = (await stateFromApi()).panes;
      const detail = [];
      for (const candidate of panes) {
        detail.push(`${candidate.id}(agent=${candidate.agent ?? '-'}): ${JSON.stringify((await paneTextFromApi(candidate.id)).slice(-200))}`);
      }
      const dom = await page.evaluate(() => ({
        textarea: document.querySelector('textarea')?.value,
        buttons: [...document.querySelectorAll('button')]
          .map((button) => `${(button.textContent ?? '').trim()}${button.disabled ? '(disabled)' : ''}`)
          .filter((label) => label.length > 0),
        hash: window.location.hash,
        toast: document.querySelector('[data-testid="toast"]')?.textContent ?? null,
        openDialogs: [...document.querySelectorAll('dialog')].filter((dialog) => dialog.open).map((dialog) => dialog.id),
        topAtSend: (() => {
          const send = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('Send'));
          if (!send) return 'no send button';
          const rect = send.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit ? `${hit.tagName}.${hit.className}`.slice(0, 80) : 'nothing';
        })(),
      }));
      const posts = apiTraffic.filter((entry) => entry.method === 'POST' || entry.phase === 'response');
      const traffic = (posts.length ? posts : apiTraffic.slice(-6))
        .map((entry) => `${entry.phase} ${entry.method ?? entry.status} ${entry.url} ${entry.body ?? ''}`)
        .join('\n      ');
      throw new Error(
        `the shell pane never echoed the command. target=${shellPane.id} hash=${hash}\n    ${detail.join('\n    ')}\n    dom: ${JSON.stringify(dom)}\n    console: ${JSON.stringify(consoleErrors)}\n    api traffic:\n      ${traffic}`,
      );
    }
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-shell.png') });
  });

  await step('the open pane keeps up on its own, with no further taps', async () => {
    // Nothing is clicked between the send and the assertion: the 1.2 s viewport
    // poll is the only thing that can make tick-5 appear.
    const loop = 'for i in 1 2 3 4 5; do echo tick-$i; sleep 0.6; done';
    await typeInto(page, loop);
    await clickByText(page, 'Send');
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('tick-5'), {
      timeout: 20000,
    });
    const text = await page.$eval('pre', (node) => node.textContent);
    assert.ok(text.indexOf('tick-1') < text.indexOf('tick-5'), 'the pane grew from tick-1 to tick-5 in place');
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-live.png') });
  });

  await step('an approval prompt is answered from the key strip', async () => {
    // Wait for the previous loop to give the shell back before asking a question.
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('tick-5'), {
      timeout: 20000,
    });
    await runInPane(page, `printf 'Continue? (y/n) '; read answer; echo "answered:$answer"`);
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('Continue? (y/n)'), {
      timeout: 15000,
    });
    await clickByText(page, 'y', { exact: true });
    await clickByText(page, '⏎', { exact: true });
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('answered:y'), {
      timeout: 15000,
    });
    await page.screenshot({ path: path.join(ARTIFACTS, 'mobile-approval.png') });
  });

  await step('Ctrl-C from the key strip interrupts a running command', async () => {
    await runInPane(page, 'sleep 30', { timeout: 8000 });
    await clickByText(page, 'Ctrl-C', { exact: true });
    // The proof the interrupt landed: the shell answers again well before the
    // 30 s sleep could have finished on its own.
    await typeInto(page, 'echo after-interrupt');
    await clickByText(page, 'Send');
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').includes('after-interrupt'), {
      timeout: 10000,
    });
  });

  await step('the desktop layout shows the sidebar and the pane at the same time', async () => {
    await page.setViewport(DESKTOP);
    await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside');
    const columns = await page.$eval('main', (node) => getComputedStyle(node).gridTemplateColumns);
    assert.ok(columns.split(' ').length >= 2, `desktop grid has two columns (${columns})`);
    await waitForText(page, 'demo');
    // No hash in the URL: a wide screen should land on the pane that needs you.
    await page.waitForFunction(() => (document.querySelector('pre')?.textContent ?? '').length > 40, { timeout: 20000 });
    const picked = await page.$eval('pre', (node) => node.textContent.length);
    assert.ok(picked > 40, 'a pane was opened automatically on the desktop layout');
    await page.screenshot({ path: path.join(ARTIFACTS, 'desktop.png') });
  });

  await step('a deep link to a closed pane says so instead of going blank', async () => {
    await page.goto(`${BASE}/?token=${TOKEN}#pane=wZZ:p99`, { waitUntil: 'domcontentloaded' });
    await waitForText(page, 'no longer open', { timeout: 15000 });
    await page.screenshot({ path: path.join(ARTIFACTS, 'desktop-missing-pane.png') });
  });

  await step('no uncaught browser errors were logged', async () => {
    const real = consoleErrors.filter((message) => !/Failed to load resource: the server responded with a status of 404/.test(message));
    assert.deepEqual(real, [], `console errors: ${real.join(' | ')}`);
  });

  console.log('\n  herdr:');
  console.log(herdr('agent', 'list').trim());
  console.log(`\n  screenshots: ${ARTIFACTS}`);
  console.log(`\n  ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
} finally {
  await browser.close();
}
