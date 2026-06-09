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
  '009_expiry_notifications.sql',
  '010_optimize_ping_indexes.sql',
  '011_align_runtime_interval_settings.sql',
  '012_ping_snapshots.sql',
  '013_gpu_snapshots.sql',
  '014_drop_redundant_client_indexes.sql',
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
    (
      args[0].includes('[scheduled] 记录清理 failed') ||
      args[0].includes('[scheduled] 负载告警检查 failed') ||
      args[0].includes('[scheduled] 离线告警检查 failed')
    )
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

async function assertPingIndexShape(mf) {
  const d1 = await mf.getD1Database('DB');
  const clientIndexes = await d1.prepare("PRAGMA index_list('clients')").all();
  const clientIndexRows = clientIndexes.results || [];
  const clientIndexNames = new Set(clientIndexRows.map((row) => row.name));
  assert.equal(clientIndexNames.has('idx_clients_token'), false, 'clients should rely on the token UNIQUE autoindex instead of a duplicate token index');
  assert.equal(clientIndexNames.has('idx_clients_group'), false, 'clients should not keep an unused group index');
  assert.ok(
    clientIndexRows.some((row) => String(row.name || '').startsWith('sqlite_autoindex_clients_')),
    'clients should still have SQLite autoindexes for primary key/unique constraints',
  );
  const indexes = await d1.prepare("PRAGMA index_list('ping_records')").all();
  const names = new Set((indexes.results || []).map((row) => row.name));
  assert.ok(
    names.has('idx_ping_records_client_task_time'),
    'ping_records should use the combined client/task/time index',
  );
  assert.ok(names.has('idx_ping_records_time'), 'ping_records should keep the time cleanup index');
  assert.equal(names.has('idx_ping_records_client_time'), false, 'legacy client/time ping index should be dropped');
  assert.equal(names.has('idx_ping_records_task'), false, 'legacy task/time ping index should be dropped');
  const snapshotIndexes = await d1.prepare("PRAGMA index_list('ping_snapshots')").all();
  const snapshotNames = new Set((snapshotIndexes.results || []).map((row) => row.name));
  assert.ok(
    snapshotNames.has('idx_ping_snapshots_client_time'),
    'ping_snapshots should support client/time history lookup',
  );
  assert.ok(snapshotNames.has('idx_ping_snapshots_time'), 'ping_snapshots should keep the time cleanup index');
  const gpuSnapshotIndexes = await d1.prepare("PRAGMA index_list('gpu_snapshots')").all();
  const gpuSnapshotNames = new Set((gpuSnapshotIndexes.results || []).map((row) => row.name));
  assert.ok(
    gpuSnapshotNames.has('idx_gpu_snapshots_client_time'),
    'gpu_snapshots should support client/time history lookup',
  );
  assert.ok(gpuSnapshotNames.has('idx_gpu_snapshots_time'), 'gpu_snapshots should keep the time cleanup index');
}

async function assertHealthSuccessThrottleSemantics() {
  const observabilityBundlePath = resolve(tmpDir, 'observability-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/utils/observability.ts')],
    outfile: observabilityBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { recordHealthEvent } = await import(`${pathToFileURL(observabilityBundlePath).href}?smoke=${Date.now()}`);

  const settings = new Map();
  let settingWrites = 0;
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql === 'SELECT value FROM settings WHERE key = ?') {
                const value = settings.get(args[0]);
                return value === undefined ? null : { value };
              }
              throw new Error(`unexpected first() SQL in health smoke: ${sql}`);
            },
            async run() {
              if (sql === 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)') {
                settings.set(args[0], args[1]);
                settingWrites += 1;
                return { success: true, meta: { rows_written: 1 } };
              }
              throw new Error(`unexpected run() SQL in health smoke: ${sql}`);
            },
          };
        },
      };
    },
  };

  const now = Date.parse('2026-06-09T00:00:00.000Z');
  await recordHealthEvent(fakeDb, 'do_record_persistence', 'ok', 'first ok', {
    nowMs: now,
    successThrottleMs: 10 * 60 * 1000,
  });
  assert.equal(settingWrites, 1, 'first health success should write settings');
  const first = JSON.parse(settings.get('health:do_record_persistence'));

  await recordHealthEvent(fakeDb, 'do_record_persistence', 'ok', 'second ok', {
    nowMs: now + 1_000,
    successThrottleMs: 10 * 60 * 1000,
  });
  assert.equal(settingWrites, 1, 'consecutive health success should be throttled');
  const throttled = JSON.parse(settings.get('health:do_record_persistence'));
  assert.equal(throttled.last_success_at, first.last_success_at, 'throttled success should not update last_success_at');

  await recordHealthEvent(fakeDb, 'do_record_persistence', 'error', 'failure', {
    nowMs: now + 2_000,
  });
  assert.equal(settingWrites, 2, 'health failure should not be hidden by success throttle');

  await recordHealthEvent(fakeDb, 'do_record_persistence', 'ok', 'recovered', {
    nowMs: now + 3_000,
    successThrottleMs: 10 * 60 * 1000,
  });
  assert.equal(settingWrites, 3, 'health recovery should write even inside success throttle window');
  const recovered = JSON.parse(settings.get('health:do_record_persistence'));
  assert.equal(recovered.status, 'ok', 'health recovery should restore ok status');
  assert.equal(recovered.detail, 'recovered', 'health recovery should store the latest detail');
}

