// Browser end-to-end test of run history, monitoring and settings.
// Start web (3000), API and worker, then: node scripts/monitor-e2e.cjs <screenshot-dir>
const { chromium } = require('playwright');

const out = process.argv[2] ?? '.';
const step = (m) => console.log(`• ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));

  step('register owner');
  await page.goto('http://localhost:3000/register');
  await page.fill('#name', 'Grace Hopper');
  await page.fill('#email', `mon-${Date.now()}@example.com`);
  await page.fill('#password', 'password123');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/w\/[a-z0-9]+$/);
  const ws = page.url().split('/w/')[1];
  const apiCall = async (method, path, body) => {
    const res = await page.request.fetch(`http://localhost:3000/api/v1${path}`, { method, data: body, headers: { origin: 'http://localhost:3000' } });
    if (!res.ok()) throw new Error(`${method} ${path} ${res.status()} ${await res.text()}`);
    return res.status() === 204 ? null : res.json();
  };

  step('dashboard shows getting-started for an empty workspace');
  await page.waitForSelector('text=Build your first Zap');

  step('build a zap via API: webhook → filter(plan=pro) → code (throws when seats>10)');
  const zap = await apiCall('POST', `/workspaces/${ws}/zaps`, { name: 'Pro signups' });
  const base = `/workspaces/${ws}/zaps/${zap.id}`;
  const t = await apiCall('PUT', `${base}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
  await apiCall('POST', `${base}/steps`, {
    appKey: 'filter',
    operationKey: 'onlyContinueIf',
    config: { match: 'all', conditions: [{ left: '{{ trigger.body.plan }}', operator: 'equals', right: 'pro' }] },
  });
  await apiCall('POST', `${base}/steps`, {
    appKey: 'code',
    operationKey: 'runJavascript',
    config: {
      inputData: { seats: '{{ trigger.body.seats }}' },
      code: 'console.log("seats", input.seats); if (Number(input.seats) > 10) throw new Error("Seat limit exceeded"); return { total: input.seats * 49 };',
    },
  });
  await apiCall('POST', `${base}/enable`);
  const hook = t.trigger.hookUrl;
  const fire = (body) => fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (let i = 0; i < 6; i++) await fire({ plan: 'pro', seats: i + 1 });
  for (let i = 0; i < 3; i++) await fire({ plan: 'free', seats: 1 });
  for (let i = 0; i < 2; i++) await fire({ plan: 'pro', seats: 50 });
  for (let i = 0; i < 60; i++) {
    const r = await apiCall('GET', `/workspaces/${ws}/runs?limit=50`);
    if (r.items.length === 11 && r.items.every((x) => ['SUCCEEDED', 'FAILED', 'FILTERED'].includes(x.status))) break;
    await sleep(300);
  }

  step('dashboard: stat tiles, chart, hover tooltip, table view, attention panel');
  await page.goto(`http://localhost:3000/w/${ws}`);
  await page.waitForSelector('[data-testid=stat-tile]');
  await page.click('[role=tab]:has-text("24 hours")');
  await page.waitForSelector('svg[role=img]');
  await page.waitForTimeout(500);
  const tiles = await page.$$eval('[data-testid=stat-tile]', (els) => els.map((e) => e.textContent));
  step(`tiles: ${tiles.join(' | ')}`);
  if (!tiles[0].includes('11') || !tiles[1].includes('75')) throw new Error('unexpected tile values');
  await page.waitForSelector('[data-testid=top-failing] >> text=Seat limit exceeded');
  const bands = await page.$$('svg[role=img] rect[tabindex="0"]');
  await bands[bands.length - 1].hover();
  await page.waitForSelector('[role=tooltip] >> text=Succeeded');
  await page.screenshot({ path: `${out}/20-dashboard-light.png` });
  await page.click('[role=tab]:has-text("table")');
  await page.waitForSelector('th:has-text("Hour (UTC)")');
  await page.click('[role=tab]:has-text("chart")');

  step('runs list + filters');
  await page.click('nav[aria-label=Main] a[href$="/runs"]');
  await page.waitForSelector('[data-testid=runs-table]');
  const rows = await page.$$eval('[data-testid=runs-table] tbody tr', (r) => r.length);
  if (rows !== 11) throw new Error(`expected 11 runs, got ${rows}`);
  await page.click('[role=tab]:has-text("Failed")');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=runs-table] tbody tr').length === 2);
  await page.screenshot({ path: `${out}/21-runs-failed.png` });

  step('run detail: timeline, failure, logs');
  await page.click('[data-testid=runs-table] tbody tr >> nth=0');
  await page.waitForSelector('[data-testid=run-detail]');
  await page.waitForSelector('text=Step step2 failed');
  await page.waitForSelector('[data-testid=timeline-step2] >> text=Data in');
  await page.waitForSelector('text=seats 50');
  await page.screenshot({ path: `${out}/22-run-detail-failed.png` });

  step('replay from the failed step → new run reuses step1');
  await page.click('[data-testid=replay]');
  await page.click('[data-testid=replay-from-failed]');
  await page.waitForSelector('text=Replay of');
  await page.waitForSelector('text=Step step2 failed', { timeout: 15_000 });

  step('settings: API key create (shown once) and works against the API');
  await page.click('nav[aria-label="Workspace settings"] a[href$="/settings/api-keys"]');
  await page.click('[data-testid=create-api-key]');
  await page.fill('#key-name', 'CI');
  await page.click('[role=dialog] button[type=submit]');
  const key = (await page.textContent('[data-testid=new-api-key]')).trim();
  if (!key.startsWith('ff_live_')) throw new Error('no key');
  const viaKey = await fetch(`http://localhost:4000/api/v1/workspaces/${ws}/runs?limit=1`, { headers: { authorization: `Bearer ${key}` } });
  if (viaKey.status !== 200) throw new Error(`api key did not work: ${viaKey.status}`);
  await page.screenshot({ path: `${out}/23-api-key-created.png` });
  await page.click('[role=dialog] button:has-text("Done")');
  await page.waitForSelector('[data-testid=api-key-row] >> text=Active');

  step('settings: add member (existing user) + rename workspace');
  const other = `teammate-${Date.now()}@example.com`;
  const p2 = await (await browser.newContext()).newPage();
  await p2.goto('http://localhost:3000/register');
  await p2.fill('#name', 'Team Mate');
  await p2.fill('#email', other);
  await p2.fill('#password', 'password123');
  await p2.click('button[type=submit]');
  await p2.waitForURL(/\/w\//);
  await page.click('nav[aria-label=Settings] >> text=Members');
  await page.fill('input[aria-label=Email]', other);
  await page.click('form button[type=submit]:has-text("Add")');
  await page.waitForSelector(`[data-testid=member-row] >> text=${other}`);
  await page.screenshot({ path: `${out}/24-members.png` });
  await page.click('nav[aria-label=Settings] >> text=General');
  await page.fill('#ws-name', 'Grace Ops');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('text=Workspace renamed');

  step('dark dashboard');
  await page.click('button[aria-label="Change theme"]');
  await page.click('text=Dark');
  await page.goto(`http://localhost:3000/w/${ws}`);
  await page.click('[role=tab]:has-text("24 hours")');
  await page.waitForSelector('svg[role=img]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/25-dashboard-dark.png` });

  console.log(JSON.stringify({ errors }, null, 2));
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
