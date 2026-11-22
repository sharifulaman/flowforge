// Browser end-to-end test of the builder. Start web (3000), API and worker (with HTTP_ALLOW_PRIVATE_HOSTS=127.0.0.1),
// then: node scripts/ui-e2e.cjs <screenshot-dir>
const { chromium } = require('playwright');
const http = require('node:http');
const out = process.argv[2];
const received = [];
const echo = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    received.push({ url: req.url, body: b });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});
const step = (m) => console.log(`• ${m}`);

(async () => {
  await new Promise((r) => echo.listen(5056, '127.0.0.1', r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));

  step('register');
  await page.goto('http://localhost:3000/register');
  await page.fill('#name', 'Ada Lovelace');
  await page.fill('#email', `ui-${Date.now()}@example.com`);
  await page.fill('#password', 'password123');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/w\/[a-z0-9]+$/);
  const ws = page.url().split('/w/')[1];

  step('zaps empty state → create');
  await page.click('a[href$="/zaps"]');
  await page.waitForSelector('text=No Zaps yet');
  await page.screenshot({ path: `${out}/10-zaps-empty.png` });
  await page.click('[data-testid=create-zap]');
  await page.fill('#zap-name', 'Pro signups → billing');
  await page.click('[role=dialog] button[type=submit]');
  await page.waitForURL(/\/zaps\/[a-z0-9]+/);
  await page.waitForSelector('[data-testid=choose-trigger]');

  step('choose webhook trigger');
  await page.click('[data-testid=choose-trigger]');
  await page.waitForSelector('text=Choose a trigger');
  await page.screenshot({ path: `${out}/11-trigger-picker.png` });
  await page.click('button:has-text("Webhooks")');
  await page.waitForSelector('[data-testid=hook-url]');
  const hookUrl = (await page.textContent('[data-testid=hook-url]')).trim();
  step(`hook url ${hookUrl}`);

  step('capture a sample by calling the draft webhook');
  const cap = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'pro', email: 'sample@example.com', seats: 3 }) });
  if ((await cap.json()).status !== 'sample_captured') throw new Error('sample not captured');
  await page.click('[role=tab]:has-text("Test")');
  await page.click('[data-testid=test-step]');
  await page.waitForSelector('[data-testid=test-result] >> text=Success');

  step('add Filter step');
  await page.click('[data-testid=add-step-end]');
  await page.waitForSelector('text=Add an action');
  await page.click('button:has-text("Filter")');
  await page.waitForSelector('[data-testid=step-panel] >> text=Action · step1');
  await page.click('button:has-text("Add condition")');
  await page.click('[data-field="conditions.0.left"] [data-testid=insert-data]');
  await page.waitForSelector('[data-testid=field-picker]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/12-field-picker.png` });
  await page.click('[data-testid=field-picker] button[title="{{ trigger.body.plan }}"]');
  await page.fill('#step1-conditions-0-right', 'pro');
  await page.waitForSelector('[data-testid=save-state]:has-text("Saved")');

  step('insert HTTP step at the end');
  await page.click('[data-testid=add-step-end]');
  await page.click('button:has-text("HTTP Request")');
  await page.waitForSelector('[data-testid=step-panel] >> text=Action · step2');
  // Method select
  await page.click('#step2-method');
  await page.click('[role=option]:has-text("POST")');
  await page.fill('#step2-url', 'http://127.0.0.1:5056/billing');
  await page.click('#step2-bodyType');
  await page.click('[role=option]:has-text("JSON")');
  await page.fill('#step2-body', '{"email":"{{ trigger.body.email }}","seats":"{{ trigger.body.seats }}"}');
  await page.waitForSelector('[data-testid=save-state]:has-text("Saved")');
  await page.screenshot({ path: `${out}/13-builder-http.png` });

  step('test HTTP step through the worker');
  await page.click('[role=tab]:has-text("Test")');
  await page.click('[data-testid=test-step]');
  await page.waitForSelector('[data-testid=test-result] >> text=Success', { timeout: 30_000 });
  await page.screenshot({ path: `${out}/14-test-result.png` });
  if (!received.length) throw new Error('test step did not hit echo server');

  step('publish validation: add an incomplete Slack-less step then try turning on');
  await page.click('[data-testid=insert-after-step1]');
  await page.click('button:has-text("Delay")');
  await page.waitForSelector('[data-testid=step-panel] >> text=Action · step3');
  await page.click('#step3-mode');
  await page.click('[role=option]:has-text("Delay until")');
  await page.waitForSelector('[data-testid=save-state]:has-text("Saved")');
  await page.click('[data-testid=zap-toggle]');
  await page.waitForSelector('[data-testid=issues-button]');
  await page.screenshot({ path: `${out}/15-publish-issues.png` });

  step('fix by deleting the delay step, then turn on');
  await page.click('[data-testid=step-panel] button:has-text("Delete")');
  await page.click('[role=dialog] button:has-text("Delete")');
  await page.waitForSelector('[data-testid=node-step3]', { state: 'detached' });
  await page.click('[data-testid=zap-toggle]');
  await page.waitForSelector('[data-testid=zap-status]:has-text("On")');
  await page.screenshot({ path: `${out}/16-builder-on.png` });

  step('live webhook → run → echo receives mapped body');
  const before = received.length;
  await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'pro', email: 'ada@example.com', seats: 5 }) });
  for (let i = 0; i < 100 && received.length === before; i++) await new Promise((r) => setTimeout(r, 100));
  const live = received[received.length - 1];
  if (received.length === before) throw new Error('live run did not call echo server');
  step(`echo received ${live.body}`);

  step('dark mode builder + zaps list');
  await page.click('button[aria-label="Change theme"]');
  await page.click('text=Dark');
  await page.waitForTimeout(400);
  await page.click('[data-testid=node-step2]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/17-builder-dark.png` });
  await page.goto(`http://localhost:3000/w/${ws}/zaps`);
  await page.waitForSelector('text=Pro signups');
  await page.screenshot({ path: `${out}/18-zaps-list-dark.png` });

  step('connections: connect dialog renders schema form');
  await page.goto(`http://localhost:3000/w/${ws}/connections`);
  await page.click('[data-testid=add-connection]');
  await page.click('button:has-text("Slack")');
  await page.waitForSelector('text=Connect Slack');
  await page.fill('#cred-botToken', 'not-a-token');
  await page.click('button[type=submit]:has-text("Connect")');
  await page.waitForSelector('[role=alert]');
  await page.screenshot({ path: `${out}/19-connect-slack.png` });

  console.log(JSON.stringify({ liveBody: JSON.parse(live.body), echoCalls: received.length, errors }, null, 2));
  await browser.close();
  echo.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