async function assertLoginRateLimitCleanupThrottle() {
  const publicRouteBundlePath = resolve(tmpDir, 'public-route-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/routes/public.ts')],
    outfile: publicRouteBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    cleanupExpiredLoginRateLimits,
    resetLoginRateLimitCleanupForTests,
  } = await import(`${pathToFileURL(publicRouteBundlePath).href}?smoke=${Date.now()}`);

  resetLoginRateLimitCleanupForTests();
  let cleanupRuns = 0;
  const fakeDb = {
    prepare(sql) {
      assert.ok(sql.includes('DELETE FROM login_rate_limits'), `unexpected login cleanup SQL: ${sql}`);
      return {
        bind(beforeA, beforeB) {
          assert.equal(beforeA, beforeB, 'login cleanup should use one expiry cutoff for last_failed_at and locked_until');
          return {
            async run() {
              cleanupRuns += 1;
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  const now = Date.parse('2026-06-09T00:00:00.000Z');
  assert.equal(await cleanupExpiredLoginRateLimits(fakeDb, now), true, 'first login cleanup should run');
  assert.equal(cleanupRuns, 1, 'first login cleanup should issue one delete');
  assert.equal(await cleanupExpiredLoginRateLimits(fakeDb, now + 60_000), false, 'login cleanup should be throttled inside 10 minutes');
  assert.equal(cleanupRuns, 1, 'throttled login cleanup should not read or write D1');
  assert.equal(await cleanupExpiredLoginRateLimits(fakeDb, now + 10 * 60_000), true, 'login cleanup should run again after 10 minutes');
  assert.equal(cleanupRuns, 2, 'login cleanup should issue a second delete after the throttle window');
}

async function assertLoginFailureReusesLoadedRateLimitBuckets() {
  const publicRouteBundlePath = resolve(tmpDir, 'public-route-login-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/routes/public.ts')],
    outfile: publicRouteBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    getLoginRetryAfterSeconds,
    loadLoginRateLimitStates,
    recordLoginFailure,
  } = await import(`${pathToFileURL(publicRouteBundlePath).href}?smoke=${Date.now()}`);

  let reads = 0;
  let writes = 0;
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.equal(sql, 'SELECT * FROM login_rate_limits WHERE bucket = ?');
              reads += 1;
              return null;
            },
            async run() {
              assert.ok(sql.includes('INSERT INTO login_rate_limits'), `unexpected login failure write SQL: ${sql}`);
              assert.ok(args[0].startsWith('login:'), 'login failure write should bind a login bucket');
              writes += 1;
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  const buckets = ['login:ip:198.51.100.50', 'login:ip-user:198.51.100.50:admin'];
  const now = Date.parse('2026-06-09T00:00:00.000Z');
  const states = await loadLoginRateLimitStates(fakeDb, buckets);
  assert.equal(reads, 2, 'login should read each rate-limit bucket once before password validation');
  assert.equal(getLoginRetryAfterSeconds(states, now), 0, 'fresh login buckets should not be locked');
  await recordLoginFailure(fakeDb, buckets, now, states);
  assert.equal(reads, 2, 'recording a failed login should reuse loaded buckets without another D1 read');
  assert.equal(writes, 2, 'recording a failed login should still update both rate-limit buckets');
}

async function assertLoginFailureAuditThrottle() {
  const publicRouteBundlePath = resolve(tmpDir, 'public-route-login-audit-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/routes/public.ts')],
    outfile: publicRouteBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    auditLoginFailure,
    resetLoginFailureAuditThrottleForTests,
  } = await import(`${pathToFileURL(publicRouteBundlePath).href}?smoke=${Date.now()}`);

  resetLoginFailureAuditThrottleForTests();
  let auditWrites = 0;
  const fakeDb = {
    prepare(sql) {
      assert.equal(sql, 'INSERT INTO audit_logs (user, action, detail, level) VALUES (?, ?, ?, ?)');
      return {
        bind(user, action, detail, level) {
          return {
            async run() {
              auditWrites += 1;
              assert.equal(user, 'admin', 'login failure audit should keep the attempted username');
              assert.equal(action, 'login_failed', 'login failure audit should use login_failed action');
              assert.equal(level, 'warn', 'login failure audit should be warn level');
              assert.match(detail, /198\.51\.100\.51/, 'login failure audit should include the source IP');
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  const now = Date.parse('2026-06-09T00:00:00.000Z');
  await auditLoginFailure(fakeDb, 'admin', '198.51.100.51', 'invalid_password', now);
  await auditLoginFailure(fakeDb, 'admin', '198.51.100.51', 'invalid_password', now + 1_000);
  assert.equal(auditWrites, 1, 'repeated identical login failure audits should be throttled');
  await auditLoginFailure(fakeDb, 'admin', '198.51.100.51', 'unknown_user', now + 2_000);
  assert.equal(auditWrites, 2, 'different login failure reasons should be audited independently');
  await auditLoginFailure(fakeDb, 'admin', '198.51.100.51', 'invalid_password', now + 61_000);
  assert.equal(auditWrites, 3, 'login failure audit should write again after the throttle window');
}

async function assertCsrfRejectionAuditThrottle() {
  const indexBundlePath = resolve(tmpDir, 'index-csrf-audit-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/index.ts')],
    outfile: indexBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    auditCsrfRejection,
    resetCsrfRejectionAuditThrottleForTests,
  } = await import(`${pathToFileURL(indexBundlePath).href}?smoke=${Date.now()}`);

  resetCsrfRejectionAuditThrottleForTests();
  let auditWrites = 0;
  const fakeDb = {
    prepare(sql) {
      assert.equal(sql, 'INSERT INTO audit_logs (user, action, detail, level) VALUES (?, ?, ?, ?)');
      return {
        bind(user, action, detail, level) {
          return {
            async run() {
              auditWrites += 1;
              assert.equal(user, 'admin', 'CSRF rejection audit should keep the attempted admin username');
              assert.equal(action, 'csrf_rejected', 'CSRF rejection audit should use csrf_rejected action');
              assert.equal(level, 'warning', 'CSRF rejection audit should keep warning level');
              assert.match(detail, /198\.51\.100\.61/, 'CSRF rejection audit should include source IP');
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  const now = Date.parse('2026-06-09T00:00:00.000Z');
  assert.equal(
    await auditCsrfRejection(fakeDb, 'admin', '198.51.100.61', '/api/admin/settings', now),
    true,
    'first CSRF rejection audit should write',
  );
  assert.equal(
    await auditCsrfRejection(fakeDb, 'admin', '198.51.100.61', '/api/admin/settings', now + 1_000),
    false,
    'duplicate CSRF rejection audit should be throttled',
  );
  assert.equal(auditWrites, 1, 'duplicate CSRF rejection should not write another audit row');
  assert.equal(
    await auditCsrfRejection(fakeDb, 'admin', '198.51.100.61', '/api/admin/ping/add', now + 2_000),
    true,
    'different CSRF rejection path should be audited independently',
  );
  assert.equal(auditWrites, 2, 'different CSRF rejection path should write one more audit row');
  assert.equal(
    await auditCsrfRejection(fakeDb, 'admin', '198.51.100.61', '/api/admin/settings', now + 61_000),
    true,
    'CSRF rejection audit should write again after the throttle window',
  );
  assert.equal(auditWrites, 3, 'CSRF rejection audit should write after throttle expiry');
}

async function assertAgentAuthCacheSemantics() {
  const clientRouteBundlePath = resolve(tmpDir, 'client-route-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/routes/client.ts')],
    outfile: clientRouteBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    clientAuth,
    getAgentClientIdentityByToken,
    invalidateAgentClientAuthCache,
  } = await import(`${pathToFileURL(clientRouteBundlePath).href}?smoke=${Date.now()}`);
  invalidateAgentClientAuthCache();

  let tokenReads = 0;
  let identityReads = 0;
  const fakeDb = {
    prepare(sql) {
      return {
        bind(token) {
          return {
            async first() {
              if (sql === 'SELECT * FROM clients WHERE token = ?') {
                tokenReads += 1;
                if (token !== 'valid-token') return null;
                return {
                  uuid: 'auth-cache-node',
                  token,
                  name: 'Auth Cache Node',
                  hidden: 0,
                  cpu_name: 'full row marker',
                };
              }
              if (sql === 'SELECT uuid, token, name, hidden FROM clients WHERE token = ?') {
                identityReads += 1;
                if (token !== 'valid-token') return null;
                return {
                  uuid: 'auth-cache-node',
                  token,
                  name: 'Auth Cache Node',
                  hidden: 0,
                };
              }
              throw new Error(`unexpected agent auth SQL: ${sql}`);
            },
          };
        },
      };
    },
  };

  function fullOnlyDb() {
    return {
      prepare(sql) {
        assert.equal(sql, 'SELECT * FROM clients WHERE token = ?');
        return fakeDb.prepare(sql);
      },
    };
  }

  function identityOnlyDb() {
    return {
      prepare(sql) {
        assert.equal(sql, 'SELECT uuid, token, name, hidden FROM clients WHERE token = ?');
        return fakeDb.prepare(sql);
      },
    };
  }

  function authContext(token) {
    const values = new Map();
    return {
      req: {
        header(name) {
          return name === 'Authorization' ? `Bearer ${token}` : '';
        },
      },
      env: { DB: fullOnlyDb() },
      set(key, value) {
        values.set(key, value);
      },
      get(key) {
        return values.get(key);
      },
      json(body, status = 200) {
        return { body, status };
      },
    };
  }

  let nextCalls = 0;
  await clientAuth(authContext('invalid-token'), async () => {
    nextCalls += 1;
  });
  await clientAuth(authContext('invalid-token'), async () => {
    nextCalls += 1;
  });
  assert.equal(tokenReads, 1, 'repeated invalid agent token should use the short negative cache');
  assert.equal(nextCalls, 0, 'invalid agent token should not call next');

  await clientAuth(authContext('valid-token'), async () => {
    nextCalls += 1;
  });
  await clientAuth(authContext('valid-token'), async () => {
    nextCalls += 1;
  });
  assert.equal(tokenReads, 2, 'valid agent token should read D1 once and then use the positive cache');
  assert.equal(nextCalls, 2, 'valid agent token should call next on each request');

  invalidateAgentClientAuthCache({ token: 'invalid-token' });
  await clientAuth(authContext('invalid-token'), async () => {
    nextCalls += 1;
  });
  assert.equal(tokenReads, 3, 'targeted invalidation should clear a negative auth cache entry');

  invalidateAgentClientAuthCache();
  const identityDb = identityOnlyDb();
  const missingIdentity = await getAgentClientIdentityByToken(identityDb, 'invalid-token');
  const cachedMissingIdentity = await getAgentClientIdentityByToken(identityDb, 'invalid-token');
  assert.equal(missingIdentity, null, 'invalid agent identity token should return null');
  assert.equal(cachedMissingIdentity, null, 'cached invalid agent identity token should return null');
  assert.equal(identityReads, 1, 'agent identity auth should negative-cache invalid tokens');

  const identity = await getAgentClientIdentityByToken(identityDb, 'valid-token');
  const cachedIdentity = await getAgentClientIdentityByToken(identityDb, 'valid-token');
  assert.deepEqual(
    identity,
    { uuid: 'auth-cache-node', token: 'valid-token', name: 'Auth Cache Node', hidden: 0 },
    'agent identity auth should return only identity fields',
  );
  assert.deepEqual(cachedIdentity, identity, 'agent identity auth should reuse positive cache');
  assert.equal(identityReads, 2, 'agent identity auth should read D1 once for a valid token');

  invalidateAgentClientAuthCache({ token: 'valid-token' });
  await getAgentClientIdentityByToken(identityDb, 'valid-token');
  assert.equal(identityReads, 3, 'agent identity auth targeted invalidation should clear the positive cache');
}

async function assertAllowedClientIdsCacheSemantics() {
  const adminRouteBundlePath = resolve(tmpDir, 'admin-route-cache-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/routes/admin.ts')],
    outfile: adminRouteBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    getAllowedClientIds,
    getAllowedClientIdsForLoadNotification,
    getAllowedClientIdsForPingTask,
    invalidateAllowedClientIdsCache,
  } = await import(`${pathToFileURL(adminRouteBundlePath).href}?smoke=${Date.now()}`);

  let clientIdReads = 0;
  const fakeDb = {
    prepare(sql) {
      if (sql !== 'SELECT uuid FROM clients') {
        throw new Error(`unexpected allowed-client-id SQL: ${sql}`);
      }
      return {
        async all() {
          clientIdReads += 1;
          return { results: [{ uuid: 'node-a' }, { uuid: 'node-b' }] };
        },
      };
    },
  };

  invalidateAllowedClientIdsCache();
  const allClientPing = await getAllowedClientIdsForPingTask(fakeDb, {
    all_clients: true,
    clients: [],
  });
  const emptyLoadNotification = await getAllowedClientIdsForLoadNotification(fakeDb, {
    clients: [],
  });
  assert.equal(allClientPing, undefined, 'all-client ping task validation should not read client ids');
  assert.equal(emptyLoadNotification.size, 0, 'all-client load notification validation should not read client ids');
  assert.equal(clientIdReads, 0, 'all-client admin validation should avoid the clients table entirely');

  const first = await getAllowedClientIds(fakeDb);
  const second = await getAllowedClientIds(fakeDb);
  assert.deepEqual([...first].sort(), ['node-a', 'node-b'], 'allowed client ids should include D1 clients');
  assert.deepEqual([...second].sort(), ['node-a', 'node-b'], 'cached allowed client ids should match the first read');
  assert.notEqual(first, second, 'allowed client ids cache should return a defensive Set copy');
  assert.equal(clientIdReads, 1, 'repeated admin validation should reuse the allowed-client-id cache');

  first.add('mutated-by-caller');
  const afterCallerMutation = await getAllowedClientIds(fakeDb);
  assert.equal(afterCallerMutation.has('mutated-by-caller'), false, 'caller mutation should not leak into the cached Set');
  assert.equal(clientIdReads, 1, 'defensive copy should not force a D1 reread');

  invalidateAllowedClientIdsCache();
  await getAllowedClientIdsForPingTask(fakeDb, {
    all_clients: false,
    clients: ['node-a'],
  });
  assert.equal(clientIdReads, 2, 'explicit invalidation should force the next allowed-client-id D1 read');

  await getAllowedClientIdsForLoadNotification(fakeDb, {
    clients: ['node-b'],
  });
  assert.equal(clientIdReads, 2, 'specific-client validation should reuse the refreshed allowed-client-id cache');
}

async function assertCapacityEstimateUsesClientCapacityCountsOnly() {
  const adminRouteBundlePath = resolve(tmpDir, 'admin-route-capacity-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/routes/admin.ts')],
    outfile: adminRouteBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { buildCapacityEstimate } = await import(`${pathToFileURL(adminRouteBundlePath).href}?smoke=${Date.now()}`);

  let clientCapacityCountReads = 0;
  const fakeDb = {
    prepare(sql) {
      assert.notEqual(
        sql,
        'SELECT * FROM clients ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC',
        'capacity estimate should not read full client rows',
      );
      assert.doesNotMatch(sql, /SELECT\s+\* FROM clients/i, 'capacity estimate should never SELECT * FROM clients');
      if (
        sql.includes('COUNT(*) AS clients') &&
        sql.includes('gpu_clients') &&
        sql.includes('FROM clients')
      ) {
        return {
          async first() {
            clientCapacityCountReads += 1;
            return { clients: 7, gpu_clients: 2 };
          },
        };
      }
      if (sql.startsWith('SELECT key, value FROM settings WHERE key IN')) {
        assert.doesNotMatch(sql, /^SELECT key, value FROM settings$/i, 'capacity estimate should not scan all settings');
        return {
          bind(...args) {
            assert.deepEqual(
              args,
              [
                'record_enabled',
                'record_preserve_time',
                'ping_record_preserve_time',
                'live_poll_active_interval_sec',
                'live_poll_idle_interval_sec',
                'record_persist_interval_sec',
                'record_high_watermark_rows',
                'audit_log_preserve_time',
                'capacity_daily_view_minutes',
              ],
              'capacity estimate should bind only the settings keys it needs',
            );
            return {
              async all() {
                return {
                  results: [
                    { key: 'record_enabled', value: 'true' },
                    { key: 'record_persist_interval_sec', value: '60' },
                    { key: 'record_preserve_time', value: '72' },
                    { key: 'ping_record_preserve_time', value: '72' },
                    { key: 'live_poll_active_interval_sec', value: '3' },
                    { key: 'live_poll_idle_interval_sec', value: '600' },
                    { key: 'capacity_daily_view_minutes', value: '60' },
                  ],
                };
              },
            };
          },
        };
      }
      assert.notEqual(
        sql,
        'SELECT * FROM ping_tasks ORDER BY sort_order ASC, id ASC',
        'capacity estimate should not read full ping task rows',
      );
      assert.doesNotMatch(sql, /SELECT\s+\* FROM ping_tasks/i, 'capacity estimate should never SELECT * FROM ping_tasks');
      if (sql === 'SELECT id, name, clients, all_clients, interval_sec FROM ping_tasks ORDER BY sort_order ASC, id ASC') {
        return {
          async all() {
            return {
              results: [
                { id: 1, name: 'all nodes', clients: '[]', all_clients: 1, interval_sec: 60 },
                { id: 2, name: 'two nodes', clients: JSON.stringify(['node-a', 'node-b']), all_clients: 0, interval_sec: 120 },
              ],
            };
          },
        };
      }
      if (sql.startsWith('SELECT COUNT(*) AS count FROM ')) {
        return {
          bind() {
            return {
              async first() {
                return { count: 0 };
              },
            };
          },
          async first() {
            return { count: 0 };
          },
        };
      }
      throw new Error(`unexpected capacity estimate SQL: ${sql}`);
    },
  };

  const estimate = await buildCapacityEstimate(fakeDb, { forceCounts: true });
  assert.equal(clientCapacityCountReads, 1, 'capacity estimate should read client capacity counts once');
  assert.equal(estimate.clients, 7, 'capacity estimate should expose the counted clients');
  assert.equal(estimate.gpu_clients, 2, 'capacity estimate should expose the counted GPU-capable clients');
  assert.equal(estimate.gpu_storage_mode, 'snapshots', 'capacity estimate should expose GPU snapshot storage mode');
  assert.equal(estimate.active_gpu_snapshots_per_day, 120, 'capacity estimate should include active GPU snapshot writes');
  assert.equal(estimate.idle_gpu_snapshots_per_day, 276, 'capacity estimate should include idle GPU snapshot writes');
  assert.equal(estimate.gpu_snapshots_per_day, 396, 'capacity estimate should include total GPU snapshot writes');
  assert.equal(estimate.estimated_gpu_snapshots_retained, 1188, 'capacity estimate should include retained GPU snapshot rows');
  assert.equal(
    estimate.ping_tasks.find(task => task.id === 1)?.target_client_count,
    7,
    'all-client ping task estimate should use the counted client total',
  );
  assert.equal(
    estimate.ping_tasks.find(task => task.id === 2)?.target_client_count,
    2,
    'specific-client ping task estimate should use the task client list length',
  );
}

async function assertAdminClientExistenceChecksUseNarrowSelects() {
  const adminRouteBundlePath = resolve(tmpDir, 'admin-route-client-exists-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/routes/admin.ts')],
    outfile: adminRouteBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    getClientCreateConflict,
    generateUniqueClientToken,
  } = await import(`${pathToFileURL(adminRouteBundlePath).href}?smoke=${Date.now()}`);

  const firstResults = new Map([
    ['uuid:existing-node', { found: 1 }],
    ['token:existing-token', { found: 1 }],
    ['token:collision-token', { found: 1 }],
    ['token:free-token', null],
  ]);
  const seenSql = [];
  const fakeDb = {
    prepare(sql) {
      seenSql.push(sql);
      assert.doesNotMatch(sql, /SELECT\s+\*/i, 'admin existence checks should not read full rows');
      assert.ok(
        sql === 'SELECT 1 AS found FROM clients WHERE uuid = ? LIMIT 1' ||
        sql === 'SELECT 1 AS found FROM clients WHERE token = ? LIMIT 1',
        `unexpected admin existence SQL: ${sql}`,
      );
      return {
        bind(value) {
          return {
            async first() {
              if (sql.includes('uuid = ?')) return firstResults.get(`uuid:${value}`) || null;
              return firstResults.get(`token:${value}`) || null;
            },
          };
        },
      };
    },
  };

  assert.equal(
    await getClientCreateConflict(fakeDb, 'existing-node', 'new-token'),
    'uuid',
    'client create conflict should report existing uuid first',
  );
  assert.equal(
    await getClientCreateConflict(fakeDb, 'new-node', 'existing-token'),
    'token',
    'client create conflict should report existing token',
  );
  assert.equal(
    await getClientCreateConflict(fakeDb, 'new-node', 'new-token'),
    null,
    'client create conflict should allow unique uuid and token',
  );

  const generated = await generateUniqueClientToken(
    fakeDb,
    (() => {
      const values = ['collision-token', 'free-token'];
      return () => values.shift() || 'free-token';
    })(),
  );
  assert.equal(generated, 'free-token', 'token generator should retry until a free token is found');
  assert.ok(
    seenSql.every(sql => sql.startsWith('SELECT 1 AS found FROM clients WHERE')),
    'all admin existence checks should use narrow SELECT 1 queries',
  );
}

async function assertAdminClientTokenMetaUsesNarrowSelect() {
  const queriesBundlePath = resolve(tmpDir, 'queries-client-token-meta-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/db/queries.ts')],
    outfile: queriesBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { getClientTokenMeta } = await import(`${pathToFileURL(queriesBundlePath).href}?smoke=${Date.now()}`);

  let reads = 0;
  const fakeDb = {
    prepare(sql) {
      assert.equal(sql, 'SELECT uuid, token, name FROM clients WHERE uuid = ?');
      assert.doesNotMatch(sql, /SELECT\s+\*/i, 'client token meta should not SELECT *');
      return {
        bind(uuid) {
          return {
            async first() {
              reads += 1;
              assert.equal(uuid, 'node-a', 'client token meta should bind the requested uuid');
              return { uuid: 'node-a', token: 'token-a', name: 'Node A' };
            },
          };
        },
      };
    },
  };

  const meta = await getClientTokenMeta(fakeDb, 'node-a');
  assert.deepEqual(meta, { uuid: 'node-a', token: 'token-a', name: 'Node A' }, 'client token meta should return only token metadata');
  assert.equal(reads, 1, 'client token meta should issue one narrow read');
}

async function assertDurableObjectPingTaskCacheSemantics() {
  const liveDataBundlePath = resolve(tmpDir, 'live-data-do-cache-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/do/live-data.ts')],
    outfile: liveDataBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { LiveDataDO } = await import(`${pathToFileURL(liveDataBundlePath).href}?smoke=${Date.now()}`);

  const storage = new Map();
  let pingTaskReads = 0;
  let pingWrites = 0;
  const fakeState = {
    getWebSockets() {
      return [];
    },
    storage: {
      async get(key) {
        return storage.get(key);
      },
      async put(key, value) {
        storage.set(key, value);
      },
    },
  };
  const fakeDb = {
    prepare(sql) {
      if (sql === 'SELECT * FROM ping_tasks ORDER BY sort_order ASC, id ASC') {
        return {
          async all() {
            pingTaskReads += 1;
            return {
              results: [
                { id: 1, name: 'global', clients: '[]', all_clients: 1, type: 'icmp', target: '1.1.1.1', interval_sec: 60, sort_order: 1 },
              ],
            };
          },
        };
      }
      if (sql === 'INSERT INTO ping_snapshots (client, time, values_json) VALUES (?, ?, ?)') {
        return {
          bind(client, time, valuesJson) {
            return {
              async run() {
                const values = JSON.parse(valuesJson);
                assert.equal(typeof client, 'string', 'ping snapshot should bind the client id');
                assert.equal(typeof time, 'string', 'ping snapshot should bind an ISO time');
                assert.ok(Object.keys(values).length >= 1, 'ping snapshot should include accepted task values');
                pingWrites += 1;
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      }
      throw new Error(`unexpected LiveDataDO cache smoke SQL: ${sql}`);
    },
  };

  const live = new LiveDataDO(fakeState, { DB: fakeDb });
  await live.persistPingResult('node-a', [{ task_id: 1, value: 20 }], 1);
  await live.persistPingResult('node-b', [{ task_id: 1, value: 21 }], 2);
  assert.equal(pingTaskReads, 1, 'DO ping persistence should reuse ping task cache across nodes');
  assert.equal(pingWrites, 2, 'DO ping persistence should still write accepted ping results');

  const refresh = await live.fetch(new Request('https://do/ping-tasks-refresh', { method: 'POST' }));
  assert.equal(refresh.status, 200, 'DO ping task refresh endpoint should succeed');
  await live.persistPingResult('node-c', [{ task_id: 1, value: 22 }], 3);
  assert.equal(pingTaskReads, 2, 'DO ping task refresh should invalidate the cached task list');
}

async function assertBatchClientQueryHelpers() {
  const queriesBundlePath = resolve(tmpDir, 'queries-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/db/queries.ts')],
    outfile: queriesBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    getClientsByIds,
    updateClientsHidden,
    clearClientsRecords,
    pruneClientReferencesForClients,
    cleanupOrphanClientData,
  } = await import(`${pathToFileURL(queriesBundlePath).href}?smoke=${Date.now()}`);

  let clientBulkReads = 0;
  let clientIdReads = 0;
  let pingTaskReads = 0;
  let loadNotificationReads = 0;
  let expiryNotificationDeletes = 0;
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      const statement = {
        bind(...args) {
          const bound = {
            async all() {
              if (sql.startsWith('SELECT * FROM clients WHERE uuid IN')) {
                clientBulkReads += 1;
                return {
                  results: args.map((uuid) => ({
                    uuid,
                    token: `token-${uuid}`,
                    name: `Node ${uuid}`,
                    hidden: 0,
                  })),
                };
              }
              throw new Error(`unexpected all() SQL in batch helper smoke: ${sql}`);
            },
            async run() {
              statements.push({ sql, args });
              if (sql.startsWith('UPDATE clients SET hidden')) {
                return { success: true, meta: { changes: Math.max(0, args.length - 2) } };
              }
              if (
                sql.startsWith('DELETE FROM records WHERE client IN') ||
                sql.startsWith('DELETE FROM gpu_records WHERE client IN') ||
                sql.startsWith('DELETE FROM gpu_snapshots WHERE client IN') ||
                sql.startsWith('DELETE FROM ping_records WHERE client IN') ||
                sql.startsWith('DELETE FROM ping_snapshots WHERE client IN') ||
                sql.startsWith('UPDATE ping_tasks SET') ||
                sql.startsWith('UPDATE load_notifications SET') ||
                sql.startsWith('DELETE FROM load_notifications WHERE id = ?')
              ) {
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.startsWith('DELETE FROM expiry_notifications WHERE client IN')) {
                expiryNotificationDeletes += 1;
                return { success: true, meta: { changes: args.length } };
              }
              throw new Error(`unexpected run() SQL in batch helper smoke: ${sql}`);
            },
          };
          return bound;
        },
        async all() {
          if (sql === 'SELECT uuid FROM clients') {
            clientIdReads += 1;
            return { results: [{ uuid: 'node-c' }] };
          }
          if (sql === 'SELECT * FROM ping_tasks ORDER BY sort_order ASC, id ASC') {
            pingTaskReads += 1;
            return {
              results: [
                { id: 1, name: 'shared', clients: JSON.stringify(['node-a', 'node-b', 'node-c']), all_clients: 0, type: 'icmp', target: '1.1.1.1', interval_sec: 60 },
                { id: 2, name: 'untouched', clients: JSON.stringify(['node-c']), all_clients: 0, type: 'icmp', target: '1.0.0.1', interval_sec: 60 },
                { id: 3, name: 'all', clients: '[]', all_clients: 1, type: 'icmp', target: '8.8.8.8', interval_sec: 60 },
              ],
            };
          }
          if (sql === 'SELECT * FROM load_notifications') {
            loadNotificationReads += 1;
            return {
              results: [
                { id: 10, name: 'delete', clients: JSON.stringify(['node-a']), metric: 'cpu', threshold: 90, ratio: 0.8, interval_min: 5 },
                { id: 11, name: 'update', clients: JSON.stringify(['node-a', 'node-c']), metric: 'ram', threshold: 90, ratio: 0.8, interval_min: 5 },
              ],
            };
          }
          throw new Error(`unexpected direct all() SQL in batch helper smoke: ${sql}`);
        },
        async run() {
          if (
            sql === 'DELETE FROM offline_notifications WHERE client NOT IN (SELECT uuid FROM clients)' ||
            sql === 'DELETE FROM expiry_notifications WHERE client NOT IN (SELECT uuid FROM clients)' ||
            sql === 'DELETE FROM records WHERE client NOT IN (SELECT uuid FROM clients)' ||
            sql === 'DELETE FROM gpu_records WHERE client NOT IN (SELECT uuid FROM clients)' ||
            sql === 'DELETE FROM gpu_snapshots WHERE client NOT IN (SELECT uuid FROM clients)' ||
            sql === 'DELETE FROM ping_records WHERE client NOT IN (SELECT uuid FROM clients)' ||
            sql === 'DELETE FROM ping_snapshots WHERE client NOT IN (SELECT uuid FROM clients)'
          ) {
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`unexpected direct run() SQL in batch helper smoke: ${sql}`);
        },
      };
      return statement;
    },
  };

  const clients = await getClientsByIds(fakeDb, ['node-a', 'node-b']);
  assert.equal(clients.length, 2, 'bulk client lookup should return target clients');
  assert.equal(clientBulkReads, 1, 'bulk client lookup should read clients once for the batch');

  const hiddenChanged = await updateClientsHidden(fakeDb, ['node-a', 'node-b'], true);
  assert.equal(hiddenChanged, 2, 'bulk hide should update both target clients in one statement');

  const deletedRecords = await clearClientsRecords(fakeDb, ['node-a', 'node-b']);
  assert.deepEqual(deletedRecords, { records: 1, gpu_records: 1, gpu_snapshots: 1, ping_records: 1, ping_snapshots: 1 }, 'bulk record cleanup should delete all history tables');

  const cleanup = await pruneClientReferencesForClients(fakeDb, ['node-a', 'node-b']);
  assert.equal(pingTaskReads, 1, 'bulk reference prune should scan ping tasks once');
  assert.equal(loadNotificationReads, 1, 'bulk reference prune should scan load notifications once');
  assert.equal(expiryNotificationDeletes, 1, 'bulk reference prune should delete expiry notifications with one IN query');
  assert.deepEqual(cleanup, {
    ping_tasks_updated: 1,
    load_notifications_updated: 1,
    load_notifications_deleted: 1,
    expiry_notifications_deleted: 2,
  }, 'bulk reference prune should update only affected rules');

  const orphanCleanup = await cleanupOrphanClientData(fakeDb);
  assert.equal(clientIdReads, 1, 'orphan cleanup should read only client UUIDs, not full client rows');
  assert.deepEqual(orphanCleanup, {
    ping_tasks_updated: 1,
    load_notifications_updated: 1,
    load_notifications_deleted: 1,
    expiry_notifications_deleted: 1,
    offline_notifications_deleted: 1,
    records_deleted: 1,
    gpu_records_deleted: 1,
    gpu_snapshots_deleted: 1,
    ping_records_deleted: 1,
    ping_snapshots_deleted: 1,
  }, 'orphan cleanup should prune references and delete all orphan history tables');
}

async function assertPublicClientQueryHelpersUseNarrowSelects() {
  const queriesBundlePath = resolve(tmpDir, 'queries-public-client-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/db/queries.ts')],
    outfile: queriesBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const {
    listPublicClientRows,
    getClientVisibility,
  } = await import(`${pathToFileURL(queriesBundlePath).href}?smoke=${Date.now()}`);

  let publicClientReads = 0;
  let visibilityReads = 0;
  const fakeDb = {
    prepare(sql) {
      return {
        async all() {
          publicClientReads += 1;
          assert.doesNotMatch(sql, /SELECT\s+\*/i, 'public client list should not SELECT *');
          assert.doesNotMatch(sql, /\btoken\b/i, 'public client list should not read client tokens');
          assert.doesNotMatch(sql, /\bremark\b/i, 'public client list should not read private remarks');
          assert.match(sql, /\bpublic_remark\b/i, 'public client list should still read public remarks');
          return {
            results: [
              {
                uuid: 'node-a',
                name: 'Node A',
                hidden: 0,
                ipv4: '192.0.2.1',
                ipv6: '',
                public_remark: 'edge',
              },
            ],
          };
        },
        bind(...args) {
          return {
            async first() {
              visibilityReads += 1;
              assert.deepEqual(args, ['node-a'], 'visibility lookup should bind the requested uuid');
              assert.equal(sql, 'SELECT uuid, hidden FROM clients WHERE uuid = ?');
              return { uuid: 'node-a', hidden: 0 };
            },
          };
        },
      };
    },
  };

  const rows = await listPublicClientRows(fakeDb);
  assert.equal(rows.length, 1, 'public client list should return rows');
  assert.equal(rows[0].uuid, 'node-a', 'public client list should preserve uuid');
  const visibility = await getClientVisibility(fakeDb, 'node-a');
  assert.equal(visibility.uuid, 'node-a', 'visibility lookup should return uuid');
  assert.equal(publicClientReads, 1, 'public client list should issue one narrow read');
  assert.equal(visibilityReads, 1, 'visibility lookup should issue one narrow read');
}

async function assertSettingsSubsetHelperUsesNarrowSelect() {
  const queriesBundlePath = resolve(tmpDir, 'queries-settings-subset-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/db/queries.ts')],
    outfile: queriesBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { getSettingsByKeys } = await import(`${pathToFileURL(queriesBundlePath).href}?smoke=${Date.now()}`);

  let reads = 0;
  const fakeDb = {
    prepare(sql) {
      assert.equal(
        sql,
        'SELECT key, value FROM settings WHERE key IN (?, ?)',
        'settings subset lookup should use a key-filtered query',
      );
      assert.doesNotMatch(sql, /^SELECT key, value FROM settings$/i, 'settings subset lookup should not scan all settings');
      return {
        bind(...args) {
          assert.deepEqual(args, ['telegram_bot_token', 'telegram_chat_id'], 'settings subset lookup should bind unique keys');
          return {
            async all() {
              reads += 1;
              return {
                results: [
                  { key: 'telegram_bot_token', value: 'bot-token' },
                  { key: 'telegram_chat_id', value: 'chat-id' },
                ],
              };
            },
          };
        },
      };
    },
  };

  const empty = await getSettingsByKeys(fakeDb, []);
  assert.deepEqual(empty, {}, 'empty settings subset should return an empty object');
  assert.equal(reads, 0, 'empty settings subset should not read D1');

  const settings = await getSettingsByKeys(fakeDb, ['telegram_bot_token', 'telegram_chat_id', 'telegram_bot_token']);
  assert.equal(settings.telegram_bot_token, 'bot-token', 'settings subset should include requested token');
  assert.equal(settings.telegram_chat_id, 'chat-id', 'settings subset should include requested chat id');
  assert.equal(reads, 1, 'settings subset should issue one D1 read');
}

