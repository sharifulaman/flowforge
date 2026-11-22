// Full-system test: real API + real worker processes, production connector registry.
// Usage: start the API and worker with HTTP_ALLOW_PRIVATE_HOSTS=127.0.0.1, then `node scripts/system-e2e.mjs`.
// Against Docker: ECHO_HOST=host.docker.internal ECHO_BIND=0.0.0.0 (see docker/compose.e2e.yml).
const ECHO_HOST = process.env.ECHO_HOST ?? '127.0.0.1';
const ECHO_BIND = process.env.ECHO_BIND ?? '127.0.0.1';
import { createServer } from 'node:http';

const API = 'http://localhost:4000/api/v1';
const ORIGIN = 'http://localhost:3000';
let cookies = '';
const received = [];

const echo = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    received.push({ path: req.url, body: JSON.parse(b || 'null'), auth: req.headers.authorization });
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ stored: true, id: received.length }));
  });
});
await new Promise((r) => echo.listen(5055, ECHO_BIND, r));

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { origin: ORIGIN, cookie: cookies, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookies = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}
const check = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitRun(ws, runId, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const run = await api('GET', `/workspaces/${ws}/runs/${runId}`);
    if (['SUCCEEDED', 'FAILED', 'FILTERED', 'CANCELED'].includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`run ${runId} still ${run.status}`);
    await sleep(200);
  }
}

try {
  console.log('1. Sign up');
  const me = await api('POST', '/auth/register', { email: `e2e${Date.now()}@flowforge.dev`, password: 'password123', name: 'Ada Lovelace' });
  const ws = me.workspaces[0].id;
  const apps = (await api('GET', '/apps')).map((a) => a.key);
  check(['http', 'filter', 'delay', 'code', 'smtp', 'slack', 'google-sheets', 'telegram', 'rss'].every((k) => apps.includes(k)), `registry exposes all connectors (${apps.length} apps)`);

  console.log('2. Build the zap');
  const zap = await api('POST', `/workspaces/${ws}/zaps`, { name: 'Pro signups → billing' });
  const base = `/workspaces/${ws}/zaps/${zap.id}`;
  const withTrigger = await api('PUT', `${base}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
  const hookUrl = withTrigger.trigger.hookUrl;

  const capture = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'pro', seats: 2, name: 'Sample' }) });
  check((await capture.json()).status === 'sample_captured', 'webhook to draft zap captured sample data');

  await api('POST', `${base}/steps`, { appKey: 'filter', operationKey: 'onlyContinueIf', config: { match: 'all', conditions: [{ left: '{{ trigger.body.plan }}', operator: 'equals', right: 'pro' }] } });
  await api('POST', `${base}/steps`, {
    appKey: 'code', operationKey: 'runJavascript',
    config: { inputData: { seats: '{{ trigger.body.seats }}', name: '{{ trigger.body.name }}' }, code: 'console.log("seats", input.seats); return { total: input.seats * 49, greeting: `Welcome ${input.name}` };' },
  });
  await api('POST', `${base}/steps`, { appKey: 'delay', operationKey: 'wait', config: { mode: 'for', amount: 2, unit: 'seconds' } });
  const built = await api('POST', `${base}/steps`, {
    appKey: 'http', operationKey: 'request',
    config: { method: 'POST', url: `http://${ECHO_HOST}:5055/billing`, headers: { Authorization: 'Bearer demo' }, bodyType: 'json', body: { total: '{{ step2.total }}', msg: '{{ step2.greeting }}', plan: '{{ trigger.body.plan | upper }}' } },
  });
  check(built.steps.map((s) => s.key).join(',') === 'trigger,step1,step2,step3,step4', 'steps have stable keys');

  console.log('3. Test the Code step in the worker (uses captured sample)');
  const tested = await api('POST', `${base}/steps/${built.steps[2].id}/test`);
  check(tested.status === 'success' && tested.output.total === 98 && tested.output.greeting === 'Welcome Sample', `test step → ${JSON.stringify(tested.output)}`);
  check(tested.logs.some((l) => l.message === 'seats 2'), 'sandbox console output returned');
  const samples = await api('GET', `${base}/samples`);
  check(samples[2].isExample === false && samples[2].sample.total === 98, 'tested output became the step sample');

  console.log('4. Publish');
  const on = await api('POST', `${base}/enable`);
  check(on.status === 'ACTIVE' && on.publishedVersion === 1, 'zap is ACTIVE at version 1');

  console.log('5. Live run: pro signup');
  const t0 = Date.now();
  const hit = await (await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'signup-1' }, body: JSON.stringify({ plan: 'pro', seats: 3, name: 'Ada' }) })).json();
  check(hit.status === 'accepted', 'webhook accepted');
  const dup = await (await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'signup-1' }, body: '{}' })).json();
  check(dup.status === 'duplicate' && dup.runId === hit.runId, 'duplicate delivery de-duplicated');
  const run = await waitRun(ws, hit.runId);
  const elapsed = Date.now() - t0;
  check(run.status === 'SUCCEEDED', `run SUCCEEDED in ${elapsed} ms`);
  check(elapsed >= 2_000, 'delay step actually waited ~2 s');
  check(run.steps.map((s) => `${s.stepKey}:${s.status}`).join(' ') === 'step1:SUCCEEDED step2:SUCCEEDED step3:SUCCEEDED step4:SUCCEEDED', 'all four steps succeeded');
  check(received.length === 1 && received[0].body.total === 147 && received[0].body.msg === 'Welcome Ada' && received[0].body.plan === 'PRO' && received[0].auth === 'Bearer demo', `HTTP step delivered ${JSON.stringify(received[0]?.body)}`);
  check(run.steps[3].output.status === 201 && run.steps[3].output.body.stored === true, 'HTTP response stored as step output');

  console.log('6. Live run: free signup is filtered');
  const free = await (await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'free', seats: 1, name: 'Bob' }) })).json();
  const filtered = await waitRun(ws, free.runId);
  check(filtered.status === 'FILTERED' && filtered.steps.length === 1, `run FILTERED: ${filtered.error?.message}`);
  check(received.length === 1, 'no HTTP call for filtered run');

  console.log(`7. SSRF: HTTP step to cloud metadata is blocked even with the private-host allowlist (${ECHO_HOST})`);
  const zap2 = await api('POST', `/workspaces/${ws}/zaps`, { name: 'SSRF probe' });
  const b2 = `/workspaces/${ws}/zaps/${zap2.id}`;
  const t2 = await api('PUT', `${b2}/trigger`, { appKey: 'webhook', operationKey: 'catchHook' });
  await api('POST', `${b2}/steps`, { appKey: 'http', operationKey: 'request', config: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' } });
  await api('POST', `${b2}/enable`);
  const probe = await (await fetch(t2.trigger.hookUrl, { method: 'POST' })).json();
  const blocked = await waitRun(ws, probe.runId);
  check(blocked.status === 'FAILED' && blocked.error.code === 'SSRF_BLOCKED', `blocked: ${blocked.error.message}`);

  console.log('8. Runs list');
  const list = await api('GET', `/workspaces/${ws}/runs?limit=10`);
  check(list.items.length === 3, `3 runs listed (${list.items.map((r) => r.status).join(', ')})`);
  console.log('\nSYSTEM E2E PASSED');
} catch (err) {
  console.error('\nSYSTEM E2E FAILED:', err.message);
  process.exitCode = 1;
} finally {
  echo.close();
}
