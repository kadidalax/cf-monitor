import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { Miniflare } from 'miniflare';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, '..');
const tmpDir = resolve(workerRoot, '.tmp', `smoke-e2e-${process.pid}-${Date.now()}`);
const bundlePath = resolve(tmpDir, 'smoke-worker.mjs');
const baseUrl = 'http://cf-monitor.test';
const adminUsername = 'admin';
const adminPassword = 'password123456';
const jwtSecret = '0123456789abcdef0123456789abcdef';
const jsonHeaders = { 'Content-Type': 'application/json' };
const migrations = [
  '001_init.sql',
  '003_query_indexes.sql',
  '004_remove_removed_settings.sql',
  '005_login_rate_limits.sql',
  '006_ping_task_sort_order.sql',
  '007_client_sort_order.sql',
  '008_record_high_watermark.sql',
];

const telegramRequests = [];
let telegramShouldFail = false;
let expectedCronFailureLog = false;

async function removeWithRetry(path, options, attempts = 5) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(path, options);
      return;
    } catch (error) {
      const shouldRetry = ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code);
      if (!shouldRetry || index === attempts - 1) throw error;
      await delay(150 * (index + 1));
    }
  }
}

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  if (
    expectedCronFailureLog &&
    typeof args[0] === 'string' &&
    (args[0].includes('[scheduled] 记录清理 failed') || args[0].includes('[scheduled] 负载告警检查 failed'))
  ) {
    originalConsoleError('[expected smoke failure]', ...args);
    return;
  }
  originalConsoleError(...args);
};