async function assertPublicAndViewerSettingsUseNarrowReads() {
  const schemaBundlePath = resolve(tmpDir, 'settings-schema-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/settings/schema.ts')],
    outfile: schemaBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { PUBLIC_SETTING_KEYS, SETTING_SCHEMA } = await import(`${pathToFileURL(schemaBundlePath).href}?smoke=${Date.now()}`);
  assert.ok(PUBLIC_SETTING_KEYS.includes('live_poll_active_max_duration_sec'), 'public settings keys should include viewer TTL');
  assert.equal(PUBLIC_SETTING_KEYS.includes('telegram_bot_token'), false, 'public settings keys should exclude Telegram token');
  assert.equal(PUBLIC_SETTING_KEYS.includes('record_enabled'), false, 'public settings keys should exclude private record setting');
  for (const key of PUBLIC_SETTING_KEYS) {
    assert.equal(SETTING_SCHEMA[key]?.public, true, `public settings key ${key} should be marked public`);
  }

  const publicRouteSource = await readFile(resolve(workerRoot, 'src/routes/public.ts'), 'utf8');
  assert.match(
    publicRouteSource,
    /buildPublicSettings\(await db\.getSettingsByKeys\(database, PUBLIC_SETTING_KEYS\)\)/,
    'public settings route should read only public settings keys',
  );
  assert.doesNotMatch(
    publicRouteSource,
    /buildPublicSettings\(await db\.getAllSettings\(database\)\)/,
    'public settings route should not scan all settings',
  );

  const websocketRouteSource = await readFile(resolve(workerRoot, 'src/routes/websocket.ts'), 'utf8');
  assert.match(
    websocketRouteSource,
    /db\.getSetting\(c\.env\.DB, 'live_poll_active_max_duration_sec'\)/,
    'viewer token TTL should read only the TTL setting',
  );
  assert.doesNotMatch(
    websocketRouteSource,
    /buildPublicSettings\(await db\.getAllSettings/,
    'viewer token TTL should not scan all public settings',
  );
}

