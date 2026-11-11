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
  const consoleErrors = [];
  const apiTraffic = [];
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

  await step('the desktop layout shows the sidebar and the pane at the same time', async () => {
    await page.setViewport(DESKTOP);
    await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside');
    const columns = await page.$eval('main', (node) => getComputedStyle(node).gridTemplateColumns);
    assert.ok(columns.split(' ').length >= 2, `desktop grid has two columns (${columns})`);
    await waitForText(page, 'demo');
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