function waitForWebSocketMessage(ws, predicate, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
    };
    const onMessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label} closed before expected message`));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`${label} errored before expected message`));
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
  });
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function expectArray(value, label) {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value;
}

async function bundleWorker() {
  await mkdir(tmpDir, { recursive: true });
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/index.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    sourcemap: false,
    logLevel: 'silent',
  });
}

async function applyMigrations(mf) {
  const d1 = await mf.getD1Database('DB');
  for (const file of migrations) {
    const sql = (await readFile(resolve(workerRoot, 'migrations', file), 'utf8'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    if (!sql) continue;
    for (const statement of sql.split(';').map((item) => item.trim()).filter(Boolean)) {
      await d1.prepare(statement).run();
    }
  }
}

async function request(mf, path, init = {}) {
  const response = await mf.dispatchFetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body = text;
  if ((response.headers.get('content-type') || '').includes('application/json') && text) {
    body = JSON.parse(text);
  }
  return { response, body, text };
}

async function viewerSocketUrl(mf, ip = '198.51.100.10') {
  const token = await request(mf, '/api/ws/live-token', {
    headers: { 'CF-Connecting-IP': ip },
  });
  assertOk(token, 'live viewer token');
  assert.match(token.body.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'viewer token should be signed');
  assert.ok(token.body.expires_at > Date.now(), 'viewer token should include a future expiry');
  return `${baseUrl}/api/ws/live?viewer_token=${encodeURIComponent(token.body.token)}`;
}

function assertOk(result, label) {
  assert.ok(
    result.response.ok,
    `${label} failed: HTTP ${result.response.status} ${result.text}`,
  );
}

function assertPublicCache(result, label, maxAgeSeconds) {
  const cacheControl = result.response.headers.get('cache-control') || '';
  assert.match(
    cacheControl,
    new RegExp(`\\bmax-age=${maxAgeSeconds}\\b`),
    `${label} should set max-age=${maxAgeSeconds}, got ${cacheControl}`,
  );
  assert.doesNotMatch(cacheControl, /\bno-store\b/i, `${label} should override API no-store`);
}

function assertSecurityHeaders(result, label) {
  assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff', `${label} should set X-Content-Type-Options`);
  assert.equal(result.response.headers.get('referrer-policy'), 'no-referrer', `${label} should set Referrer-Policy`);
  assert.equal(result.response.headers.get('x-frame-options'), 'DENY', `${label} should deny framing`);
  const csp = result.response.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/, `${label} should set a self-only default CSP`);
  assert.match(csp, /frame-ancestors 'none'/, `${label} should block framing via CSP`);
}

function parseCookie(cookieHeader, name) {
  const cookies = Array.isArray(cookieHeader)
    ? cookieHeader
    : String(cookieHeader || '').split(/,(?=\s*[^;,=]+=[^;,]+)/);
  const prefix = `${name}=`;
  for (const cookie of cookies) {
    for (const part of cookie.split(';').map((item) => item.trim())) {
      if (part.startsWith(prefix)) return part.slice(prefix.length);
    }
  }
  return '';
}

function authHeaders(cookie, csrfToken = parseCookie(cookie, 'cf_monitor_csrf')) {
  return { ...jsonHeaders, Cookie: cookie, 'X-CSRF-Token': csrfToken };
}

function agentHeaders(token) {
  return { ...jsonHeaders, Authorization: `Bearer ${token}` };
}

function base64UrlFromBytes(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function signedViewerToken({ ip, secret, exp }) {
  const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
  const payload = base64UrlFromBytes(new TextEncoder().encode(JSON.stringify({
    exp,
    ip,
    nonce: base64UrlFromBytes(webcrypto.getRandomValues(new Uint8Array(16))),
  })));
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

async function main() {
  await bundleWorker();
  const { normalizeViewerTtlMs } = await import(`${pathToFileURL(bundlePath).href}?smoke=${Date.now()}`);
  assert.equal(normalizeViewerTtlMs(undefined), 600_000, 'viewer TTL should default to 10 minutes');
  assert.equal(normalizeViewerTtlMs(1000), 60_000, 'viewer TTL should clamp to at least 60 seconds');
  assert.equal(normalizeViewerTtlMs(3_600_001), 3_600_000, 'viewer TTL should clamp to at most 1 hour');

  const mf = new Miniflare({
    modules: true,
    scriptPath: bundlePath,
    compatibilityDate: '2025-04-01',
    bindings: {
      JWT_SECRET: jwtSecret,
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD: adminPassword,
      SITE_TITLE: 'CF Monitor',
      SITE_DESCRIPTION: 'Smoke test',
    },
    d1Databases: { DB: 'smoke-db' },
    durableObjects: { LIVE_DATA: 'LiveDataDO', RATE_LIMIT: 'RateLimitDO' },
    migrations: [
      { tag: 'v1', newClasses: ['LiveDataDO'] },
      { tag: 'v2', newClasses: ['RateLimitDO'] },
    ],
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'api.telegram.org') {
        const payload = await request.json();
        telegramRequests.push({ url: request.url, payload });
        if (telegramShouldFail) {
          return Response.json({ ok: false, description: 'smoke failure' }, { status: 500 });
        }
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      return new Response(`Unexpected outbound fetch: ${request.url}`, { status: 502 });
    },
  });

  try {
    await applyMigrations(mf);

    const login = await request(mf, '/api/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: jsonBody({ username: adminUsername, password: adminPassword }),
    });
    assertOk(login, 'admin login');
    assertSecurityHeaders(login, 'admin login');
    assert.equal(login.response.headers.get('cache-control'), 'no-store', 'admin login should not be cached');
    const setCookie = login.response.headers.getSetCookie ? login.response.headers.getSetCookie() : [login.response.headers.get('set-cookie') || ''];
    const sessionCookie = parseCookie(setCookie, 'cf_monitor_session');
    const csrfToken = parseCookie(setCookie, 'cf_monitor_csrf') || login.body.csrf_token;
    const cookie = [`cf_monitor_session=${sessionCookie}`, `cf_monitor_csrf=${csrfToken}`].join('; ');
    assert.ok(sessionCookie, 'admin login should set a session cookie');
    assert.match(csrfToken, /^[A-Za-z0-9_-]{32,128}$/, 'admin login should set a CSRF token');

    const csrfRejectedCreate = await request(mf, '/api/admin/clients/add', {
      method: 'POST',
      headers: { ...jsonHeaders, Cookie: cookie },
      body: jsonBody({ name: 'CSRF Rejected Node' }),
    });
    assert.equal(csrfRejectedCreate.response.status, 403, 'admin write without CSRF token should be rejected');

    const createdClient = await request(mf, '/api/admin/clients/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ name: 'Smoke Node' }),
    });
    assertOk(createdClient, 'create node');
    assert.match(createdClient.body.uuid, /^[0-9a-f-]{36}$/i, 'created node should return uuid');
    assert.match(createdClient.body.token, /^[0-9a-f-]{36}$/i, 'created node should return token');
    const { uuid } = createdClient.body;
    let token = createdClient.body.token;

    const adminClients = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(adminClients, 'list admin nodes');
    assert.ok(
      expectArray(adminClients.body, 'admin nodes').some((client) => client.uuid === uuid),
      'admin nodes should include the created node',
    );

    const freeOneTimeBilling = await request(mf, `/api/admin/clients/${uuid}/edit`, {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ price: -1, billing_cycle: -1 }),
    });
    assertOk(freeOneTimeBilling, 'save free one-time billing');
    assert.equal(freeOneTimeBilling.body.success, true, 'free one-time billing should save');

    const adminClientsAfterBilling = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(adminClientsAfterBilling, 'list admin nodes after billing edit');
    const billedClient = expectArray(adminClientsAfterBilling.body, 'admin nodes after billing edit')
      .find((client) => client.uuid === uuid);
    assert.ok(billedClient, 'edited node should still exist after billing edit');
    assert.equal(billedClient.price, -1, 'free billing should store price -1');
    assert.equal(billedClient.billing_cycle, -1, 'one-time billing should store billing_cycle -1');

    const basicInfo = await request(mf, '/api/clients/uploadBasicInfo', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({
        name: 'Smoke Node',
        os: 'linux',
        arch: 'x64',
        cpu_name: 'Smoke CPU',
        cpu_cores: 2,
        mem_total: 1073741824,
        swap_total: 0,
        disk_total: 4294967296,
        ipv4: '192.0.2.10',
        version: 'smoke-agent',
      }),
    });
    assertOk(basicInfo, 'agent basic info upload');
    assert.equal(basicInfo.body.success, true, 'basic info upload should succeed');

    const settings = await request(mf, '/api/admin/settings', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        notification_method: 'telegram',
        telegram_bot_token: '123456:smoke',
        telegram_chat_id: '98765',
        enable_ip_change_notification: true,
      }),
    });
    assertOk(settings, 'save telegram settings');
    assert.equal(settings.body.success, true, 'telegram settings should save');

    const rejectedRegister = await request(mf, '/api/clients/register', {
      method: 'POST',
      headers: jsonHeaders,
      body: jsonBody({ name: 'Rejected Auto Node', version: 'smoke-agent' }),
    });
    assert.equal(rejectedRegister.response.status, 410, 'agent auto registration should be removed');

    const secondClient = await request(mf, '/api/admin/clients/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ name: 'Second Smoke Node' }),
    });
    assertOk(secondClient, 'create second node');
    assert.match(secondClient.body.uuid, /^[0-9a-f-]{36}$/i, 'second node should return uuid');
    assert.match(secondClient.body.token, /^[0-9a-f-]{36}$/i, 'second node should return token');
    const secondBasicInfo = await request(mf, '/api/clients/uploadBasicInfo', {
      method: 'POST',
      headers: agentHeaders(secondClient.body.token),
      body: jsonBody({
        name: 'Second Smoke Node',
        os: 'linux',
        arch: 'x64',
        cpu_name: 'Auto CPU',
        cpu_cores: 1,
        mem_total: 536870912,
        swap_total: 0,
        disk_total: 1073741824,
        version: 'smoke-agent',
      }),
    });
    assertOk(secondBasicInfo, 'second agent basic info upload');

    const adminClientsBeforeReorder = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(adminClientsBeforeReorder, 'list admin nodes before reorder');
    const reorderTargetUuids = expectArray(adminClientsBeforeReorder.body, 'admin nodes before reorder')
      .map((client) => client.uuid)
      .filter((id) => id === uuid || id === secondClient.body.uuid);
    assert.deepEqual(
      reorderTargetUuids,
      [uuid, secondClient.body.uuid],
      'new clients should initially follow creation sort order',
    );

    const reorderClients = await request(mf, '/api/admin/clients/reorder', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ uuids: [secondClient.body.uuid, uuid] }),
    });
    assertOk(reorderClients, 'reorder admin nodes');
    assert.equal(reorderClients.body.success, true, 'client reorder should succeed');

    const adminClientsAfterReorder = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(adminClientsAfterReorder, 'list admin nodes after reorder');
    const reorderedClientUuids = expectArray(adminClientsAfterReorder.body, 'admin nodes after reorder')
      .map((client) => client.uuid)
      .filter((id) => id === uuid || id === secondClient.body.uuid);
    assert.deepEqual(
      reorderedClientUuids,
      [secondClient.body.uuid, uuid],
      'admin client list should follow explicit sort order',
    );

    const batchHideClient = await request(mf, '/api/admin/clients/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ name: 'Batch Hide Node' }),
    });
    assertOk(batchHideClient, 'create batch hide node');
    const batchHide = await request(mf, '/api/admin/clients/batch-hide', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ uuids: [batchHideClient.body.uuid] }),
    });
    assertOk(batchHide, 'batch hide node');
    assert.equal(batchHide.body.updated, 1, 'batch hide should update one node');
    const batchHiddenClients = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(batchHiddenClients, 'list clients after batch hide');
    assert.equal(
      expectArray(batchHiddenClients.body, 'clients after batch hide').find((client) => client.uuid === batchHideClient.body.uuid)?.hidden,
      1,
      'batch hidden node should be marked hidden',
    );
    const removeBatchHiddenClient = await request(mf, '/api/admin/clients/batch-remove', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ uuids: [batchHideClient.body.uuid] }),
    });
    assertOk(removeBatchHiddenClient, 'remove batch hidden node');

    const batchDeleteClient = await request(mf, '/api/admin/clients/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ name: 'Batch Delete Node' }),
    });
    assertOk(batchDeleteClient, 'create batch delete node');
    const batchRemove = await request(mf, '/api/admin/clients/batch-remove', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ uuids: [batchDeleteClient.body.uuid] }),
    });
    assertOk(batchRemove, 'batch remove node');
    assert.equal(batchRemove.body.removed, 1, 'batch remove should delete one node');
    const batchRemovedClients = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(batchRemovedClients, 'list clients after batch remove');
    assert.equal(
      expectArray(batchRemovedClients.body, 'clients after batch remove').some((client) => client.uuid === batchDeleteClient.body.uuid),
      false,
      'batch removed node should not remain in admin list',
    );

    const capacityEstimate = await request(mf, '/api/admin/capacity', {
      headers: authHeaders(cookie),
    });
    assertOk(capacityEstimate, 'capacity estimate');
    assert.equal(capacityEstimate.body.risk_level, 'ok', 'small smoke dataset should have ok capacity risk');
    assert.ok(
      capacityEstimate.body.d1_reference_rows?.free_reference_rows > 0,
      'capacity estimate should include D1 Free retained-row planning reference',
    );
    assert.ok(
      capacityEstimate.body.quota_reference?.d1?.storage_bytes?.free_database > 0,
      'capacity estimate should expose official D1 Free database storage bytes',
    );
    assert.equal(
      capacityEstimate.body.quota_reference?.d1?.rows_written_per_day?.free,
      100000,
      'capacity estimate should expose official D1 Free daily rows written',
    );
    assert.equal(
      capacityEstimate.body.quota_reference?.d1?.rows_written_per_day?.paid_monthly_included,
      50000000,
      'capacity estimate should expose D1 Paid monthly included rows written',
    );
    assert.ok(
      capacityEstimate.body.d1_reference_rows?.paid_reference_rows > capacityEstimate.body.d1_reference_rows?.free_reference_rows,
      'capacity estimate should include a higher D1 Paid retained-row planning reference',
    );

    const report = await request(mf, '/api/clients/report', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({
        cpu: 12.5,
        gpu: 0,
        ram: 536870912,
        ram_total: 1073741824,
        swap: 0,
        swap_total: 0,
        load: 0.42,
        temp: 45,
        disk: 2147483648,
        disk_total: 4294967296,
        net_in: 100,
        net_out: 200,
        net_total_up: 1000,
        net_total_down: 2000,
        process_count: 42,
        connections: 3,
        connections_udp: 1,
        uptime: 12345,
        report_interval: 60,
        version: 'smoke-agent',
        ipv4: '192.0.2.11',
      }),
    });
    assertOk(report, 'agent report');
    assert.equal(report.body.success, true, 'agent report should succeed');
    assert.equal(report.body.persisted, true, 'agent report should persist one history record');

    const throttledReport = await request(mf, '/api/clients/report', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({
        cpu: 13.5,
        ram: 536870912,
        ram_total: 1073741824,
        disk: 2147483648,
        disk_total: 4294967296,
        net_in: 101,
        net_out: 201,
      }),
    });
    assertOk(throttledReport, 'throttled agent report');
    assert.equal(throttledReport.body.success, true, 'throttled agent report should still update live state');
    assert.equal(throttledReport.body.persisted, false, 'agent report should respect the configured history persist interval');

    assert.equal(telegramRequests.length, 1, 'report IP change should call Telegram API once');
    assert.match(telegramRequests[0].payload.text, /IPv4: 192\.0\.2\.10/, 'IP change notification should include the old IPv4');
    assert.match(telegramRequests[0].payload.text, /192\.0\.2\.11/, 'IP change notification should include the new IPv4');

    const adminClientsAfterReport = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(adminClientsAfterReport, 'list admin nodes after IP change report');
    assert.ok(
      expectArray(adminClientsAfterReport.body, 'admin nodes after IP change')
        .some((client) => client.uuid === uuid && client.ipv4 === '192.0.2.11'),
      'agent report should update the stored client IPv4',
    );

    const logsAfterIpChange = await request(mf, '/api/admin/logs?limit=20', {
      headers: authHeaders(cookie),
    });
    assertOk(logsAfterIpChange, 'logs after IP change report');
    assert.ok(
      expectArray(logsAfterIpChange.body.data, 'audit logs after IP change')
        .some((log) => log.action === 'ip_change'),
      'audit logs should include report-driven ip_change',
    );
    telegramRequests.length = 0;

    const rotatedToken = await request(mf, `/api/admin/clients/${uuid}/token/rotate`, {
      method: 'POST',
      headers: authHeaders(cookie),
    });
    assertOk(rotatedToken, 'rotate client token');
    assert.equal(rotatedToken.body.success, true, 'token rotation should succeed');
    assert.match(rotatedToken.body.token, /^[0-9a-f-]{36}$/i, 'rotated token should be uuid-like');
    assert.notEqual(rotatedToken.body.token, token, 'rotated token should differ from original token');
    const oldTokenReport = await request(mf, '/api/clients/report', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({ cpu: 99 }),
    });
    assert.equal(oldTokenReport.response.status, 401, 'old token should be rejected after rotation');
    token = rotatedToken.body.token;
    const queryTokenReport = await request(mf, `/api/clients/report?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: jsonHeaders,
      body: jsonBody({ cpu: 99 }),
    });
    assert.equal(queryTokenReport.response.status, 401, 'agent report query token should be rejected');
    const rotatedTokenReport = await request(mf, '/api/clients/report', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({
        cpu: 12.5,
        gpu: 0,
        ram: 536870912,
        ram_total: 1073741824,
        swap: 0,
        swap_total: 0,
        load: 0.42,
        temp: 45,
        disk: 2147483648,
        disk_total: 4294967296,
        net_in: 100,
        net_out: 200,
        net_total_up: 1000,
        net_total_down: 2000,
        process_count: 42,
        connections: 3,
        connections_udp: 1,
        uptime: 12345,
        report_interval: 60,
        version: 'smoke-agent',
        ipv4: '192.0.2.11',
      }),
    });
    assertOk(rotatedTokenReport, 'agent report with rotated token');

    const live = await request(mf, '/api/live');
    assertOk(live, 'live snapshot');
    assertPublicCache(live, 'live snapshot cache', 2);
    assert.ok(expectArray(live.body.online, 'live online').includes(uuid), 'live snapshot should show the node online');
    assert.equal(live.body.data?.[uuid]?.cpu, 12.5, 'live snapshot should include latest CPU value');

    const agentWsResponse = await mf.dispatchFetch(`${baseUrl}/api/clients/report`, {
      headers: {
        Upgrade: 'websocket',
        Origin: baseUrl,
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(agentWsResponse.status, 101, 'agent websocket should upgrade');
    const agentWs = agentWsResponse.webSocket;
    assert.ok(agentWs, 'agent websocket response should include client socket');
    agentWs.accept();
    const initialPolicy = await waitForWebSocketMessage(
      agentWs,
      (message) => message?.type === 'policy',
      'initial agent policy',
    );
    assert.equal(initialPolicy.mode, 'idle', 'agent policy should start idle without viewers');
    assert.equal(initialPolicy.report_interval_sec, 600, 'idle agent policy should default to 10 minutes');

    const missingViewerToken = await mf.dispatchFetch(`${baseUrl}/api/ws/live`, {
      headers: {
        Upgrade: 'websocket',
        Origin: baseUrl,
      },
    });
    assert.equal(missingViewerToken.status, 401, 'live viewer websocket should require a short-lived token');

    const viewerIp = '198.51.100.10';
    const viewerUrl = await viewerSocketUrl(mf, viewerIp);
    const wrongIpViewer = await mf.dispatchFetch(viewerUrl, {
      headers: {
        Upgrade: 'websocket',
        Origin: baseUrl,
        'CF-Connecting-IP': '198.51.100.11',
      },
    });
    assert.equal(wrongIpViewer.status, 403, 'viewer token should be bound to the requesting IP');

    const expiredViewerIp = '198.51.100.12';
    const expiredViewerToken = await signedViewerToken({
      ip: expiredViewerIp,
      secret: jwtSecret,
      exp: Date.now() - 1000,
    });
    const expiredViewer = await mf.dispatchFetch(`${baseUrl}/api/ws/live?viewer_token=${encodeURIComponent(expiredViewerToken)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: baseUrl,
        'CF-Connecting-IP': expiredViewerIp,
      },
    });
    assert.equal(expiredViewer.status, 403, 'expired viewer token should not open a live websocket');

    const activePolicyPromise = waitForWebSocketMessage(
      agentWs,
      (message) => message?.type === 'policy' && message.mode === 'active',
      'active agent policy',
    );
    const viewerWsResponse = await mf.dispatchFetch(viewerUrl, {
      headers: {
        Upgrade: 'websocket',
        Origin: baseUrl,
        'CF-Connecting-IP': viewerIp,
      },
    });
    assert.equal(viewerWsResponse.status, 101, 'live viewer websocket should upgrade');
    const viewerWs = viewerWsResponse.webSocket;
    assert.ok(viewerWs, 'live viewer websocket response should include client socket');
    viewerWs.accept();
    const viewerSnapshot = await waitForWebSocketMessage(
      viewerWs,
      (message) => message?.type === 'snapshot',
      'live viewer snapshot',
    );
    const activePolicy = await activePolicyPromise;
    assert.equal(activePolicy.report_interval_sec, 3, 'active agent policy should default to 3 seconds');
    assert.equal(activePolicy.report_now, true, 'first active viewer should ask agent to report immediately');
    assert.equal(activePolicy.viewer_count, 1, 'active agent policy should include viewer count');
    assert.ok(
      expectArray(viewerSnapshot.online, 'viewer websocket online').includes(uuid),
      'viewer websocket snapshot should show the node online',
    );
    const idlePolicyAfterClosePromise = waitForWebSocketMessage(
      agentWs,
      (message) => message?.type === 'policy' && message.mode === 'idle',
      'idle agent policy after viewer close',
    );
    viewerWs.close(1000, 'smoke complete');
    const idlePolicyAfterClose = await idlePolicyAfterClosePromise;
    assert.equal(idlePolicyAfterClose.report_interval_sec, 600, 'agent policy should return idle after viewer close');

    const limitedViewerSockets = [];
    const limitedViewerIp = '203.0.113.9';
    for (let i = 0; i < 8; i += 1) {
      const limitedViewer = await mf.dispatchFetch(await viewerSocketUrl(mf, limitedViewerIp), {
        headers: {
          Upgrade: 'websocket',
          Origin: baseUrl,
          'CF-Connecting-IP': limitedViewerIp,
        },
      });
      assert.equal(limitedViewer.status, 101, `viewer websocket ${i + 1} from same IP should upgrade`);
      assert.ok(limitedViewer.webSocket, `viewer websocket ${i + 1} from same IP should include client socket`);
      limitedViewer.webSocket.accept();
      limitedViewerSockets.push(limitedViewer.webSocket);
    }
    const blockedViewer = await mf.dispatchFetch(await viewerSocketUrl(mf, limitedViewerIp), {
      headers: {
        Upgrade: 'websocket',
        Origin: baseUrl,
        'CF-Connecting-IP': limitedViewerIp,
      },
    });
    assert.equal(blockedViewer.status, 429, 'ninth viewer websocket from same IP should be rate limited');
    assert.equal(blockedViewer.headers.get('retry-after'), '60', 'limited viewer response should include Retry-After');
    for (const socket of limitedViewerSockets) {
      socket.close(1000, 'smoke complete');
    }

    const agentAckPromise = waitForWebSocketMessage(
      agentWs,
      (message) => message?.type === 'ack',
      'agent websocket ack',
    );
    agentWs.send(jsonBody({
      cpu: 23.5,
      gpu: 0,
      ram: 536870912,
      ram_total: 1073741824,
      swap: 0,
      swap_total: 0,
      load: 0.5,
      temp: 46,
      disk: 2147483648,
      disk_total: 4294967296,
      net_in: 150,
      net_out: 250,
      net_total_up: 1100,
      net_total_down: 2100,
      process_count: 43,
      connections: 4,
      connections_udp: 1,
      uptime: 12400,
    }));
    await agentAckPromise;
    const liveAfterAgentWebSocket = await request(mf, '/api/live');
    assertOk(liveAfterAgentWebSocket, 'live snapshot after agent websocket report');
    assert.equal(
      liveAfterAgentWebSocket.body.data?.[uuid]?.cpu,
      23.5,
      'agent websocket report should update Durable Object live state',
    );

    const publicClients = await request(mf, '/api/clients');
    assertOk(publicClients, 'public node list');
    assertPublicCache(publicClients, 'public node list cache', 30);
    assert.ok(
      expectArray(publicClients.body, 'public nodes').some((client) => client.uuid === uuid && client.name === 'Smoke Node'),
      'public node list should include the created node without admin auth',
    );

    const publicSettings = await request(mf, '/api/public');
    assertOk(publicSettings, 'public settings');
    assertSecurityHeaders(publicSettings, 'public settings');
    assertPublicCache(publicSettings, 'public settings cache', 30);

    const refreshedPolicyPromise = waitForWebSocketMessage(
      agentWs,
      (message) => message?.type === 'policy',
      'refreshed agent policy after settings save',
    );
    const updateLivePolicySettings = await request(mf, '/api/admin/settings', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        live_poll_active_interval_sec: '5',
        live_poll_idle_interval_sec: '300',
        live_poll_active_max_duration_sec: '300',
      }),
    });
    assertOk(updateLivePolicySettings, 'update live policy settings');
    assert.equal(updateLivePolicySettings.body.success, true, 'live policy settings update should succeed');
    const refreshedPolicy = await refreshedPolicyPromise;
    assert.equal(refreshedPolicy.mode, 'idle', 'refreshed agent policy should stay idle without viewers');
    assert.equal(refreshedPolicy.report_interval_sec, 300, 'idle policy should use saved 5 minute interval');
    assert.equal(refreshedPolicy.viewer_ttl_sec, 300, 'policy should include saved 5 minute viewer TTL');

    const httpAgentPolicy = await request(mf, '/api/clients/policy', {
      headers: agentHeaders(token),
    });
    assertOk(httpAgentPolicy, 'HTTP agent policy');
    assert.equal(httpAgentPolicy.body.type, 'policy', 'HTTP agent policy should return a policy message');
    assert.equal(httpAgentPolicy.body.mode, 'idle', 'HTTP agent policy should reflect idle mode without viewers');
    assert.equal(httpAgentPolicy.body.report_interval_sec, 300, 'HTTP agent policy should use saved idle interval');

    const history = await request(mf, `/api/recent/${uuid}?limit=5`);
    assertOk(history, 'public history');
    assertPublicCache(history, 'public history cache', 10);
    assert.ok(
      expectArray(history.body, 'history records').some((record) => record.client === uuid && record.cpu === 12.5),
      'history should include the persisted report',
    );

    const rateLimitHeaders = { 'CF-Connecting-IP': '198.51.100.77' };
    for (let i = 0; i < 60; i += 1) {
      const allowed = await request(mf, `/api/records/load?uuid=${uuid}&limit=1`, {
        headers: rateLimitHeaders,
      });
      assertOk(allowed, `public history rate limit warmup ${i + 1}`);
    }
    const limited = await request(mf, `/api/records/load?uuid=${uuid}&limit=1`, {
      headers: rateLimitHeaders,
    });
    assert.equal(limited.response.status, 429, 'public history should be rate limited after 60 requests per minute');
    assert.ok(limited.response.headers.get('retry-after'), 'rate limited response should include Retry-After');
    assert.equal(limited.response.headers.get('x-ratelimit-limit'), '60', 'rate limit response should expose limit');
    assert.equal(limited.response.headers.get('cache-control'), 'no-store', 'rate limited response should not be cached');

    const addPingTask = await request(mf, '/api/admin/ping/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        name: 'Smoke Ping',
        type: 'http',
        target: 'https://example.com',
        interval_sec: 60,
        all_clients: true,
        clients: [],
      }),
    });
    assertOk(addPingTask, 'create ping task');
    assert.equal(addPingTask.body.success, true, 'ping task creation should succeed');

    const addSecondPingTask = await request(mf, '/api/admin/ping/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        name: 'Smoke Ping Second',
        type: 'http',
        target: 'https://example.org',
        interval_sec: 120,
        all_clients: true,
        clients: [],
      }),
    });
    assertOk(addSecondPingTask, 'create second ping task');
    assert.equal(addSecondPingTask.body.success, true, 'second ping task creation should succeed');

    const adminPingTasks = await request(mf, '/api/admin/ping', {
      headers: authHeaders(cookie),
    });
    assertOk(adminPingTasks, 'list admin ping tasks');
    const createdPingTasks = expectArray(adminPingTasks.body, 'admin ping tasks')
      .filter((task) => task.name === 'Smoke Ping' || task.name === 'Smoke Ping Second');
    const pingTask = createdPingTasks.find((task) => task.name === 'Smoke Ping' && task.target === 'https://example.com');
    const secondPingTask = createdPingTasks.find((task) => task.name === 'Smoke Ping Second' && task.target === 'https://example.org');
    assert.ok(pingTask?.id, 'admin ping list should include the created task id');
    assert.ok(secondPingTask?.id, 'admin ping list should include the second created task id');
    assert.ok(
      Number(pingTask.sort_order) < Number(secondPingTask.sort_order),
      'new ping tasks should receive ascending sort_order values',
    );

    const reorderPingTasks = await request(mf, '/api/admin/ping/reorder', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ ids: [secondPingTask.id, pingTask.id] }),
    });
    assertOk(reorderPingTasks, 'reorder ping tasks');
    assert.equal(reorderPingTasks.body.success, true, 'ping task reorder should succeed');

    const reorderedAdminPingTasks = await request(mf, '/api/admin/ping', {
      headers: authHeaders(cookie),
    });
    assertOk(reorderedAdminPingTasks, 'list reordered admin ping tasks');
    const reorderedCreatedTasks = expectArray(reorderedAdminPingTasks.body, 'reordered admin ping tasks')
      .filter((task) => task.name === 'Smoke Ping' || task.name === 'Smoke Ping Second');
    assert.deepEqual(
      reorderedCreatedTasks.map((task) => task.id),
      [secondPingTask.id, pingTask.id],
      'admin ping tasks should follow explicit sort order',
    );

    const agentPingTasks = await request(mf, '/api/clients/ping/tasks', {
      headers: agentHeaders(token),
    });
    assertOk(agentPingTasks, 'agent ping tasks');
    const agentCreatedPingTasks = expectArray(agentPingTasks.body, 'agent ping tasks')
      .filter((task) => task.id === pingTask.id || task.id === secondPingTask.id);
    assert.deepEqual(
      agentCreatedPingTasks.map((task) => task.id),
      [secondPingTask.id, pingTask.id],
      'agent ping tasks should follow explicit sort order',
    );

    const capacity = await request(mf, '/api/admin/capacity', {
      headers: authHeaders(cookie),
    });
    assertOk(capacity, 'admin capacity estimate');
    assert.equal(capacity.body.clients, 2, 'capacity should count clients');
    assert.equal(capacity.body.capacity_daily_view_minutes, 60, 'capacity should default to one hour of daily viewing');
    assert.equal(capacity.body.record_persist_interval_sec, 60, 'capacity should include the D1 history persist interval');
    assert.equal(capacity.body.record_high_watermark_rows, 450000, 'capacity should include the D1 history high-watermark');
    assert.equal(capacity.body.active_monitor_records_per_day, 120, 'capacity should estimate active monitor writes from daily viewing minutes');
    assert.equal(capacity.body.idle_monitor_records_per_day, 552, 'capacity should estimate idle monitor writes for the rest of the day');
    assert.equal(capacity.body.monitor_records_per_day, 672, 'capacity should blend active and idle monitor writes');
    assert.equal(capacity.body.ping_records_per_day, 4320, 'capacity should estimate ping records per day for 60s and 120s all-client tasks');
    assert.equal(capacity.body.total_estimated_writes_per_day, 4992, 'capacity should estimate blended total writes per day');
    assert.ok(capacity.body.actual_row_counts, 'capacity should include actual storage row counts');

    const maintenanceCleanup = await request(mf, '/api/admin/maintenance/cleanup', {
      method: 'POST',
      headers: authHeaders(cookie),
    });
    assertOk(maintenanceCleanup, 'manual maintenance cleanup');
    assert.equal(maintenanceCleanup.body.success, true, 'manual maintenance cleanup should succeed');
    assert.ok(maintenanceCleanup.body.deleted, 'manual maintenance cleanup should return deleted counts');
    assert.ok(maintenanceCleanup.body.expired_backlog_before, 'manual maintenance cleanup should return backlog before');
    assert.ok(maintenanceCleanup.body.expired_backlog_after, 'manual maintenance cleanup should return backlog after');

    const invalidOfflineNotification = await request(mf, '/api/admin/notification/offline/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ client: 'missing-client', enable: true, grace_period: 180 }),
    });
    assert.equal(invalidOfflineNotification.response.status, 400, 'offline notification should reject unknown clients');

    const invalidLoadNotification = await request(mf, '/api/admin/notification/load/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        name: 'Bad load rule',
        clients: ['missing-client'],
        metric: 'cpu',
        threshold: 80,
        ratio: 2,
        interval_min: 15,
      }),
    });
    assert.equal(invalidLoadNotification.response.status, 400, 'load notification should reject invalid client and ratio');

    const validLoadNotification = await request(mf, '/api/admin/notification/load/add', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        name: 'Smoke CPU rule',
        clients: [uuid],
        metric: 'cpu',
        threshold: 80,
        ratio: 0.8,
        interval_min: 15,
      }),
    });
    assertOk(validLoadNotification, 'valid load notification');
    assert.equal(validLoadNotification.body.success, true, 'valid load notification should save');

    const pingResult = await request(mf, '/api/clients/ping/result', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({ task_id: pingTask.id, value: 37 }),
    });
    assertOk(pingResult, 'agent ping result');
    assert.equal(pingResult.body.success, true, 'ping result should succeed');
    assert.equal(pingResult.body.accepted, 1, 'ping result should accept one result');

    const duplicatePingResult = await request(mf, '/api/clients/ping/result', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({ task_id: pingTask.id, value: 38 }),
    });
    assertOk(duplicatePingResult, 'duplicate agent ping result');
    assert.equal(duplicatePingResult.body.success, true, 'duplicate ping result should still return success');
    assert.equal(duplicatePingResult.body.accepted, 0, 'duplicate ping result should be interval-limited by the Durable Object');

    const pingHistory = await request(mf, `/api/records/ping?uuid=${uuid}&task_id=${pingTask.id}&limit=5`);
    assertOk(pingHistory, 'public ping history');
    assert.ok(
      expectArray(pingHistory.body, 'ping history').some((record) => record.client === uuid && record.value === 37),
      'public ping history should include reported value',
    );

    const backupPassword = 'smoke-backup-password';
    const backupDownloadWithoutPassword = await request(mf, '/api/admin/download/backup', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ backup_password: 'short' }),
    });
    assert.equal(backupDownloadWithoutPassword.response.status, 400, 'encrypted backup should require a strong backup password');

    const backupDownload = await request(mf, '/api/admin/download/backup', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ backup_password: backupPassword }),
    });
    assertOk(backupDownload, 'download encrypted backup');
    assert.equal(
      backupDownload.response.headers.get('x-cf-monitor-backup-encrypted'),
      'true',
      'backup download should mark encrypted contents in headers',
    );
    assert.equal(backupDownload.body.schema, 'cf-monitor.encrypted-backup', 'backup JSON should use encrypted schema');
    assert.equal(backupDownload.body.encrypted, true, 'backup JSON should be encrypted');
    assert.equal(typeof backupDownload.body.ciphertext, 'string', 'backup JSON should contain ciphertext');
    assert.equal(backupDownload.text.includes(token), false, 'encrypted backup should not contain client token plaintext');
    assert.equal(backupDownload.text.includes('smoke-register-key'), false, 'encrypted backup should not contain AutoDiscovery Key plaintext');
    assert.equal(backupDownload.text.includes('123456:smoke'), false, 'encrypted backup should not contain Telegram token plaintext');

    const backupDryRunWrongPassword = await request(mf, '/api/admin/upload/backup?dry_run=true', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ backup: backupDownload.body, backup_password: 'wrong-password' }),
    });
    assert.equal(backupDryRunWrongPassword.response.status, 400, 'encrypted backup dry-run should reject wrong password');

    const plaintextBackupDryRun = await request(mf, '/api/admin/upload/backup?dry_run=true', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        schema: 'cf-monitor.backup',
        version: '1.0.0',
        scope: 'configuration',
        clients: [],
      }),
    });
    assert.equal(plaintextBackupDryRun.response.status, 400, 'plaintext backup import should be rejected');

    const backupDryRun = await request(mf, '/api/admin/upload/backup?dry_run=true', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ backup: backupDownload.body, backup_password: backupPassword }),
    });
    assertOk(backupDryRun, 'encrypted backup dry-run restore');
    assert.equal(backupDryRun.body.dry_run, true, 'encrypted backup dry-run should not restore data');
    assert.ok(
      backupDryRun.body.restored?.clients >= 2,
      'encrypted backup dry-run should decrypt and summarize full clients',
    );

    const tgTest = await request(mf, '/api/admin/test/sendMessage', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ message: 'Smoke <TG> & check' }),
    });
    assertOk(tgTest, 'telegram test message');
    assert.equal(tgTest.body.success, true, 'telegram test should report success');
    assert.equal(telegramRequests.length, 1, 'telegram test should call Telegram API once');
    assert.equal(telegramRequests[0].payload.chat_id, '98765', 'telegram request should use configured chat id');
    assert.equal(telegramRequests[0].payload.text, 'Smoke &lt;TG&gt; &amp; check', 'telegram text should be HTML-escaped');

    const health = await request(mf, '/api/admin/health', {
      headers: authHeaders(cookie),
    });
    assertOk(health, 'admin health');
    assert.equal(health.body.ok, true, 'admin health should be ok after successful smoke flow');
    assert.equal(health.body.components?.d1_write_probe?.status, 'ok', 'health should include D1 write probe status');
    assert.equal(health.body.components?.schema_probe?.status, 'ok', 'health should include D1 schema probe status');
    assert.equal(health.body.components?.do_binding_probe?.status, 'ok', 'health should include Durable Object binding probe status');
    assert.equal(health.body.components?.secret_probe?.status, 'ok', 'health should include secret probe status');
    assert.equal(health.body.components?.do_record_persistence?.status, 'ok', 'health should include DO record persistence status');
    assert.equal(health.body.components?.ping_persistence?.status, 'ok', 'health should include ping persistence status');
    assert.equal(health.body.components?.telegram?.status, 'ok', 'health should include Telegram status');

    telegramShouldFail = true;
    const failedTgTest = await request(mf, '/api/admin/test/sendMessage', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ message: 'Smoke failure check' }),
    });
    assertOk(failedTgTest, 'failed telegram test response');
    assert.equal(failedTgTest.body.success, false, 'failed telegram test should report success=false');

    const unhealthyTelegram = await request(mf, '/api/admin/health', {
      headers: authHeaders(cookie),
    });
    assert.equal(unhealthyTelegram.response.status, 503, 'health should be unhealthy after Telegram failure');
    assert.equal(unhealthyTelegram.body.components?.telegram?.status, 'error', 'health should expose Telegram failure');

    const logsAfterTelegramFailure = await request(mf, '/api/admin/logs?limit=20', {
      headers: authHeaders(cookie),
    });
    assertOk(logsAfterTelegramFailure, 'logs after telegram failure');
    assert.ok(
      expectArray(logsAfterTelegramFailure.body.data, 'audit logs').some((log) => log.action === 'telegram_error'),
      'audit logs should include throttled telegram_error',
    );

    const d1 = await mf.getD1Database('DB');
    await d1.prepare('ALTER TABLE clients RENAME TO clients_with_sort').run();
    await d1.prepare(`
      CREATE TABLE clients (
        uuid TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        name TEXT DEFAULT '',
        hidden INTEGER DEFAULT 0,
        traffic_limit INTEGER DEFAULT 0,
        traffic_limit_type TEXT DEFAULT 'max'
      )
    `).run();
    const unhealthyMissingClientColumn = await request(mf, '/api/admin/health', {
      headers: authHeaders(cookie),
    });
    assert.equal(unhealthyMissingClientColumn.response.status, 503, 'health should be unhealthy when clients.sort_order is missing');
    assert.match(
      unhealthyMissingClientColumn.body.components?.schema_probe?.detail || '',
      /clients\.sort_order/,
      'health schema probe should expose missing clients.sort_order',
    );
    await d1.prepare('DROP TABLE clients').run();
    await d1.prepare('ALTER TABLE clients_with_sort RENAME TO clients').run();

    await d1.prepare('ALTER TABLE ping_tasks RENAME TO ping_tasks_with_sort').run();
    await d1.prepare(`
      CREATE TABLE ping_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        clients TEXT DEFAULT '[]',
        all_clients INTEGER DEFAULT 0,
        type TEXT DEFAULT 'icmp',
        target TEXT NOT NULL,
        interval_sec INTEGER DEFAULT 60
      )
    `).run();
    const unhealthyMissingColumn = await request(mf, '/api/admin/health', {
      headers: authHeaders(cookie),
    });
    assert.equal(unhealthyMissingColumn.response.status, 503, 'health should be unhealthy when a required column is missing');
    assert.match(
      unhealthyMissingColumn.body.components?.schema_probe?.detail || '',
      /ping_tasks\.sort_order/,
      'health schema probe should expose missing ping_tasks.sort_order',
    );
    await d1.prepare('DROP TABLE ping_tasks').run();
    await d1.prepare('ALTER TABLE ping_tasks_with_sort RENAME TO ping_tasks').run();

    await d1.prepare('DROP TABLE records').run();
    const liveAfterRecordsDrop = await request(mf, '/api/live');
    assertOk(liveAfterRecordsDrop, 'live snapshot after records table drop');
    assert.equal(
      liveAfterRecordsDrop.body.data?.[uuid]?.cpu,
      23.5,
      'live snapshot should come from Durable Object memory instead of querying D1 records',
    );
    agentWs.close(1000, 'smoke complete');

    expectedCronFailureLog = true;
    const cronFailure = await request(mf, '/api/admin/cron/run', {
      method: 'POST',
      headers: authHeaders(cookie),
    });
    expectedCronFailureLog = false;
    assertOk(cronFailure, 'manual cron failure trigger');

    const unhealthyCron = await request(mf, '/api/admin/health', {
      headers: authHeaders(cookie),
    });
    assert.equal(unhealthyCron.response.status, 503, 'health should be unhealthy after cron failure');
    assert.equal(unhealthyCron.body.components?.cron_cleanup?.status, 'error', 'health should expose cron cleanup failure');

    const logsAfterCronFailure = await request(mf, '/api/admin/logs?limit=20', {
      headers: authHeaders(cookie),
    });
    assertOk(logsAfterCronFailure, 'logs after cron failure');
    assert.ok(
      expectArray(logsAfterCronFailure.body.data, 'audit logs').some((log) => log.action === 'cron_cleanup_error'),
      'audit logs should include throttled cron_cleanup_error',
    );

    const ping = await request(mf, '/ping');
    assertOk(ping, 'ping');
    assertSecurityHeaders(ping, 'ping');

    const version = await request(mf, '/api/version');
    assertOk(version, 'version');
    assertSecurityHeaders(version, 'version');
    assert.equal(version.response.headers.get('cache-control'), 'no-store', 'version API response should not be cached');

    console.log('Smoke E2E passed: login, security headers, node create, agent report IP change, live view, public cache/rate-limit, history, ping task/result, telegram test, health, failure observability.');
  } finally {
    await mf.dispose();
    await removeWithRetry(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