async function assertDurableObjectSettingsUseNarrowReads() {
  const liveDataSource = await readFile(resolve(workerRoot, 'src/do/live-data.ts'), 'utf8');
  assert.match(
    liveDataSource,
    /buildAdminSettings\(await db\.getSettingsByKeys\(this\.env\.DB, AGENT_POLICY_SETTING_KEYS\)\)/,
    'Durable Object policy settings should read only policy keys',
  );
  assert.match(
    liveDataSource,
    /buildAdminSettings\(await db\.getSettingsByKeys\(this\.env\.DB, RECORD_PERSISTENCE_SETTING_KEYS\)\)/,
    'Durable Object record persistence settings should read only record persistence keys',
  );
  assert.doesNotMatch(
    liveDataSource,
    /buildAdminSettings\(await db\.getAllSettings\(this\.env\.DB\)\)/,
    'Durable Object hot settings paths should not scan all settings',
  );
  for (const key of [
    'live_poll_active_interval_sec',
    'live_poll_idle_interval_sec',
    'live_poll_active_max_duration_sec',
    'record_enabled',
    'record_persist_interval_sec',
    'record_high_watermark_rows',
  ]) {
    assert.match(liveDataSource, new RegExp(`'${key}'`), `Durable Object settings source should include ${key}`);
  }
}

