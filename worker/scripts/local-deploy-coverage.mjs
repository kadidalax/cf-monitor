import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { Miniflare } from 'miniflare';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, '..');
const tmpDir = resolve(workerRoot, '.tmp');
const bundlePath = resolve(tmpDir, 'local-deploy-coverage-worker.mjs');
const baseUrl = 'http://cf-monitor.local';
const adminUsername = 'admin';
const adminPassword = 'password123456';
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

function jsonBody(value) {
  return JSON.stringify(value);
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

function assertOk(result, label) {
  assert.ok(result.response.ok, `${label} failed: HTTP ${result.response.status} ${result.text}`);
}

function assertPublicCache(result, label) {
  const cacheControl = result.response.headers.get('cache-control') || '';
  assert.match(cacheControl, /\bmax-age=\d+\b/, `${label} should be cacheable, got ${cacheControl}`);
}

function uuidFor(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function isoAt(baseMs, offsetMs) {
  return new Date(baseMs + offsetMs).toISOString();
}

function gib(value) {
  return value * 1024 * 1024 * 1024;
}

async function batchRun(d1, statements, chunkSize = 80) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await d1.batch(statements.slice(i, i + chunkSize));
  }
}

async function seedCoverageData(mf) {
  const d1 = await mf.getD1Database('DB');
  const now = Date.now();
  const clientStmt = d1.prepare(`
    INSERT INTO clients (
      uuid, token, name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden, traffic_limit,
      traffic_limit_type, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clients = [];
  for (let i = 1; i <= 48; i += 1) {
    const uuid = uuidFor(i);
    const hidden = i % 11 === 0 ? 1 : 0;
    clients.push({ uuid, token: `coverage-token-${i}`, hidden });
  }
  await batchRun(d1, clients.map(({ uuid, token, hidden }, index) => {
    const i = index + 1;
    return clientStmt.bind(
      uuid,
      token,
      `Coverage Node ${String(i).padStart(2, '0')} ${i % 7 === 0 ? 'Very Long Name '.repeat(4) : ''}`.trim(),
      i % 3 === 0 ? 'AMD EPYC 9654' : 'Intel Xeon Gold',
      i % 2 === 0 ? 'kvm' : 'vmware',
      i % 5 === 0 ? 'arm64' : 'amd64',
      2 + (i % 32),
      i % 4 === 0 ? 'Debian 12' : 'Ubuntu 24.04',
      '6.8.0-coverage',
      i % 6 === 0 ? 'NVIDIA RTX 4090; NVIDIA T4' : '',
      `192.0.2.${i}`,
      i % 4 === 0 ? `2001:db8::${i}` : '',
      ['US', 'JP', 'DE', 'SG', 'BR', 'NL'][i % 6],
      `private remark ${i}`,
      `public remark ${i}`,
      gib(2 + (i % 64)),
      gib(i % 8),
      gib(64 + i * 8),
      'coverage-agent',
      i % 8 === 0 ? -1 : i,
      30,
      i % 9 === 0 ? 1 : 0,
      '$',
      i % 13 === 0 ? isoAt(now, -24 * 60 * 60 * 1000) : null,
      ['edge', 'gpu', 'db', 'backup'][i % 4],
      i % 4 === 0 ? 'ipv4;prod;gpu' : 'prod;edge',
      hidden,
      gib(1000 + i),
      i % 2 === 0 ? 'sum' : 'max',
      i,
      isoAt(now, -i * 60 * 1000),
      isoAt(now, -i * 30 * 1000),
    );
  }));

  const recordStmt = d1.prepare(`
    INSERT INTO records (
      client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
      disk, disk_total, net_in, net_out, net_total_up, net_total_down,
      process_count, connections, connections_udp, uptime
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const gpuStmt = d1.prepare(`
    INSERT INTO gpu_records (
      client, time, device_index, device_name, mem_total, mem_used, utilization, temperature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pingStmt = d1.prepare('INSERT INTO ping_records (client, task_id, time, value) VALUES (?, ?, ?, ?)');
  const recordStatements = [];
  const gpuStatements = [];
  const pingStatements = [];
  for (let clientIndex = 1; clientIndex <= clients.length; clientIndex += 1) {
    const uuid = uuidFor(clientIndex);
    for (let sample = 0; sample < 72; sample += 1) {
      const time = isoAt(now, -sample * 60 * 1000);
      const cpu = (clientIndex * 7 + sample) % 100;
      recordStatements.push(recordStmt.bind(
        uuid,
        time,
        cpu,
        clientIndex % 6 === 0 ? (cpu + 20) % 100 : 0,
        (1_000_000_000 + clientIndex * 10_000_000 + sample * 1000),
        8_000_000_000,
        sample * 1000,
        1_000_000_000,
        Number((cpu / 20).toFixed(2)),
        35 + (sample % 40),
        10_000_000_000 + sample * 1000,
        100_000_000_000,
        sample * 1024,
        sample * 2048,
        1_000_000_000 + sample * 10_000,
        2_000_000_000 + sample * 20_000,
        80 + sample,
        100 + sample,
        20 + sample,
        3600 + sample,
      ));
      if (clientIndex % 6 === 0 && sample < 36) {
        gpuStatements.push(gpuStmt.bind(
          uuid,
          time,
          0,
          'NVIDIA RTX 4090',
          24 * 1024 * 1024 * 1024,
          (sample + 1) * 128 * 1024 * 1024,
          (cpu + 12) % 100,
          45 + (sample % 20),
        ));
      }
      if (sample < 48) {
        pingStatements.push(pingStmt.bind(uuid, 1, time, 20 + ((sample + clientIndex) % 80)));
        if (clientIndex % 3 === 0) {
          pingStatements.push(pingStmt.bind(uuid, 2, time, 50 + ((sample + clientIndex) % 120)));
        }
      }
    }
  }

  const oldTime = isoAt(now, -96 * 60 * 60 * 1000);
  for (let i = 1; i <= 12; i += 1) {
    const uuid = uuidFor(i);
    recordStatements.push(recordStmt.bind(uuid, oldTime, 1, 0, 1, 2, 0, 0, 0.1, 30, 1, 2, 0, 0, 0, 0, 1, 1, 0, 1));
    gpuStatements.push(gpuStmt.bind(uuid, oldTime, 0, 'Old GPU', 1, 1, 1, 30));
    pingStatements.push(pingStmt.bind(uuid, 1, oldTime, 999));
  }

  await batchRun(d1, recordStatements, 100);
  await batchRun(d1, gpuStatements, 100);
  await d1.prepare('INSERT INTO ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order) VALUES (1, ?, ?, 1, ?, ?, 60, 1)')
    .bind('All Nodes HTTPS', '[]', 'http', 'https://example.com').run();
  await d1.prepare('INSERT INTO ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order) VALUES (2, ?, ?, 0, ?, ?, 120, 2)')
    .bind('Subset TCP', JSON.stringify(clients.slice(0, 18).map(client => client.uuid)), 'tcp', 'example.com:443').run();
  await batchRun(d1, pingStatements, 100);

  const offlineStmt = d1.prepare('INSERT OR REPLACE INTO offline_notifications (client, enable, grace_period, last_notified) VALUES (?, ?, ?, ?)');
  await batchRun(d1, clients.slice(0, 16).map((client, index) =>
    offlineStmt.bind(client.uuid, index % 2 === 0 ? 1 : 0, 120 + index, index % 3 === 0 ? isoAt(now, -3600_000) : null),
  ));
  await d1.prepare('INSERT INTO load_notifications (name, clients, metric, threshold, ratio, interval_min) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('CPU Coverage', JSON.stringify(clients.slice(0, 12).map(client => client.uuid)), 'cpu', 85, 0.75, 15).run();
  await d1.prepare('INSERT INTO load_notifications (name, clients, metric, threshold, ratio, interval_min) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('RAM Coverage', JSON.stringify(clients.slice(12, 24).map(client => client.uuid)), 'ram', 90, 0.8, 30).run();
  for (let i = 0; i < 24; i += 1) {
    await d1.prepare('INSERT INTO audit_logs (time, user, action, detail, level) VALUES (?, ?, ?, ?, ?)')
      .bind(isoAt(now, -i * 60_000), 'coverage', `coverage_${i}`, `detail ${i}`, i % 5 === 0 ? 'warn' : 'info').run();
  }

  return {
    clients,
    visibleCount: clients.filter(client => !client.hidden).length,
    hiddenCount: clients.filter(client => client.hidden).length,
  };
}

async function main() {
  await bundleWorker();
  const mf = new Miniflare({
    modules: true,
    scriptPath: bundlePath,
    compatibilityDate: '2025-04-01',
    bindings: {
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD: adminPassword,
      SITE_TITLE: 'CF Monitor',
      SITE_DESCRIPTION: 'Local deployment coverage',
    },
    d1Databases: { DB: 'coverage-db' },
    durableObjects: { LIVE_DATA: 'LiveDataDO', RATE_LIMIT: 'RateLimitDO' },
    migrations: [
      { tag: 'v1', newClasses: ['LiveDataDO'] },
      { tag: 'v2', newClasses: ['RateLimitDO'] },
    ],
    serviceBindings: {
      'api.telegram.org': async () => new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    },
  });

  try {
    await applyMigrations(mf);
    const seeded = await seedCoverageData(mf);

    const login = await request(mf, '/api/login', {
      method: 'POST',
      headers: { ...jsonHeaders, 'CF-Connecting-IP': '198.51.100.50' },
      body: jsonBody({ username: adminUsername, password: adminPassword }),
    });
    assertOk(login, 'admin login');
    const cookie = login.response.headers.get('set-cookie') || '';
    const csrfToken = login.body.csrf_token || parseCookie(cookie, 'cf_monitor_csrf');
    const sessionToken = parseCookie(cookie, 'cf_monitor_session');
    assert.ok(csrfToken, 'login should provide a CSRF token');
    assert.ok(sessionToken, 'login should set a session cookie');
    const adminCookie = `cf_monitor_session=${sessionToken}; cf_monitor_csrf=${csrfToken}`;
    const adminHeaders = authHeaders(adminCookie, csrfToken);

    const adminClients = await request(mf, '/api/admin/clients', { headers: adminHeaders });
    assertOk(adminClients, 'admin clients');
    assert.equal(adminClients.body.length, seeded.clients.length, 'admin should see all seeded clients');

    const publicClients = await request(mf, '/api/clients');
    assertOk(publicClients, 'public clients');
    assertPublicCache(publicClients, 'public clients');
    assert.equal(publicClients.body.length, seeded.visibleCount, 'public clients should hide hidden nodes');
    assert.equal(publicClients.body.some(client => client.token), false, 'public clients should not expose tokens');
    assert.equal(publicClients.body.some(client => client.ipv4), false, 'public clients should not expose raw IPv4');

    const publicNodes = await request(mf, '/api/nodes');
    assertOk(publicNodes, 'public nodes compatibility');
    assert.ok(Array.isArray(publicNodes.body[0].tags), 'legacy nodes route should expose tag arrays');

    const firstVisible = seeded.clients.find(client => !client.hidden);
    const hiddenClient = seeded.clients.find(client => client.hidden);
    const rangeStart = new Date(Date.now() - 80 * 60 * 1000).toISOString();
    const rangeEnd = new Date(Date.now() + 60 * 1000).toISOString();

    const recent = await request(mf, `/api/recent/${firstVisible.uuid}?limit=50`);
    assertOk(recent, 'recent records');
    assert.equal(recent.body.length, 50, 'recent records should honor limit');

    const pagedLoad = await request(mf, `/api/records/load?uuid=${firstVisible.uuid}&start=${encodeURIComponent(rangeStart)}&end=${encodeURIComponent(rangeEnd)}&paged=true&page=2&limit=25`);
    assertOk(pagedLoad, 'paged load records');
    assert.equal(pagedLoad.body.page, 2, 'paged load should return requested page');
    assert.equal(pagedLoad.body.limit, 25, 'paged load should return requested limit');
    assert.ok(pagedLoad.body.total >= 72, 'paged load should count seeded rows');

    const hiddenHistory = await request(mf, `/api/records/load?uuid=${hiddenClient.uuid}&paged=true&page=1&limit=25`);
    assertOk(hiddenHistory, 'hidden node history');
    assert.equal(hiddenHistory.body.total, 0, 'hidden nodes should not expose history');

    const tooWideRange = await request(mf, `/api/records/load?uuid=${firstVisible.uuid}&start=${encodeURIComponent(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString())}&end=${encodeURIComponent(rangeEnd)}`);
    assert.equal(tooWideRange.response.status, 400, 'public history should reject ranges over 3 days');

    const gpuNode = seeded.clients.find((_, index) => (index + 1) % 6 === 0);
    const gpuRecords = await request(mf, `/api/records/gpu?uuid=${gpuNode.uuid}&paged=true&page=1&limit=20`);
    assertOk(gpuRecords, 'gpu records');
    assert.ok(gpuRecords.body.total >= 36, 'gpu records should include seeded GPU samples');

    const pingTasks = await request(mf, '/api/task/ping');
    assertOk(pingTasks, 'public ping tasks');
    assert.equal(pingTasks.body.length, 2, 'public ping tasks should include all seeded tasks');

    const pingRecords = await request(mf, `/api/records/ping?uuid=${firstVisible.uuid}&task_id=1&paged=true&page=1&limit=30`);
    assertOk(pingRecords, 'ping records');
    assert.ok(pingRecords.body.total >= 48, 'ping records should include seeded ping samples');

    const capacity = await request(mf, '/api/admin/capacity', { headers: adminHeaders });
    assertOk(capacity, 'admin capacity');
    assert.equal(capacity.body.clients, seeded.clients.length, 'capacity should count all seeded clients');
    assert.ok(capacity.body.actual_row_counts.records >= seeded.clients.length * 72, 'capacity should expose actual record rows');
    assert.ok(capacity.body.expired_row_counts.records >= 12, 'capacity should expose expired record backlog');
    assert.ok(capacity.body.estimated_storage_bytes > 0, 'capacity should estimate D1 storage');

    const cleanup = await request(mf, '/api/admin/maintenance/cleanup', {
      method: 'POST',
      headers: adminHeaders,
    });
    assertOk(cleanup, 'maintenance cleanup');
    assert.ok(cleanup.body.deleted.records >= 12, 'maintenance cleanup should delete expired records');
    assert.ok(cleanup.body.cleanup_options.maxBatches >= 200, 'maintenance cleanup should report adaptive batch settings');
    assert.equal(cleanup.body.expired_backlog_after.records, 0, 'maintenance cleanup should clear small expired record backlog');

    const postCleanupCapacity = await request(mf, '/api/admin/capacity', { headers: adminHeaders });
    assertOk(postCleanupCapacity, 'post-cleanup capacity');
    assert.equal(postCleanupCapacity.body.expired_row_counts.records, 0, 'capacity should reflect cleanup');

    const reportClient = seeded.clients[0];
    const report = await request(mf, '/api/clients/report', {
      method: 'POST',
      headers: agentHeaders(reportClient.token),
      body: jsonBody({
        cpu: 91,
        gpu: 20,
        ram: 123,
        ram_total: 456,
        disk: 789,
        disk_total: 1000,
        net_total_up: 111,
        net_total_down: 222,
        report_interval: 3,
        ipv4: '198.51.100.99',
        version: 'coverage-agent',
      }),
    });
    assertOk(report, 'agent report');
    assert.equal(report.body.success, true, 'agent report should succeed');

    const live = await request(mf, '/api/live');
    assertOk(live, 'public live');
    assert.equal(live.body.data?.[reportClient.uuid]?.cpu, 91, 'live snapshot should reflect latest report');

    const offlineConfig = await request(mf, '/api/admin/notification/offline/edit', {
      method: 'POST',
      headers: adminHeaders,
      body: jsonBody(seeded.clients.slice(0, 10).map((client, index) => ({
        client: client.uuid,
        enable: index % 2 === 0,
        grace_period: 180 + index,
      }))),
    });
    assertOk(offlineConfig, 'batch offline notification update');
    assert.equal(offlineConfig.body.updated, 10, 'offline batch update should cover requested clients');

    const backup = await request(mf, '/api/admin/download/backup', {
      method: 'POST',
      headers: adminHeaders,
      body: jsonBody({ backup_password: 'coverage-backup-pass' }),
    });
    assertOk(backup, 'encrypted backup download');
    assert.match(backup.response.headers.get('content-disposition') || '', /cf-monitor-encrypted-backup/, 'backup should set download filename');
    assert.equal(backup.body.encrypted, true, 'backup should be encrypted');

    const health = await request(mf, '/api/admin/health', { headers: adminHeaders });
    assertOk(health, 'admin health');
    assert.equal(health.body.ok, true, 'health should be ok after seeded local deployment coverage');

    const logs = await request(mf, '/api/admin/logs?limit=100', { headers: adminHeaders });
    assertOk(logs, 'audit logs');
    assert.ok(logs.body.data.some(log => log.action === 'maintenance_cleanup'), 'audit logs should include maintenance cleanup');

    console.log(JSON.stringify({
      ok: true,
      clients: seeded.clients.length,
      visible_clients: seeded.visibleCount,
      hidden_clients: seeded.hiddenCount,
      records_seeded: seeded.clients.length * 72 + 12,
      gpu_records_seeded: 8 * 36 + 12,
      ping_records_seeded: seeded.clients.length * 48 + 16 * 48 + 12,
      capacity_rows_after_cleanup: postCleanupCapacity.body.actual_row_counts,
      screenshots: 'run npm --prefix frontend run smoke:visual for UI screenshots',
    }, null, 2));
  } finally {
    await mf.dispose();
    await rm(bundlePath, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