async function assertAdminCapacityAndMaintenanceSettingsUseNarrowReads() {
  const adminRouteSource = await readFile(resolve(workerRoot, 'src/routes/admin.ts'), 'utf8');
  assert.match(
    adminRouteSource,
    /db\.getSettingsByKeys\(database, CAPACITY_ESTIMATE_SETTING_KEYS\)/,
    'capacity estimate should read only capacity settings keys',
  );
  assert.match(
    adminRouteSource,
    /db\.listPingTaskEstimateRows\(database\)/,
    'capacity estimate should read only ping task fields needed for estimates',
  );
  assert.doesNotMatch(
    adminRouteSource,
    /const \[clientCount, rawSettings, pingTasks\][\s\S]*?db\.listPingTasks\(database\)/,
    'capacity estimate should not read full ping task rows',
  );
  assert.match(
    adminRouteSource,
    /db\.getSettingsByKeys\(database, MAINTENANCE_CLEANUP_SETTING_KEYS\)/,
    'manual maintenance cleanup should read only cleanup settings keys',
  );
  assert.doesNotMatch(
    adminRouteSource,
    /const \[clientCount, rawSettings, pingTasks\][\s\S]*?db\.getAllSettings\(database\)/,
    'capacity estimate should not scan all settings',
  );
  assert.doesNotMatch(
    adminRouteSource,
    /async function runMaintenanceCleanup[\s\S]*?buildAdminSettings\(await db\.getAllSettings\(database\)\)/,
    'manual maintenance cleanup should not scan all settings',
  );
  assert.match(
    adminRouteSource,
    /db\.getSettingsByKeys\(c\.env\.DB, Object\.keys\(normalized\.settings\)\)/,
    'settings save should read only submitted settings keys',
  );
  assert.doesNotMatch(
    adminRouteSource,
    /const currentSettings = buildAdminSettings\(await db\.getAllSettings\(c\.env\.DB\)\)/,
    'settings save should not scan all settings',
  );
  assert.match(
    adminRouteSource,
    /db\.getSettingsByKeys\(c\.env\.DB, TELEGRAM_CREDENTIAL_SETTING_KEYS\)/,
    'Telegram test should read only Telegram credential keys',
  );
  assert.doesNotMatch(
    adminRouteSource,
    /adminRoutes\.post\('\/test\/sendMessage'[\s\S]*?const settings = await db\.getAllSettings\(c\.env\.DB\);/,
    'Telegram test should not scan all settings',
  );
  for (const key of [
    'record_enabled',
    'record_preserve_time',
    'ping_record_preserve_time',
    'live_poll_active_interval_sec',
    'live_poll_idle_interval_sec',
    'record_persist_interval_sec',
    'record_high_watermark_rows',
    'audit_log_preserve_time',
    'capacity_daily_view_minutes',
    'telegram_bot_token',
    'telegram_chat_id',
  ]) {
    assert.match(adminRouteSource, new RegExp(`'${key}'`), `admin quota settings source should include ${key}`);
  }
}

async function assertScheduledCleanupSkipsBacklogCounts() {
  const indexSource = await readFile(resolve(workerRoot, 'src/index.ts'), 'utf8');
  const cleanupMatch = indexSource.match(/async function runRecordCleanup[\s\S]*?\n}\n\ntype OfflineNotificationCandidate/);
  assert.ok(cleanupMatch, 'smoke should find runRecordCleanup source block');
  assert.doesNotMatch(
    cleanupMatch[0],
    /getExpiredRowCounts/,
    'scheduled cleanup should not run expired backlog COUNT scans after deleting rows',
  );
  assert.match(
    cleanupMatch[0],
    /expired_backlog_after: 'skipped_for_quota'/,
    'scheduled cleanup audit should explicitly mark post-cleanup backlog counts as skipped',
  );
}

async function assertRecordCapacityCheckIsAdaptive() {
  const liveDataSource = await readFile(resolve(workerRoot, 'src/do/live-data.ts'), 'utf8');
  assert.match(
    liveDataSource,
    /RECORD_CAPACITY_CACHE_FAR_MS\s*=\s*60\s*\*\s*60_000/,
    'record capacity checks should use a one-hour far-from-watermark cache',
  );
  assert.match(
    liveDataSource,
    /RECORD_CAPACITY_CACHE_NEAR_MS\s*=\s*10\s*\*\s*60_000/,
    'record capacity checks should keep a ten-minute near-watermark cache',
  );
  assert.match(
    liveDataSource,
    /RECORD_CAPACITY_CACHE_CRITICAL_MS\s*=\s*60_000/,
    'record capacity checks should tighten to one minute when critical',
  );
  assert.match(
    liveDataSource,
    /private capacityCheckDelayMs\(\)[\s\S]*ratio >= 0\.95[\s\S]*RECORD_CAPACITY_CACHE_CRITICAL_MS[\s\S]*ratio >= 0\.8[\s\S]*RECORD_CAPACITY_CACHE_NEAR_MS[\s\S]*RECORD_CAPACITY_CACHE_FAR_MS/,
    'record capacity delay should adapt based on high-watermark distance',
  );
  assert.match(
    liveDataSource,
    /now < this\.recordCapacityNextCheckAt/,
    'record capacity checks should use the next scheduled check time instead of a fixed last-checked window',
  );
  assert.doesNotMatch(
    liveDataSource,
    /now - this\.recordCapacityCheckedAt < RECORD_CAPACITY_CACHE_MS/,
    'record capacity checks should not regress to a fixed ten-minute COUNT interval',
  );
  assert.match(
    liveDataSource,
    /db\.getHistoryStorageRowCounts\(this\.env\.DB\)/,
    'record capacity checks should count only history tables needed for the high-watermark',
  );
  assert.doesNotMatch(
    liveDataSource,
    /canPersistWithinCapacity[\s\S]*db\.getStorageRowCounts\(this\.env\.DB\)/,
    'record capacity checks should not COUNT audit_logs through the full storage row helper',
  );
}

async function assertHistoryStorageCountsSkipAuditLogs() {
  const queriesBundlePath = resolve(tmpDir, 'queries-history-counts-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/db/queries.ts')],
    outfile: queriesBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { getHistoryStorageRowCounts } = await import(`${pathToFileURL(queriesBundlePath).href}?smoke=${Date.now()}`);

  const countedTables = [];
  const fakeDb = {
    prepare(sql) {
      const match = sql.match(/^SELECT COUNT\(\*\) AS count FROM ([a-z_]+)$/);
      assert.ok(match, `unexpected history count SQL: ${sql}`);
      const table = match[1];
      countedTables.push(table);
      assert.notEqual(table, 'audit_logs', 'history storage counts should not count audit logs');
      return {
        async first() {
          return { count: 1 };
        },
      };
    },
  };

  const counts = await getHistoryStorageRowCounts(fakeDb);
  assert.deepEqual(
    countedTables.sort(),
    ['gpu_records', 'gpu_snapshots', 'ping_records', 'ping_snapshots', 'records'].sort(),
    'history storage counts should cover only D1 history tables controlled by the high-watermark',
  );
  assert.deepEqual(counts, {
    records: 1,
    gpu_records: 1,
    gpu_snapshots: 1,
    ping_records: 1,
    ping_snapshots: 1,
  }, 'history storage counts should return all high-watermark tables');
}

async function assertReorderWritesOnlyChangedRows() {
  const queriesBundlePath = resolve(tmpDir, 'queries-reorder-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/db/queries.ts')],
    outfile: queriesBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { reorderClients, reorderPingTasks } = await import(`${pathToFileURL(queriesBundlePath).href}?smoke=${Date.now()}`);

  const clients = [
    { uuid: 'node-a', name: 'Node A', sort_order: 1, created_at: '2026-06-09T00:00:00.000Z' },
    { uuid: 'node-b', name: 'Node B', sort_order: 2, created_at: '2026-06-09T00:00:00.000Z' },
    { uuid: 'node-c', name: 'Node C', sort_order: 3, created_at: '2026-06-09T00:00:00.000Z' },
  ];
  const pingTasks = [
    { id: 1, name: 'Task A', clients: '[]', all_clients: 1, type: 'icmp', target: '1.1.1.1', interval_sec: 60, sort_order: 1 },
    { id: 2, name: 'Task B', clients: '[]', all_clients: 1, type: 'icmp', target: '1.0.0.1', interval_sec: 60, sort_order: 2 },
    { id: 3, name: 'Task C', clients: '[]', all_clients: 1, type: 'icmp', target: '8.8.8.8', interval_sec: 60, sort_order: 3 },
  ];
  let clientSortWrites = 0;
  let pingSortWrites = 0;
  const fakeDb = {
    prepare(sql) {
      return {
        async all() {
          if (sql === 'SELECT * FROM clients ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC') {
            return { results: [...clients].sort((a, b) => a.sort_order - b.sort_order) };
          }
          if (sql === 'SELECT * FROM ping_tasks ORDER BY sort_order ASC, id ASC') {
            return { results: [...pingTasks].sort((a, b) => a.sort_order - b.sort_order) };
          }
          throw new Error(`unexpected reorder all() SQL: ${sql}`);
        },
        bind(...args) {
          return { sql, args };
        },
      };
    },
    async batch(statements) {
      return statements.map((statement) => {
        if (statement.sql === "UPDATE clients SET sort_order = ?, updated_at = datetime('now') WHERE uuid = ?") {
          const [sortOrder, uuid] = statement.args;
          const client = clients.find((item) => item.uuid === uuid);
          if (!client) return { success: true, meta: { changes: 0 } };
          client.sort_order = sortOrder;
          clientSortWrites += 1;
          return { success: true, meta: { changes: 1 } };
        }
        if (statement.sql === 'UPDATE ping_tasks SET sort_order = ? WHERE id = ?') {
          const [sortOrder, id] = statement.args;
          const task = pingTasks.find((item) => item.id === id);
          if (!task) return { success: true, meta: { changes: 0 } };
          task.sort_order = sortOrder;
          pingSortWrites += 1;
          return { success: true, meta: { changes: 1 } };
        }
        throw new Error(`unexpected reorder batch SQL: ${statement.sql}`);
      });
    },
  };

  assert.equal(await reorderClients(fakeDb, ['node-a', 'node-b', 'node-c']), 0, 'same client order should not write');
  assert.equal(clientSortWrites, 0, 'same client order should issue no client sort writes');
  assert.equal(await reorderClients(fakeDb, ['node-b', 'node-a', 'node-c']), 2, 'swapping two clients should write only changed rows');
  assert.equal(clientSortWrites, 2, 'client reorder should write only rows whose sort_order changed');

  assert.equal(await reorderPingTasks(fakeDb, [1, 2, 3]), 0, 'same ping task order should not write');
  assert.equal(pingSortWrites, 0, 'same ping task order should issue no ping sort writes');
  assert.equal(await reorderPingTasks(fakeDb, [2, 1, 3]), 2, 'swapping two ping tasks should write only changed rows');
  assert.equal(pingSortWrites, 2, 'ping task reorder should write only rows whose sort_order changed');
}

async function assertLoadMetricStatsBatchHelper() {
  const queriesBundlePath = resolve(tmpDir, 'queries-load-stats-smoke.mjs');
  await esbuild.build({
    entryPoints: [resolve(workerRoot, 'src/db/queries.ts')],
    outfile: queriesBundlePath,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    sourcemap: false,
    logLevel: 'silent',
  });
  const { getLoadMetricWindowStatsForClients } = await import(`${pathToFileURL(queriesBundlePath).href}?smoke=${Date.now()}`);

  let loadStatsReads = 0;
  const fakeDb = {
    prepare(sql) {
      assert.ok(sql.includes('FROM records'), `load stats query should read records: ${sql}`);
      assert.ok(sql.includes('GROUP BY client'), `load stats query should group by client: ${sql}`);
      assert.ok(sql.includes('client IN'), `load stats query should filter target clients with IN: ${sql}`);
      return {
        bind(threshold, ...args) {
          assert.equal(threshold, 80, 'load stats threshold should be bound once per batched query');
          assert.deepEqual(args.slice(0, 3), ['node-a', 'node-b', 'node-c'], 'load stats query should bind all target clients together');
          return {
            async all() {
              loadStatsReads += 1;
              return {
                results: [
                  { client: 'node-a', samples: 3, exceeded: 2, avg_value: 91.5 },
                  { client: 'node-b', samples: 3, exceeded: 0, avg_value: 40 },
                ],
              };
            },
          };
        },
      };
    },
  };

  const stats = await getLoadMetricWindowStatsForClients(
    fakeDb,
    ['node-a', 'node-b', 'node-a', 'node-c'],
    '2026-06-09T00:00:00.000Z',
    '2026-06-09T00:15:00.000Z',
    'cpu',
    80,
  );
  assert.equal(loadStatsReads, 1, 'load notification stats should read D1 once per rule batch');
  assert.equal(stats.get('node-a')?.exceeded, 2, 'load stats should include grouped node-a results');
  assert.equal(stats.get('node-b')?.avg_value, 40, 'load stats should include grouped node-b results');
  assert.equal(stats.has('node-c'), false, 'nodes with no samples should be absent from grouped stats');
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

function assertExpiryWithin(result, label, expectedMs, toleranceMs = 15_000) {
  const remainingMs = Number(result.body.expires_at || 0) - Date.now();
  assert.ok(
    remainingMs >= expectedMs - toleranceMs && remainingMs <= expectedMs + toleranceMs,
    `${label} expiry should be about ${expectedMs}ms, got ${remainingMs}ms`,
  );
}

async function viewerSocketUrl(mf, ip = '198.51.100.10', expectedTtlMs = 600_000) {
  const token = await request(mf, '/api/ws/live-token', {
    headers: { 'CF-Connecting-IP': ip },
  });
  assertOk(token, 'live viewer token');
  assert.match(token.body.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'viewer token should be signed');
  assert.ok(token.body.expires_at > Date.now(), 'viewer token should include a future expiry');
  assertExpiryWithin(token, 'live viewer token', expectedTtlMs);
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

function assertHistoryCacheStatus(result, label, status) {
  assert.equal(
    result.response.headers.get('x-cf-monitor-history-cache'),
    status,
    `${label} should report public history cache ${status}`,
  );
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
  await assertHealthSuccessThrottleSemantics();
  await assertLoginRateLimitCleanupThrottle();
  await assertLoginFailureReusesLoadedRateLimitBuckets();
  await assertLoginFailureAuditThrottle();
  await assertCsrfRejectionAuditThrottle();
  await assertAgentAuthCacheSemantics();
  await assertAllowedClientIdsCacheSemantics();
  await assertCapacityEstimateUsesClientCapacityCountsOnly();
  await assertAdminClientExistenceChecksUseNarrowSelects();
  await assertAdminClientTokenMetaUsesNarrowSelect();
  await assertDurableObjectPingTaskCacheSemantics();
  await assertBatchClientQueryHelpers();
  await assertPublicClientQueryHelpersUseNarrowSelects();
  await assertSettingsSubsetHelperUsesNarrowSelect();
  await assertPublicAndViewerSettingsUseNarrowReads();
  await assertDurableObjectSettingsUseNarrowReads();
  await assertAdminCapacityAndMaintenanceSettingsUseNarrowReads();
  await assertScheduledCleanupSkipsBacklogCounts();
  await assertRecordCapacityCheckIsAdaptive();
  await assertHistoryStorageCountsSkipAuditLogs();
  await assertReorderWritesOnlyChangedRows();
  await assertLoadMetricStatsBatchHelper();
  const { createScheduledRunContext, normalizeViewerTtlMs } = await import(`${pathToFileURL(bundlePath).href}?smoke=${Date.now()}`);
  assert.equal(normalizeViewerTtlMs(undefined), 600_000, 'viewer TTL should default to 10 minutes');
  assert.equal(normalizeViewerTtlMs(1000), 60_000, 'viewer TTL should clamp to at least 60 seconds');
  assert.equal(normalizeViewerTtlMs(3_600_001), 3_600_000, 'viewer TTL should clamp to at most 1 hour');
  let scheduledSettingsReads = 0;
  let scheduledAllClientReads = 0;
  let scheduledSubsetClientReads = 0;
  const scheduledAllClientSql = 'SELECT uuid, name, created_at, expired_at FROM clients ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC';
  const scheduledContext = createScheduledRunContext({
    DB: {
      prepare(sql) {
        assert.ok(
          sql.startsWith('SELECT key, value FROM settings WHERE key IN') ||
          sql === scheduledAllClientSql ||
          sql.startsWith('SELECT uuid, name, created_at, expired_at FROM clients WHERE uuid IN'),
          `unexpected scheduled context SQL: ${sql}`,
        );
        assert.doesNotMatch(sql, /^SELECT key, value FROM settings$/i, 'scheduled context should not scan all settings');
        assert.doesNotMatch(sql, /SELECT\s+\*/i, 'scheduled context should not read full client rows');
        assert.doesNotMatch(sql, /\btoken\b/i, 'scheduled context should not read client tokens');
        return {
          async all() {
            if (sql === scheduledAllClientSql) {
              scheduledAllClientReads += 1;
              return {
                results: [
                  { uuid: 'scheduled-node-a', name: 'Scheduled Node A', created_at: '2026-06-09T00:00:00.000Z', expired_at: null },
                  { uuid: 'scheduled-node-b', name: 'Scheduled Node B', created_at: '2026-06-09T00:00:00.000Z', expired_at: null },
                ],
              };
            }
            throw new Error(`unexpected scheduled all() SQL without bind: ${sql}`);
          },
          bind(...args) {
            return {
              async all() {
                if (sql.startsWith('SELECT key, value FROM settings WHERE key IN')) {
                  scheduledSettingsReads += 1;
                  assert.deepEqual(
                    args,
                    [
                      'notification_method',
                      'telegram_bot_token',
                      'telegram_chat_id',
                      'record_preserve_time',
                      'ping_record_preserve_time',
                      'audit_log_preserve_time',
                      'offline_notify_never_reported',
                    ],
                    'scheduled context should bind only cron settings keys',
                  );
                  return {
                    results: [
                      { key: 'notification_method', value: 'telegram' },
                      { key: 'live_poll_active_interval_sec', value: '3' },
                    ],
                  };
                }
                scheduledSubsetClientReads += 1;
                return {
                  results: args.map(uuid => ({
                    uuid,
                    name: `Scheduled ${uuid}`,
                    created_at: '2026-06-09T00:00:00.000Z',
                    expired_at: null,
                  })),
                };
              },
            };
          },
        };
      },
    },
  });
  await Promise.all([
    scheduledContext.getSettings(),
    scheduledContext.getAdminSettings(),
    scheduledContext.getSettings(),
  ]);
  assert.equal(scheduledSettingsReads, 1, 'scheduled run context should reuse a single settings D1 read');
  const [scheduledSubsetA, scheduledSubsetB] = await Promise.all([
    scheduledContext.getClients(['scheduled-node-b', 'scheduled-node-a', 'scheduled-node-a']),
    scheduledContext.getClients(['scheduled-node-a', 'scheduled-node-b']),
  ]);
  assert.equal(scheduledSubsetClientReads, 1, 'scheduled run context should cache a normalized client subset read');
  assert.deepEqual(
    scheduledSubsetA.map(client => client.uuid).sort(),
    ['scheduled-node-a', 'scheduled-node-b'],
    'scheduled client subset should return the requested nodes',
  );
  assert.equal(scheduledSubsetA, scheduledSubsetB, 'scheduled context should return the cached subset clients promise');
  const [scheduledClientsA, scheduledClientsB] = await Promise.all([
    scheduledContext.getClients(),
    scheduledContext.getClients(),
  ]);
  assert.equal(scheduledAllClientReads, 1, 'scheduled run context should reuse a single all-clients D1 read');
  assert.equal(scheduledClientsA, scheduledClientsB, 'scheduled run context should return the cached clients promise');

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
    await assertPingIndexShape(mf);

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

    const primaryBasicInfoBody = {
      name: 'vps-hostname',
      os: 'linux',
      arch: 'x64',
      cpu_name: 'Smoke CPU',
      cpu_cores: 2,
      mem_total: 1073741824,
      swap_total: 0,
      disk_total: 4294967296,
      ipv4: '192.0.2.10',
      version: 'smoke-agent',
    };
    const basicInfo = await request(mf, '/api/clients/uploadBasicInfo', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody(primaryBasicInfoBody),
    });
    assertOk(basicInfo, 'agent basic info upload');
    assert.equal(basicInfo.body.success, true, 'basic info upload should succeed');

    const adminClientsAfterBasicInfo = await request(mf, '/api/admin/clients', {
      headers: authHeaders(cookie),
    });
    assertOk(adminClientsAfterBasicInfo, 'list admin nodes after basic info upload');
    const namedClient = expectArray(adminClientsAfterBasicInfo.body, 'admin nodes after basic info upload')
      .find((client) => client.uuid === uuid);
    assert.equal(namedClient?.name, 'Smoke Node', 'agent hostname should not overwrite the admin configured node name');
    const basicInfoD1 = await mf.getD1Database('DB');
    const clientAfterBasicInfo = await basicInfoD1.prepare('SELECT updated_at FROM clients WHERE uuid = ?').bind(uuid).first();
    await delay(1100);
    const duplicateBasicInfo = await request(mf, '/api/clients/uploadBasicInfo', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody(primaryBasicInfoBody),
    });
    assertOk(duplicateBasicInfo, 'duplicate agent basic info upload');
    assert.equal(duplicateBasicInfo.body.success, true, 'duplicate basic info upload should succeed');
    const clientAfterDuplicateBasicInfo = await basicInfoD1.prepare('SELECT updated_at FROM clients WHERE uuid = ?').bind(uuid).first();
    assert.equal(
      clientAfterDuplicateBasicInfo?.updated_at,
      clientAfterBasicInfo?.updated_at,
      'unchanged basic info upload should not write the clients row',
    );

    const clientEditAuditBeforeNoop = await basicInfoD1
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'client_edit'")
      .first();
    const repeatedClientEdit = await request(mf, `/api/admin/clients/${uuid}/edit`, {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ name: 'Smoke Node' }),
    });
    assertOk(repeatedClientEdit, 'repeat identical client edit');
    assert.equal(repeatedClientEdit.body.noop, true, 'identical client edit should be a no-op');
    assert.equal(repeatedClientEdit.body.changed, 0, 'identical client edit should not write the clients row');
    const clientEditAuditAfterNoop = await basicInfoD1
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'client_edit'")
      .first();
    assert.equal(
      clientEditAuditAfterNoop?.count,
      clientEditAuditBeforeNoop?.count,
      'identical client edit should not write a client_edit audit log',
    );

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
    assert.equal(settings.body.changed, 3, 'settings save should only write changed values');

    const settingsD1 = await mf.getD1Database('DB');
    const settingsAuditBeforeNoop = await settingsD1
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'settings_edit'")
      .first();
    const repeatedSettings = await request(mf, '/api/admin/settings', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        notification_method: 'telegram',
        telegram_bot_token: '123456:smoke',
        telegram_chat_id: '98765',
        enable_ip_change_notification: true,
      }),
    });
    assertOk(repeatedSettings, 'repeat identical telegram settings');
    assert.equal(repeatedSettings.body.noop, true, 'identical settings save should be a no-op');
    assert.equal(repeatedSettings.body.changed, 0, 'identical settings save should not write settings rows');
    const settingsAuditAfterNoop = await settingsD1
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'settings_edit'")
      .first();
    assert.equal(
      settingsAuditAfterNoop?.count,
      settingsAuditBeforeNoop?.count,
      'identical settings save should not write a settings_edit audit log',
    );

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
    assert.equal(capacityEstimate.body.capacity_estimate_cache, 'miss', 'first capacity estimate should populate the cache');
    const cachedCapacityEstimate = await request(mf, '/api/admin/capacity', {
      headers: authHeaders(cookie),
    });
    assertOk(cachedCapacityEstimate, 'cached capacity estimate');
    assert.equal(cachedCapacityEstimate.body.capacity_estimate_cache, 'hit', 'repeat capacity estimate should reuse the cache');
    assert.deepEqual(
      { ...cachedCapacityEstimate.body, capacity_estimate_cache: 'miss' },
      capacityEstimate.body,
      'cached capacity estimate should reuse the same estimate body except for cache status',
    );
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

    await new Promise(resolve => setTimeout(resolve, 3100));
    const updateRecordPersistInterval = await request(mf, '/api/admin/settings', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ record_persist_interval_sec: '3' }),
    });
    assertOk(updateRecordPersistInterval, 'update record persist interval');
    assert.equal(updateRecordPersistInterval.body.success, true, 'record persist interval update should succeed');
    const clientBeforeSameVersionReport = await basicInfoD1.prepare('SELECT updated_at FROM clients WHERE uuid = ?').bind(uuid).first();
    const fastPersistReport = await request(mf, '/api/clients/report', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody({
        cpu: 14.5,
        ram: 536870912,
        ram_total: 1073741824,
        disk: 2147483648,
        disk_total: 4294967296,
        net_in: 102,
        net_out: 202,
        version: 'smoke-agent',
      }),
    });
    assertOk(fastPersistReport, 'fast persist interval agent report');
    assert.equal(fastPersistReport.body.success, true, 'fast persist interval agent report should succeed');
    assert.equal(fastPersistReport.body.persisted, true, 'agent report should use the saved record persist interval without waiting for the old interval');
    const clientAfterSameVersionReport = await basicInfoD1.prepare('SELECT updated_at FROM clients WHERE uuid = ?').bind(uuid).first();
    assert.equal(
      clientAfterSameVersionReport?.updated_at,
      clientBeforeSameVersionReport?.updated_at,
      'persisted report with unchanged agent version should not write the clients row',
    );
    const restoreRecordPersistInterval = await request(mf, '/api/admin/settings', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ record_persist_interval_sec: '60' }),
    });
    assertOk(restoreRecordPersistInterval, 'restore record persist interval');

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
    const pagedAuditLogs = await request(mf, '/api/admin/logs?limit=1&page=1', {
      headers: authHeaders(cookie),
    });
    assertOk(pagedAuditLogs, 'paged audit logs');
    assert.equal(Array.isArray(pagedAuditLogs.body.data), true, 'paged audit logs should return data array');
    assert.equal(pagedAuditLogs.body.data.length, 1, 'paged audit logs should honor the requested limit');
    assert.equal(pagedAuditLogs.body.has_more, true, 'paged audit logs should detect the next page without an exact COUNT scan');
    assert.ok(Number(pagedAuditLogs.body.total) >= 2, 'paged audit logs total should be a lower-bound total when more rows exist');
    telegramRequests.length = 0;

    const cachedAuthPolicyBeforeRotate = await request(mf, '/api/clients/policy', {
      headers: agentHeaders(token),
    });
    assertOk(cachedAuthPolicyBeforeRotate, 'agent policy before token rotation');

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
    assert.equal(refreshedPolicy.sample_interval_sec, 5, 'refreshed agent policy should use saved active sample interval');
    assert.equal(refreshedPolicy.report_interval_sec, 300, 'idle policy should use saved 5 minute interval');
    assert.equal(refreshedPolicy.viewer_ttl_sec, 300, 'policy should include saved 5 minute viewer TTL');

    const httpAgentPolicy = await request(mf, '/api/clients/policy', {
      headers: agentHeaders(token),
    });
    assertOk(httpAgentPolicy, 'HTTP agent policy');
    assert.equal(httpAgentPolicy.body.type, 'policy', 'HTTP agent policy should return a policy message');
    assert.equal(httpAgentPolicy.body.mode, 'idle', 'HTTP agent policy should reflect idle mode without viewers');
    assert.equal(httpAgentPolicy.body.sample_interval_sec, 5, 'HTTP agent policy should use saved active sample interval');
    assert.equal(httpAgentPolicy.body.report_interval_sec, 300, 'HTTP agent policy should use saved idle interval');

    const updatedPublicSettings = await request(mf, '/api/public');
    assertOk(updatedPublicSettings, 'updated public settings');
    assert.equal(updatedPublicSettings.body.live_poll_active_interval_sec, '5', 'public settings cache should be invalidated after saving active interval');
    assert.equal(updatedPublicSettings.body.live_poll_idle_interval_sec, '300', 'public settings cache should be invalidated after saving idle interval');
    assert.equal(updatedPublicSettings.body.live_poll_active_max_duration_sec, '300', 'public settings cache should be invalidated after saving viewer TTL');

    const updatedViewerToken = await request(mf, '/api/ws/live-token', {
      headers: { 'CF-Connecting-IP': '198.51.100.12' },
    });
    assertOk(updatedViewerToken, 'updated live viewer token');
    assertExpiryWithin(updatedViewerToken, 'updated live viewer token', 300_000);

    const history = await request(mf, `/api/recent/${uuid}?limit=5`);
    assertOk(history, 'public history');
    assertPublicCache(history, 'public history cache', 10);
    assertHistoryCacheStatus(history, 'first public history request', 'miss');
    assert.ok(
      expectArray(history.body, 'history records').some((record) => record.client === uuid && record.cpu === 12.5),
      'history should include the persisted report',
    );
    const cachedHistory = await request(mf, `/api/recent/${uuid}?limit=5`);
    assertOk(cachedHistory, 'cached public history');
    assertHistoryCacheStatus(cachedHistory, 'repeat public history request', 'hit');
    assert.deepEqual(cachedHistory.body, history.body, 'repeat public history request should reuse the cached JSON body');

    const historyStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const historyEnd = new Date(Date.now() + 60 * 1000).toISOString();
    const pagedHistoryUrl = `/api/records/load?uuid=${uuid}&start=${encodeURIComponent(historyStart)}&end=${encodeURIComponent(historyEnd)}&limit=1&page=1&paged=true`;
    const pagedHistory = await request(mf, pagedHistoryUrl);
    assertOk(pagedHistory, 'public paged history');
    assertHistoryCacheStatus(pagedHistory, 'first public paged history request', 'miss');
    assert.equal(Array.isArray(pagedHistory.body.data), true, 'paged history should return data array');
    assert.equal(pagedHistory.body.data.length, 1, 'paged history should honor the requested limit');
    assert.equal(pagedHistory.body.has_more, true, 'paged history should detect the next page without an exact COUNT scan');
    assert.ok(Number(pagedHistory.body.total) >= 2, 'paged history total should be a lower-bound total when more rows exist');
    const cachedPagedHistory = await request(mf, pagedHistoryUrl);
    assertOk(cachedPagedHistory, 'cached public paged history');
    assertHistoryCacheStatus(cachedPagedHistory, 'repeat public paged history request', 'hit');
    assert.deepEqual(cachedPagedHistory.body, pagedHistory.body, 'repeat paged history request should reuse the cached JSON body');

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

    const pingEditAuditBeforeNoop = await basicInfoD1
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'ping_edit'")
      .first();
    const repeatedPingEdit = await request(mf, '/api/admin/ping/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        id: pingTask.id,
        name: pingTask.name,
        type: pingTask.type,
        target: pingTask.target,
        interval_sec: pingTask.interval_sec,
        all_clients: pingTask.all_clients,
        clients: pingTask.clients,
      }),
    });
    assertOk(repeatedPingEdit, 'repeat identical ping edit');
    assert.equal(repeatedPingEdit.body.noop, true, 'identical ping edit should be a no-op');
    assert.equal(repeatedPingEdit.body.changed, 0, 'identical ping edit should not write ping_tasks');
    const pingEditAuditAfterNoop = await basicInfoD1
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'ping_edit'")
      .first();
    assert.equal(
      pingEditAuditAfterNoop?.count,
      pingEditAuditBeforeNoop?.count,
      'identical ping edit should not write a ping_edit audit log',
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
    assert.equal(capacity.body.capacity_estimate_cache, 'miss', 'capacity cache should be invalidated by client or ping task changes');
    assert.equal(capacity.body.clients, 2, 'capacity should count clients');
    assert.equal(capacity.body.gpu_clients, 0, 'capacity should count GPU-capable clients separately');
    assert.equal(capacity.body.capacity_daily_view_minutes, 60, 'capacity should default to one hour of daily viewing');
    assert.equal(capacity.body.record_persist_interval_sec, 60, 'capacity should include the D1 history persist interval');
    assert.equal(capacity.body.record_high_watermark_rows, 450000, 'capacity should include the D1 history high-watermark');
    assert.equal(capacity.body.active_monitor_records_per_day, 120, 'capacity should estimate active monitor writes from daily viewing minutes');
    assert.equal(capacity.body.idle_monitor_records_per_day, 552, 'capacity should estimate idle monitor writes for the rest of the day');
    assert.equal(capacity.body.monitor_records_per_day, 672, 'capacity should blend active and idle monitor writes');
    assert.equal(capacity.body.gpu_storage_mode, 'snapshots', 'capacity should expose GPU snapshot storage mode');
    assert.equal(capacity.body.gpu_snapshots_per_day, 0, 'capacity should estimate no GPU snapshot writes when nodes have no GPU metadata');
    assert.equal(capacity.body.ping_storage_mode, 'snapshots', 'capacity should expose ping snapshot storage mode');
    assert.equal(capacity.body.legacy_ping_records_per_day, 4320, 'capacity should keep the legacy per-task ping write estimate for comparison');
    assert.equal(capacity.body.ping_records_per_day, 2880, 'capacity should estimate ping snapshot rows per day for 60s and 120s all-client tasks');
    assert.equal(capacity.body.ping_records_saved_per_day, 1440, 'capacity should show rows saved by ping snapshots');
    assert.equal(capacity.body.total_estimated_writes_per_day, 3552, 'capacity should estimate blended total writes per day with ping snapshots');
    assert.ok(capacity.body.actual_row_counts, 'capacity should include actual storage row counts');
    assert.ok(capacity.body.row_counts_checked_at, 'capacity should include row-count cache timestamp');
    assert.equal(capacity.body.row_counts_cache_seconds, 60, 'capacity should expose row-count cache TTL');

    const refreshedCapacity = await request(mf, '/api/admin/capacity?refresh_counts=true', {
      headers: authHeaders(cookie),
    });
    assertOk(refreshedCapacity, 'admin capacity estimate force refresh');
    assert.equal(refreshedCapacity.body.capacity_estimate_cache, 'refresh', 'force refreshed capacity should bypass the estimate cache');
    assert.ok(refreshedCapacity.body.row_counts_checked_at, 'force refreshed capacity should include row-count timestamp');

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

    const validOfflineNotification = await request(mf, '/api/admin/notification/offline/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ client: uuid, enable: true, grace_period: 30 }),
    });
    assertOk(validOfflineNotification, 'valid offline notification');
    assert.equal(validOfflineNotification.body.success, true, 'valid offline notification should save');
    assert.equal(validOfflineNotification.body.changed, 1, 'new offline notification should write once');
    const repeatedOfflineNotification = await request(mf, '/api/admin/notification/offline/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ client: uuid, enable: true, grace_period: 30 }),
    });
    assertOk(repeatedOfflineNotification, 'repeat identical offline notification');
    assert.equal(repeatedOfflineNotification.body.changed, 0, 'identical offline notification should not write');
    assert.equal(repeatedOfflineNotification.body.noop, true, 'identical offline notification should be a no-op');

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
    const loadNotificationsAfterCreate = await request(mf, '/api/admin/notification/load', {
      headers: authHeaders(cookie),
    });
    assertOk(loadNotificationsAfterCreate, 'list load notifications after create');
    const smokeLoadRule = expectArray(loadNotificationsAfterCreate.body, 'load notifications after create')
      .find((item) => item.name === 'Smoke CPU rule');
    assert.ok(smokeLoadRule?.id, 'created load notification should be listed with an id');
    await basicInfoD1.prepare(`
      INSERT INTO load_notifications (name, clients, metric, threshold, ratio, interval_min)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind('Broken clients JSON rule', '{not-json', 'cpu', 80, 0.8, 15).run();
    const loadNotificationsAfterBrokenClients = await request(mf, '/api/admin/notification/load', {
      headers: authHeaders(cookie),
    });
    assertOk(loadNotificationsAfterBrokenClients, 'list load notifications with malformed clients JSON');
    const brokenClientsRule = expectArray(loadNotificationsAfterBrokenClients.body, 'load notifications with malformed clients JSON')
      .find((item) => item.name === 'Broken clients JSON rule');
    assert.deepEqual(brokenClientsRule?.clients, [], 'malformed load notification clients JSON should degrade to an empty client list');
    const repeatedLoadNotification = await request(mf, '/api/admin/notification/load/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        id: smokeLoadRule.id,
        name: smokeLoadRule.name,
        clients: smokeLoadRule.clients,
        metric: smokeLoadRule.metric,
        threshold: smokeLoadRule.threshold,
        ratio: smokeLoadRule.ratio,
        interval_min: smokeLoadRule.interval_min,
      }),
    });
    assertOk(repeatedLoadNotification, 'repeat identical load notification edit');
    assert.equal(repeatedLoadNotification.body.changed, 0, 'identical load notification edit should not write');
    assert.equal(repeatedLoadNotification.body.noop, true, 'identical load notification edit should be a no-op');

    const expiresSoon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const expiryBillingEdit = await request(mf, `/api/admin/clients/${uuid}/edit`, {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ expired_at: expiresSoon }),
    });
    assertOk(expiryBillingEdit, 'set node expiry time');

    const invalidExpiryNotification = await request(mf, '/api/admin/notification/expiry/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ client: 'missing-client', enable: true, advance_days: 7 }),
    });
    assert.equal(invalidExpiryNotification.response.status, 400, 'expiry notification should reject unknown clients');

    const validExpiryNotification = await request(mf, '/api/admin/notification/expiry/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ client: uuid, enable: true, advance_days: 7 }),
    });
    assertOk(validExpiryNotification, 'valid expiry notification');
    assert.equal(validExpiryNotification.body.success, true, 'valid expiry notification should save');
    assert.equal(validExpiryNotification.body.changed, 1, 'new expiry notification should write once');
    const repeatedExpiryNotification = await request(mf, '/api/admin/notification/expiry/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({ client: uuid, enable: true, advance_days: 7 }),
    });
    assertOk(repeatedExpiryNotification, 'repeat identical expiry notification');
    assert.equal(repeatedExpiryNotification.body.changed, 0, 'identical expiry notification should not write');
    assert.equal(repeatedExpiryNotification.body.noop, true, 'identical expiry notification should be a no-op');

    telegramRequests.length = 0;
    const expiryCron = await request(mf, '/api/admin/cron/run', {
      method: 'POST',
      headers: authHeaders(cookie),
    });
    assertOk(expiryCron, 'manual expiry cron trigger');
    assert.equal(
      telegramRequests.some((request) => String(request.payload.text || '').includes('到期提醒')),
      true,
      'expiry cron should send a Telegram expiry reminder',
    );
    telegramRequests.length = 0;

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
    assertHistoryCacheStatus(pingHistory, 'first public ping history request', 'miss');
    assert.ok(
      expectArray(pingHistory.body, 'ping history').some((record) => record.client === uuid && record.value === 37),
      'public ping history should include reported value',
    );
    const cachedPingHistory = await request(mf, `/api/records/ping?uuid=${uuid}&task_id=${pingTask.id}&limit=5`);
    assertOk(cachedPingHistory, 'cached public ping history');
    assertHistoryCacheStatus(cachedPingHistory, 'repeat public ping history request', 'hit');
    assert.deepEqual(cachedPingHistory.body, pingHistory.body, 'repeat ping history request should reuse the cached JSON body');

    const batchPingHistoryUrl = `/api/records/ping/batch?uuid=${uuid}&task_ids=${pingTask.id},${secondPingTask.id}&limit=5`;
    const batchPingHistory = await request(mf, batchPingHistoryUrl);
    assertOk(batchPingHistory, 'public batch ping history');
    assertHistoryCacheStatus(batchPingHistory, 'first public batch ping history request', 'miss');
    assert.ok(
      expectArray(batchPingHistory.body[String(pingTask.id)], 'batch ping history primary task')
        .some((record) => record.client === uuid && record.value === 37),
      'public batch ping history should include reported value for the requested task',
    );
    assert.deepEqual(
      expectArray(batchPingHistory.body[String(secondPingTask.id)], 'batch ping history secondary task'),
      [],
      'public batch ping history should include an empty array for tasks without records',
    );
    const cachedBatchPingHistory = await request(mf, batchPingHistoryUrl);
    assertOk(cachedBatchPingHistory, 'cached public batch ping history');
    assertHistoryCacheStatus(cachedBatchPingHistory, 'repeat public batch ping history request', 'hit');
    assert.deepEqual(cachedBatchPingHistory.body, batchPingHistory.body, 'repeat batch ping history request should reuse the cached JSON body');

    const snapshotBaseTime = Date.parse('2030-01-01T00:30:00.000Z');
    for (let index = 0; index < 30; index += 1) {
      const values = { [pingTask.id]: 100 + index };
      if (index % 10 === 0) values[secondPingTask.id] = 200 + index;
      await basicInfoD1.prepare('INSERT INTO ping_snapshots (client, time, values_json) VALUES (?, ?, ?)')
        .bind(uuid, new Date(snapshotBaseTime - index * 60_000).toISOString(), JSON.stringify(values))
        .run();
    }
    const intervalAwareBatchUrl = `/api/records/ping/batch?uuid=${uuid}&task_specs=${pingTask.id}:5:60,${secondPingTask.id}:3:600&base_interval=60&limit=5`;
    const intervalAwareBatch = await request(mf, intervalAwareBatchUrl);
    assertOk(intervalAwareBatch, 'interval-aware public batch ping history');
    assert.deepEqual(
      expectArray(intervalAwareBatch.body[String(pingTask.id)], 'interval-aware primary ping history').map((record) => record.value),
      [104, 103, 102, 101, 100],
      'interval-aware batch history should keep the requested recent points for the 60s task',
    );
    assert.deepEqual(
      expectArray(intervalAwareBatch.body[String(secondPingTask.id)], 'interval-aware slow ping history').map((record) => record.value),
      [220, 210, 200],
      'interval-aware batch history should scan enough snapshots to return sparse 600s task points',
    );

    const editPingTaskFastInterval = await request(mf, '/api/admin/ping/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        ...pingTask,
        interval_sec: 5,
      }),
    });
    assertOk(editPingTaskFastInterval, 'edit ping task interval to 5s');
    assert.equal(editPingTaskFastInterval.body.success, true, 'ping task interval edit should succeed');

    await new Promise(resolve => setTimeout(resolve, 5100));
    const fastIntervalPingResult = await request(mf, '/api/clients/ping/result', {
      method: 'POST',
      headers: agentHeaders(token),
      body: jsonBody([{ task_id: pingTask.id, value: 39 }]),
    });
    assertOk(fastIntervalPingResult, 'fast interval ping result report');
    assert.equal(
      fastIntervalPingResult.body.accepted,
      1,
      'ping result rate limit should follow the saved task interval instead of the old 60s interval',
    );

    const restorePingTaskInterval = await request(mf, '/api/admin/ping/edit', {
      method: 'POST',
      headers: authHeaders(cookie),
      body: jsonBody({
        ...pingTask,
        interval_sec: 60,
      }),
    });
    assertOk(restorePingTaskInterval, 'restore ping task interval');
    assert.equal(restorePingTaskInterval.body.success, true, 'ping task interval restore should succeed');

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
        version: '2.0.0',
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
    const d1WriteProbeEvent = await basicInfoD1.prepare('SELECT value FROM settings WHERE key = ?').bind('health:d1_write_probe').first();
    assert.ok(d1WriteProbeEvent?.value, 'D1 write probe should persist its health event');
    const firstD1WriteProbeHealth = JSON.parse(d1WriteProbeEvent.value);
    const repeatedHealth = await request(mf, '/api/admin/health', {
      headers: authHeaders(cookie),
    });
    assertOk(repeatedHealth, 'repeat admin health');
    const repeatedD1WriteProbeEvent = await basicInfoD1.prepare('SELECT value FROM settings WHERE key = ?').bind('health:d1_write_probe').first();
    const repeatedD1WriteProbeHealth = JSON.parse(repeatedD1WriteProbeEvent.value);
    assert.equal(
      repeatedD1WriteProbeHealth.last_success_at,
      firstD1WriteProbeHealth.last_success_at,
      'repeat healthy D1 write probe should be throttled and not rewrite health settings',
    );
    const legacyD1WriteProbeMarker = await basicInfoD1.prepare('SELECT value FROM settings WHERE key = ?').bind('health:d1_write_probe:last_probe').first();
    assert.equal(legacyD1WriteProbeMarker, null, 'D1 write probe should not create a second last_probe settings row');

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
