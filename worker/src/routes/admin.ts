/**
 * 管理员 API 路由
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { hashPassword, verifyPassword } from '../auth/password';
import { buildAdminSettings, sanitizeSettingsForStorage } from '../settings/schema';
import {
  BACKUP_EXCLUDED_MODULES,
  BACKUP_ENCRYPTION_ALGORITHM,
  ENCRYPTED_BACKUP_SCHEMA_ID,
  BACKUP_SCHEMA_ID,
  BACKUP_SCOPE,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  decryptBackup,
  encryptBackup,
  summarizeBackup,
  validateBackup,
  type BackupData,
} from '../utils/backup';
import { validatePingTaskInput } from '../utils/ping-task';
import { validateClientCreateInput, validateClientUpdateInput } from '../utils/client';
import { validateExpiryNotificationInput, validateLoadNotificationInput, validateOfflineNotificationInput } from '../utils/notification';
import { escapeTelegramHtml } from '../utils/telegram';
import {
  bestEffortRecordHealthEvent,
  errorDetail,
  readHealthEvents,
  type HealthEvent,
} from '../utils/observability';
import {
  D1_FREE_RETAINED_ROWS_REFERENCE,
  D1_PAID_RETAINED_ROWS_REFERENCE,
  ESTIMATED_MONITOR_RECORD_BYTES,
  ESTIMATED_PING_RECORD_BYTES,
  buildQuotaReference,
} from '../utils/quota';

const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const MIN_ADMIN_PASSWORD_BYTES = 12;
const MIN_JWT_SECRET_BYTES = 32;
const REQUIRED_D1_TABLES = [
  'clients',
  'records',
  'gpu_records',
  'users',
  'login_rate_limits',
  'settings',
  'ping_tasks',
  'ping_records',
  'offline_notifications',
  'expiry_notifications',
  'load_notifications',
  'audit_logs',
];
const REQUIRED_D1_COLUMNS: Record<string, string[]> = {
  clients: ['uuid', 'token', 'name', 'hidden', 'traffic_limit', 'traffic_limit_type', 'sort_order'],
  records: ['client', 'time', 'cpu', 'ram', 'disk', 'net_in', 'net_out'],
  gpu_records: ['client', 'time', 'device_index', 'device_name', 'mem_total', 'mem_used', 'utilization', 'temperature'],
  users: ['uuid', 'username', 'passwd'],
  login_rate_limits: ['bucket', 'failures', 'first_failed_at', 'last_failed_at', 'locked_until'],
  settings: ['key', 'value'],
  ping_tasks: ['id', 'name', 'clients', 'all_clients', 'type', 'target', 'interval_sec', 'sort_order'],
  ping_records: ['client', 'task_id', 'time', 'value'],
  offline_notifications: ['client', 'enable', 'grace_period', 'last_notified'],
  expiry_notifications: ['client', 'enable', 'advance_days', 'last_notified'],
  load_notifications: ['id', 'name', 'clients', 'metric', 'threshold', 'ratio', 'interval_min', 'last_notified'],
  audit_logs: ['id', 'time', 'user', 'action', 'detail', 'level'],
};

async function syncLiveClientMeta(c: any, uuid: string): Promise<void> {
  const client = await db.getClient(c.env.DB, uuid);
  if (!client) return;

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  await stub.fetch(new Request('https://do/client-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uuid: client.uuid,
      name: client.name,
      hidden: Boolean(client.hidden),
    }),
  }));
}

async function removeLiveClient(c: any, uuid: string): Promise<void> {
  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  await stub.fetch(new Request('https://do/client-remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid }),
  }));
}

async function buildBackupSnapshot(database: D1Database): Promise<BackupData> {
  const clients = await db.listClients(database);
  const settings = buildAdminSettings(await db.getAllSettings(database));
  const pingTasks = await db.listPingTasks(database);
  const offlineNotifications = await db.listOfflineNotifications(database);
  const expiryNotifications = await db.listExpiryNotifications(database);
  const loadNotifications = await db.listLoadNotifications(database);

  return {
    schema: BACKUP_SCHEMA_ID,
    version: BACKUP_VERSION,
    scope: BACKUP_SCOPE,
    timestamp: new Date().toISOString(),
    excluded: [...BACKUP_EXCLUDED_MODULES],
    sensitive: true,
    clients,
    settings,
    ping_tasks: pingTasks,
    offline_notifications: offlineNotifications,
    expiry_notifications: expiryNotifications,
    load_notifications: loadNotifications,
  };
}

function isQueryFlagEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isBodyFlagEnabled(body: unknown, key: string): boolean {
  return !!body && typeof body === 'object' && (body as Record<string, unknown>)[key] === true;
}

function getRequestIp(c: any): string {
  const forwardedFor = c.req.header('X-Forwarded-For') || '';
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Real-IP') ||
    forwardedFor.split(',')[0]?.trim() ||
    'unknown'
  );
}

function getRestoreConfirmationState(c: any, body: unknown): {
  confirmed: boolean;
  confirmRestore: boolean;
  acknowledgeOverwrite: boolean;
} {
  const confirmRestore =
    isQueryFlagEnabled(c.req.query('confirm_restore')) ||
    isBodyFlagEnabled(body, 'confirm_restore');
  const acknowledgeOverwrite =
    isQueryFlagEnabled(c.req.query('acknowledge_overwrite')) ||
    isBodyFlagEnabled(body, 'acknowledge_overwrite');

  return {
    confirmed: confirmRestore && acknowledgeOverwrite,
    confirmRestore,
    acknowledgeOverwrite,
  };
}

function jsonSizeBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isEncryptedBackupEnvelope(value: unknown): boolean {
  return !!value &&
    typeof value === 'object' &&
    ((value as Record<string, unknown>).schema === ENCRYPTED_BACKUP_SCHEMA_ID ||
      (value as Record<string, unknown>).encrypted === true);
}

async function getAllowedClientIds(database: D1Database): Promise<Set<string>> {
  const clients = await db.listClients(database);
  return new Set(clients.map(client => client.uuid));
}

async function runD1WriteProbe(database: D1Database): Promise<HealthEvent> {
  const checkedAt = new Date().toISOString();
  try {
    await db.setSetting(database, 'health:d1_write_probe:last_probe', checkedAt);
    await bestEffortRecordHealthEvent(database, 'd1_write_probe', 'ok', 'D1 write probe succeeded');
    return {
      component: 'd1_write_probe',
      status: 'ok',
      updated_at: checkedAt,
      last_success_at: checkedAt,
      detail: 'D1 write probe succeeded',
    };
  } catch (error) {
    return {
      component: 'd1_write_probe',
      status: 'error',
      updated_at: checkedAt,
      last_failure_at: checkedAt,
      detail: `D1 write probe failed: ${errorDetail(error)}`,
    };
  }
}

function healthEvent(
  component: string,
  status: HealthEvent['status'],
  detail: string,
  checkedAt: string,
): HealthEvent {
  return {
    component,
    status,
    updated_at: checkedAt,
    ...(status === 'ok' ? { last_success_at: checkedAt } : { last_failure_at: checkedAt }),
    detail,
  };
}

async function runSchemaProbe(database: D1Database, checkedAt: string): Promise<HealthEvent> {
  try {
    const rows = await database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_D1_TABLES.map(() => '?').join(', ')})`
    ).bind(...REQUIRED_D1_TABLES).all<{ name: string }>();
    const existing = new Set((rows.results || []).map(row => row.name));
    const missing = REQUIRED_D1_TABLES.filter(table => !existing.has(table));
    if (missing.length > 0) {
      return healthEvent('schema_probe', 'error', `Missing D1 tables: ${missing.join(', ')}`, checkedAt);
    }

    const missingColumns: string[] = [];
    for (const [table, columns] of Object.entries(REQUIRED_D1_COLUMNS)) {
      const columnRows = await database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const existingColumns = new Set((columnRows.results || []).map(row => row.name));
      for (const column of columns) {
        if (!existingColumns.has(column)) {
          missingColumns.push(`${table}.${column}`);
        }
      }
    }
    if (missingColumns.length > 0) {
      return healthEvent('schema_probe', 'error', `Missing D1 columns: ${missingColumns.join(', ')}`, checkedAt);
    }

    return healthEvent('schema_probe', 'ok', `D1 schema contains ${REQUIRED_D1_TABLES.length} required tables and required columns`, checkedAt);
  } catch (error) {
    return healthEvent('schema_probe', 'error', `D1 schema probe failed: ${errorDetail(error)}`, checkedAt);
  }
}

async function runDoProbe(c: any, checkedAt: string): Promise<HealthEvent> {
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const response = await stub.fetch(new Request('https://do/live', { method: 'GET' }));
    if (!response.ok) {
      return healthEvent('do_binding_probe', 'error', `LIVE_DATA probe returned HTTP ${response.status}`, checkedAt);
    }
    const snapshot = await response.json() as any;
    if (!Array.isArray(snapshot.online) || typeof snapshot.count !== 'number') {
      return healthEvent('do_binding_probe', 'error', 'LIVE_DATA probe returned an invalid live snapshot', checkedAt);
    }
    return healthEvent('do_binding_probe', 'ok', 'LIVE_DATA binding responded with a live snapshot', checkedAt);
  } catch (error) {
    return healthEvent('do_binding_probe', 'error', `LIVE_DATA probe failed: ${errorDetail(error)}`, checkedAt);
  }
}

function runSecretProbe(env: Bindings, checkedAt: string): HealthEvent {
  const missing: string[] = [];
  if (new TextEncoder().encode(env.JWT_SECRET?.trim() || '').length < MIN_JWT_SECRET_BYTES) {
    missing.push('JWT_SECRET must be at least 32 bytes');
  }
  if (!env.ADMIN_USERNAME?.trim()) {
    missing.push('ADMIN_USERNAME is empty');
  }
  if (new TextEncoder().encode(env.ADMIN_PASSWORD?.trim() || '').length < MIN_ADMIN_PASSWORD_BYTES) {
    missing.push(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_BYTES} bytes`);
  }
  if (missing.length > 0) {
    return healthEvent('secret_probe', 'error', missing.join('; '), checkedAt);
  }
  return healthEvent('secret_probe', 'ok', 'Required admin secrets are configured', checkedAt);
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseJsonArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseUniqueStringList(value: unknown, maxItems = 100): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: '客户端列表不能为空' };
  }
  const values = [...new Set(
    value
      .map((item: unknown) => String(item || '').trim())
      .filter(Boolean),
  )];
  if (values.length === 0) {
    return { ok: false, error: '客户端列表不能为空' };
  }
  if (values.length > maxItems) {
    return { ok: false, error: `一次最多处理 ${maxItems} 个客户端` };
  }
  return { ok: true, values };
}

function capacityRiskLevel(estimatedRows: number, freeRows: number, paidRows: number): 'ok' | 'watch' | 'high' {
  if (estimatedRows >= paidRows * 0.7) return 'high';
  if (estimatedRows >= freeRows * 0.7) return 'watch';
  return 'ok';
}

async function buildCapacityEstimate(database: D1Database) {
  const clients = await db.listClients(database);
  const settings = buildAdminSettings(await db.getAllSettings(database));
  const pingTasks = await db.listPingTasks(database);
  const clientCount = clients.length;
  const recordEnabled = settings.record_enabled !== 'false';
  const recordPreserveHours = Math.min(72, parsePositiveNumber(settings.record_preserve_time, 72));
  const pingPreserveHours = Math.min(72, parsePositiveNumber(settings.ping_record_preserve_time, recordPreserveHours));
  const sampleIntervalSec = Math.max(3, parsePositiveNumber(settings.live_poll_active_interval_sec, 3));
  const idleIntervalSec = Math.max(60, parsePositiveNumber(settings.live_poll_idle_interval_sec, 600));
  const persistIntervalSec = Math.max(3, parsePositiveNumber(settings.record_persist_interval_sec, 60));
  const highWatermarkRows = Math.min(10_000_000, Math.max(1_000, parsePositiveNumber(settings.record_high_watermark_rows, 450_000)));
  const effectiveActiveIntervalSec = Math.max(sampleIntervalSec, persistIntervalSec);
  const effectiveIdleIntervalSec = Math.max(idleIntervalSec, persistIntervalSec);
  const dailyViewMinutes = parseBoundedNumber(settings.capacity_daily_view_minutes, 60, 0, 1440);
  const activeSecondsPerDay = Math.floor(dailyViewMinutes * 60);
  const idleSecondsPerDay = Math.max(0, 86400 - activeSecondsPerDay);
  const activeMonitorRecordsPerDay = recordEnabled && activeSecondsPerDay > 0
    ? Math.ceil(clientCount * activeSecondsPerDay / effectiveActiveIntervalSec)
    : 0;
  const idleMonitorRecordsPerDay = recordEnabled && idleSecondsPerDay > 0
    ? Math.ceil(clientCount * idleSecondsPerDay / effectiveIdleIntervalSec)
    : 0;
  const monitorRecordsPerDay = activeMonitorRecordsPerDay + idleMonitorRecordsPerDay;
  let pingRecordsPerDay = 0;

  const pingTasksWithEstimates = pingTasks.map((task) => {
    const intervalSec = Math.max(1, parsePositiveNumber(task.interval_sec, 60));
    const targetClientCount = task.all_clients
      ? clientCount
      : parseJsonArray(task.clients).filter((uuid) => typeof uuid === 'string').length;
    const writesPerDay = Math.ceil(targetClientCount * 86400 / intervalSec);
    pingRecordsPerDay += writesPerDay;
    return {
      id: task.id,
      name: task.name,
      interval_sec: intervalSec,
      target_client_count: targetClientCount,
      estimated_writes_per_day: writesPerDay,
    };
  });

  const estimatedMonitorRecordsRetained = Math.ceil(monitorRecordsPerDay * recordPreserveHours / 24);
  const estimatedPingRecordsRetained = Math.ceil(pingRecordsPerDay * pingPreserveHours / 24);
  const estimatedRowsRetained = estimatedMonitorRecordsRetained + estimatedPingRecordsRetained;
  const estimatedStorageBytes = estimatedMonitorRecordsRetained * ESTIMATED_MONITOR_RECORD_BYTES
    + estimatedPingRecordsRetained * ESTIMATED_PING_RECORD_BYTES;
  const quotaReference = buildQuotaReference();
  let actualRowCounts: Awaited<ReturnType<typeof db.getStorageRowCounts>> | null = null;
  let expiredRowCounts: Awaited<ReturnType<typeof db.getExpiredRowCounts>> | null = null;
  try {
    actualRowCounts = await db.getStorageRowCounts(database);
  } catch {
    actualRowCounts = null;
  }
  try {
    const now = Date.now();
    expiredRowCounts = await db.getExpiredRowCounts(database, {
      records: new Date(now - recordPreserveHours * 60 * 60 * 1000).toISOString(),
      ping_records: new Date(now - pingPreserveHours * 60 * 60 * 1000).toISOString(),
      audit_logs: new Date(now - 2160 * 60 * 60 * 1000).toISOString(),
    });
  } catch {
    expiredRowCounts = null;
  }
  const d1ReferenceRows = {
    free_reference_rows: D1_FREE_RETAINED_ROWS_REFERENCE,
    paid_reference_rows: D1_PAID_RETAINED_ROWS_REFERENCE,
  };

  return {
    clients: clientCount,
    record_enabled: recordEnabled,
    record_preserve_hours: recordPreserveHours,
    ping_record_preserve_hours: pingPreserveHours,
    record_persist_interval_sec: persistIntervalSec,
    record_high_watermark_rows: highWatermarkRows,
    capacity_daily_view_minutes: dailyViewMinutes,
    active_seconds_per_day: activeSecondsPerDay,
    idle_seconds_per_day: idleSecondsPerDay,
    active_monitor_records_per_day: activeMonitorRecordsPerDay,
    idle_monitor_records_per_day: idleMonitorRecordsPerDay,
    monitor_records_per_day: monitorRecordsPerDay,
    ping_records_per_day: pingRecordsPerDay,
    total_estimated_writes_per_day: monitorRecordsPerDay + pingRecordsPerDay,
    estimated_monitor_records_retained: estimatedMonitorRecordsRetained,
    estimated_ping_records_retained: estimatedPingRecordsRetained,
    estimated_rows_retained: estimatedRowsRetained,
    estimated_storage_bytes: estimatedStorageBytes,
    actual_row_counts: actualRowCounts,
    expired_row_counts: expiredRowCounts,
    d1_reference_rows: d1ReferenceRows,
    quota_reference: quotaReference,
    risk_level: capacityRiskLevel(
      estimatedRowsRetained,
      d1ReferenceRows.free_reference_rows,
      d1ReferenceRows.paid_reference_rows,
    ),
    ping_tasks: pingTasksWithEstimates,
  };
}

async function runMaintenanceCleanup(database: D1Database, username: string, now = new Date()) {
  const settings = buildAdminSettings(await db.getAllSettings(database));
  const recordHours = Math.min(72, Math.max(1, Number(settings.record_preserve_time || 72)));
  const pingHours = Math.min(72, Math.max(1, Number(settings.ping_record_preserve_time || recordHours)));
  const auditHours = Math.max(24, Number(settings.audit_log_preserve_time || 2160));
  const before = {
    records: new Date(now.getTime() - recordHours * 60 * 60 * 1000).toISOString(),
    ping_records: new Date(now.getTime() - pingHours * 60 * 60 * 1000).toISOString(),
    audit_logs: new Date(now.getTime() - auditHours * 60 * 60 * 1000).toISOString(),
  };
  const expiredBacklogBefore = await db.getExpiredRowCounts(database, before);
  const maxExpiredBacklog = Math.max(
    expiredBacklogBefore.records,
    expiredBacklogBefore.gpu_records,
    expiredBacklogBefore.ping_records,
    expiredBacklogBefore.audit_logs,
  );
  const cleanupOptions = {
    maxBatches: Math.min(1000, Math.max(200, Math.ceil(maxExpiredBacklog / 100))),
  };
  const deleted = {
    ...(await db.deleteOldRecords(database, before.records, cleanupOptions)),
    ...(await db.deleteOldPingRecords(database, before.ping_records, cleanupOptions)),
    ...(await db.deleteOldAuditLogs(database, before.audit_logs, cleanupOptions)),
  };
  const orphanCleanup = await db.cleanupOrphanClientData(database);
  const expiredBacklogAfter = await db.getExpiredRowCounts(database, before);
  const result = {
    success: true,
    before,
    cleanup_options: cleanupOptions,
    deleted,
    orphan_cleanup: orphanCleanup,
    expired_backlog_before: expiredBacklogBefore,
    expired_backlog_after: expiredBacklogAfter,
  };
  await db.insertAuditLog(database, username, 'maintenance_cleanup', `手动维护清理完成: ${JSON.stringify(result)}`);
  return result;
}

// ============ 客户端管理 ============

// 获取所有客户端（含隐藏的）
adminRoutes.get('/clients', async (c) => {
  const clients = await db.listClients(c.env.DB);
  return c.json(clients);
});

// 获取单个客户端
adminRoutes.get('/clients/:uuid', async (c) => {
  const uuid = c.req.param('uuid');
  const client = await db.getClient(c.env.DB, uuid);
  if (!client) {
    return c.json({ error: '客户端不存在' }, 404);
  }
  return c.json(client);
});

// 添加客户端（手动创建）
adminRoutes.post('/clients/add', async (c) => {
  try {
    const body = await c.req.json();
    const validated = validateClientCreateInput(body);
    if (!validated.ok) {
      return c.json({ error: '客户端校验失败', details: validated.errors }, 400);
    }

    const { uuid, token, name } = validated.client;
    if (await db.getClient(c.env.DB, uuid)) {
      return c.json({ error: '客户端 UUID 已存在' }, 409);
    }
    if (await db.getClientByToken(c.env.DB, token)) {
      return c.json({ error: '客户端 Token 已存在' }, 409);
    }

    await db.createClient(c.env.DB, {
      uuid,
      token,
      name,
    });
    await syncLiveClientMeta(c, uuid);

    await db.insertAuditLog(c.env.DB, c.get('username')!, 'client_add', `添加客户端: ${name}`);

    return c.json({ uuid, token });
  } catch (e) {
    return c.json({ error: '创建失败' }, 500);
  }
});

// 编辑客户端
adminRoutes.post('/clients/:uuid/edit', async (c) => {
  try {
    const uuid = c.req.param('uuid');
    const body = await c.req.json();
    const existing = await db.getClient(c.env.DB, uuid);
    if (!existing) {
      return c.json({ error: '客户端不存在' }, 404);
    }

    const validated = validateClientUpdateInput(body);
    if (!validated.ok) {
      return c.json({ error: '客户端校验失败', details: validated.errors }, 400);
    }

    await db.updateClient(c.env.DB, uuid, validated.client as any);
    await syncLiveClientMeta(c, uuid);
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'client_edit', `编辑客户端: ${uuid}`);

    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: '编辑失败' }, 500);
  }
});

// 删除客户端
adminRoutes.post('/clients/:uuid/remove', async (c) => {
  const uuid = c.req.param('uuid');
  await db.deleteClient(c.env.DB, uuid);
  await removeLiveClient(c, uuid);
  // 同时清除相关记录
  await db.clearClientRecords(c.env.DB, uuid);
  const cleanup = await db.pruneClientReferences(c.env.DB, uuid);
  await db.insertAuditLog(c.env.DB, c.get('username')!, 'client_remove', `删除客户端: ${uuid}; 清理引用: ${JSON.stringify(cleanup)}`);
  return c.json({ success: true });
});

// 获取客户端 Token
adminRoutes.get('/clients/:uuid/token', async (c) => {
  const uuid = c.req.param('uuid');
  const client = await db.getClient(c.env.DB, uuid);
  if (!client) {
    return c.json({ error: '客户端不存在' }, 404);
  }
  return c.json({ token: client.token });
});

adminRoutes.post('/clients/:uuid/token/rotate', async (c) => {
  const uuid = c.req.param('uuid');
  const client = await db.getClient(c.env.DB, uuid);
  if (!client) {
    return c.json({ error: '客户端不存在' }, 404);
  }

  let token = crypto.randomUUID();
  for (let attempt = 0; attempt < 5 && await db.getClientByToken(c.env.DB, token); attempt += 1) {
    token = crypto.randomUUID();
  }
  if (await db.getClientByToken(c.env.DB, token)) {
    return c.json({ error: '生成新 Token 失败，请重试' }, 500);
  }

  await db.rotateClientToken(c.env.DB, uuid, token);
  await removeLiveClient(c, uuid);
  await db.insertAuditLog(c.env.DB, c.get('username')!, 'client_token_rotate', `重置客户端 Token: ${client.name || uuid}`);
  return c.json({ success: true, token });
});

adminRoutes.post('/clients/reorder', async (c) => {
  try {
    const body = await c.req.json();
    const uuids = Array.isArray(body.uuids)
      ? body.uuids.map((uuid: unknown) => String(uuid || '').trim()).filter(Boolean)
      : [];

    if (uuids.length === 0) {
      return c.json({ error: '客户端排序列表不能为空' }, 400);
    }

    if (new Set(uuids).size !== uuids.length) {
      return c.json({ error: '客户端排序列表不能包含重复 UUID' }, 400);
    }

    const updated = await db.reorderClients(c.env.DB, uuids);
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'client_reorder', `调整客户端排序: ${uuids.join(',')}`);
    return c.json({ success: true, updated });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '排序失败' }, 400);
  }
});

adminRoutes.post('/clients/batch-hide', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = parseUniqueStringList(body.uuids);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const uuids = parsed.values;

    let updated = 0;
    const missing: string[] = [];
    for (const uuid of uuids) {
      const existing = await db.getClient(c.env.DB, uuid);
      if (!existing) {
        missing.push(uuid);
        continue;
      }
      await db.updateClient(c.env.DB, uuid, { hidden: true });
      await syncLiveClientMeta(c, uuid);
      updated += 1;
    }

    await db.insertAuditLog(c.env.DB, c.get('username')!, 'client_batch_hide', `批量隐藏客户端: ${uuids.join(',')}; updated=${updated}; missing=${missing.join(',')}`);
    return c.json({ success: true, updated, missing });
  } catch {
    return c.json({ error: '批量隐藏失败' }, 500);
  }
});

adminRoutes.post('/clients/batch-remove', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = parseUniqueStringList(body.uuids);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const uuids = parsed.values;

    let removed = 0;
    const missing: string[] = [];
    for (const uuid of uuids) {
      const existing = await db.getClient(c.env.DB, uuid);
      if (!existing) {
        missing.push(uuid);
        continue;
      }
      await db.deleteClient(c.env.DB, uuid);
      await removeLiveClient(c, uuid);
      await db.clearClientRecords(c.env.DB, uuid);
      await db.pruneClientReferences(c.env.DB, uuid);
      removed += 1;
    }

    await db.insertAuditLog(c.env.DB, c.get('username')!, 'client_batch_remove', `批量删除客户端: ${uuids.join(',')}; removed=${removed}; missing=${missing.join(',')}`);
    return c.json({ success: true, removed, missing });
  } catch {
    return c.json({ error: '批量删除失败' }, 500);
  }
});

// ============ 数据记录管理 ============

// 清除指定客户端记录
adminRoutes.post('/record/clear', async (c) => {
  try {
    const body = await c.req.json();
    const uuid = body.uuid;
    if (uuid) {
      await db.clearClientRecords(c.env.DB, uuid);
    }
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'record_clear', `清除记录: ${uuid}`);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '清除失败' }, 500);
  }
});

// 清除所有记录
adminRoutes.post('/record/clear/all', async (c) => {
  await db.clearAllRecords(c.env.DB);
  await db.insertAuditLog(c.env.DB, c.get('username')!, 'record_clear_all', '清除所有记录');
  return c.json({ success: true });
});

// ============ Ping 任务管理 ============

// 获取所有 Ping 任务
adminRoutes.get('/ping', async (c) => {
  const tasks = await db.listPingTasks(c.env.DB);
  return c.json(tasks);
});

// 添加 Ping 任务
adminRoutes.post('/ping/add', async (c) => {
  try {
    const body = await c.req.json();
    const validated = validatePingTaskInput(body, await getAllowedClientIds(c.env.DB));
    if (!validated.ok) {
      return c.json({ error: 'Ping 任务校验失败', details: validated.errors }, 400);
    }

    await db.createPingTask(c.env.DB, validated.task);
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'ping_add', `添加 Ping 任务: ${validated.task.name}`);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '添加失败' }, 500);
  }
});

// 编辑 Ping 任务
adminRoutes.post('/ping/edit', async (c) => {
  try {
    const body = await c.req.json();
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Ping 任务 ID 无效' }, 400);
    }

    const existing = await db.getPingTask(c.env.DB, id);
    if (!existing) {
      return c.json({ error: 'Ping 任务不存在' }, 404);
    }

    const candidate = {
      ...existing,
      ...body,
      interval_sec: body.interval ?? body.interval_sec ?? existing.interval_sec,
    };
    const validated = validatePingTaskInput(candidate, await getAllowedClientIds(c.env.DB));
    if (!validated.ok) {
      return c.json({ error: 'Ping 任务校验失败', details: validated.errors }, 400);
    }

    await db.updatePingTask(c.env.DB, id, validated.task);
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'ping_edit', `编辑 Ping 任务: ${id}`);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '编辑失败' }, 500);
  }
});

adminRoutes.post('/ping/reorder', async (c) => {
  try {
    const body = await c.req.json();
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0)
      : [];

    if (ids.length === 0) {
      return c.json({ error: 'Ping 任务排序列表不能为空' }, 400);
    }

    if (new Set(ids).size !== ids.length) {
      return c.json({ error: 'Ping 任务排序列表不能包含重复 ID' }, 400);
    }

    const updated = await db.reorderPingTasks(c.env.DB, ids);
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'ping_reorder', `调整 Ping 任务排序: ${ids.join(',')}`);
    return c.json({ success: true, updated });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '排序失败' }, 400);
  }
});

// 删除 Ping 任务
adminRoutes.post('/ping/delete', async (c) => {
  try {
    const body = await c.req.json();
    await db.deletePingTask(c.env.DB, body.id);
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'ping_delete', `删除 Ping 任务: ${body.id}`);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '删除失败' }, 500);
  }
});

// ============ 系统设置 ============

// 获取所有设置
adminRoutes.get('/settings', async (c) => {
  const settings = await db.getAllSettings(c.env.DB);
  return c.json(buildAdminSettings(settings));
});

// 修改设置
adminRoutes.post('/settings', async (c) => {
  try {
    const body = await c.req.json();
    const normalized = sanitizeSettingsForStorage(body);
    if (!normalized.ok) {
      return c.json({ error: '设置校验失败', details: normalized.errors }, 400);
    }

    for (const [key, value] of Object.entries(normalized.settings)) {
      await db.setSetting(c.env.DB, key, value);
    }
    if (
      'live_poll_active_interval_sec' in normalized.settings ||
      'live_poll_idle_interval_sec' in normalized.settings ||
      'live_poll_active_max_duration_sec' in normalized.settings
    ) {
      const doId = c.env.LIVE_DATA.idFromName('global');
      const stub = c.env.LIVE_DATA.get(doId);
      await stub.fetch(new Request('https://do/policy-refresh', { method: 'POST' }));
    }
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'settings_edit', '修改系统设置');
    return c.json({ success: true, ignored: normalized.ignoredKeys });
  } catch {
    return c.json({ error: '保存失败' }, 500);
  }
});

// ============ 通知设置 ============

// 离线通知列表
adminRoutes.get('/notification/offline', async (c) => {
  const notifications = await db.listOfflineNotifications(c.env.DB);
  return c.json(notifications);
});

// 编辑离线通知 (支持单个和批量)
adminRoutes.post('/notification/offline/edit', async (c) => {
  try {
    const body = await c.req.json();
    const allowedClientIds = await getAllowedClientIds(c.env.DB);
    // 支持批量编辑：数组形式
    const items = Array.isArray(body) ? body : [body];
    const normalized = [];
    const errors: string[] = [];
    for (const [index, item] of items.entries()) {
      const validated = validateOfflineNotificationInput(item, allowedClientIds);
      if (!validated.ok) {
        errors.push(...validated.errors.map(error => `${index}: ${error}`));
      } else {
        normalized.push(validated.item);
      }
    }
    if (errors.length > 0) {
      return c.json({ error: '离线通知校验失败', details: errors }, 400);
    }
    for (const item of normalized) {
      await db.setOfflineNotification(c.env.DB, item.client, item.enable, item.grace_period);
    }
    return c.json({ success: true, updated: normalized.length });
  } catch {
    return c.json({ error: '保存失败' }, 500);
  }
});

// 到期通知列表
adminRoutes.get('/notification/expiry', async (c) => {
  const notifications = await db.listExpiryNotifications(c.env.DB);
  return c.json(notifications);
});

// 编辑到期通知 (支持单个和批量)
adminRoutes.post('/notification/expiry/edit', async (c) => {
  try {
    const body = await c.req.json();
    const allowedClientIds = await getAllowedClientIds(c.env.DB);
    const items = Array.isArray(body) ? body : [body];
    const normalized = [];
    const errors: string[] = [];
    for (const [index, item] of items.entries()) {
      const validated = validateExpiryNotificationInput(item, allowedClientIds);
      if (!validated.ok) {
        errors.push(...validated.errors.map(error => `${index}: ${error}`));
      } else {
        normalized.push(validated.item);
      }
    }
    if (errors.length > 0) {
      return c.json({ error: '到期通知校验失败', details: errors }, 400);
    }
    for (const item of normalized) {
      await db.setExpiryNotification(c.env.DB, item.client, item.enable, item.advance_days);
    }
    return c.json({ success: true, updated: normalized.length });
  } catch {
    return c.json({ error: '保存失败' }, 500);
  }
});

// 负载通知列表
adminRoutes.get('/notification/load', async (c) => {
  const notifications = await db.listLoadNotifications(c.env.DB);
  return c.json(notifications);
});

// 添加负载通知
adminRoutes.post('/notification/load/add', async (c) => {
  try {
    const body = await c.req.json();
    const validated = validateLoadNotificationInput(body, await getAllowedClientIds(c.env.DB));
    if (!validated.ok) {
      return c.json({ error: '负载通知校验失败', details: validated.errors }, 400);
    }
    await db.createLoadNotification(c.env.DB, validated.item);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '添加失败' }, 500);
  }
});

// 编辑负载通知
adminRoutes.post('/notification/load/edit', async (c) => {
  try {
    const body = await c.req.json();
    const validated = validateLoadNotificationInput(body, await getAllowedClientIds(c.env.DB), { requireId: true });
    if (!validated.ok) {
      return c.json({ error: '负载通知校验失败', details: validated.errors }, 400);
    }
    const { id, ...data } = validated.item;
    const existing = await db.getLoadNotification(c.env.DB, id!);
    if (!existing) return c.json({ error: '负载通知不存在' }, 404);
    await db.updateLoadNotification(c.env.DB, id!, data);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '编辑失败' }, 500);
  }
});

// 删除负载通知 (DELETE /:id)
adminRoutes.delete('/notification/load/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: '负载通知 ID 无效' }, 400);
  }
  await db.deleteLoadNotification(c.env.DB, id);
  return c.json({ success: true });
});

// 编辑负载通知 (POST /:id)
adminRoutes.post('/notification/load/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const validated = validateLoadNotificationInput(
      { ...body, id },
      await getAllowedClientIds(c.env.DB),
      { requireId: true },
    );
    if (!validated.ok) {
      return c.json({ error: '负载通知校验失败', details: validated.errors }, 400);
    }
    const { id: _id, ...data } = validated.item;
    const existing = await db.getLoadNotification(c.env.DB, id);
    if (!existing) return c.json({ error: '负载通知不存在' }, 404);
    await db.updateLoadNotification(c.env.DB, id, data);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '编辑失败' }, 500);
  }
});

// 删除负载通知 (legacy)
adminRoutes.post('/notification/load/delete', async (c) => {
  try {
    const body = await c.req.json();
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: '负载通知 ID 无效' }, 400);
    }
    await db.deleteLoadNotification(c.env.DB, id);
    return c.json({ success: true });
  } catch {
    return c.json({ error: '删除失败' }, 500);
  }
});

// ============ 账户管理 ============

// 修改密码
adminRoutes.post('/account/chpasswd', async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId')!;
    const username = c.get('username')!;
    const user = await db.getUserByUsername(c.env.DB, username);

    if (typeof body.old_password !== 'string' || typeof body.new_password !== 'string') {
      return c.json({ error: '密码格式错误' }, 400);
    }

    if (new TextEncoder().encode(body.new_password).byteLength < MIN_ADMIN_PASSWORD_BYTES) {
      return c.json({ error: '新密码至少需要 12 字节' }, 400);
    }

    if (!user) {
      return c.json({ error: '用户不存在' }, 404);
    }

    // Verify the current password before replacing it.
    const valid = await verifyPassword(body.old_password, user.passwd);
    if (!valid) {
      return c.json({ error: '旧密码错误' }, 400);
    }

    const newHash = await hashPassword(body.new_password);
    await db.updateUserPassword(c.env.DB, userId, newHash);
    await db.insertAuditLog(c.env.DB, username, 'chpasswd', '修改密码');

    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: '修改失败' }, 500);
  }
});

// ============ 审计日志 ============

adminRoutes.get('/logs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100');
  const page = parseInt(c.req.query('page') || '1');
  const logs = await db.listAuditLogsPaged(c.env.DB, page, Math.min(limit, 500));
  return c.json({
    data: logs.logs,
    total: logs.total,
    page: Math.max(1, page),
    limit: Math.min(limit, 500),
  });
});

adminRoutes.get('/health', async (c) => {
  const checkedAt = new Date().toISOString();
  const d1Probe = await runD1WriteProbe(c.env.DB);
  const components: Record<string, HealthEvent | null> = d1Probe.status === 'error' ? {} : await readHealthEvents(c.env.DB);
  components.d1_write_probe = components.d1_write_probe || d1Probe;
  if (d1Probe.status !== 'error') {
    components.schema_probe = await runSchemaProbe(c.env.DB, checkedAt);
  }
  components.do_binding_probe = await runDoProbe(c, checkedAt);
  components.secret_probe = runSecretProbe(c.env, checkedAt);
  const ok = d1Probe.status !== 'error' &&
    Object.values(components).every(event => !event || event.status !== 'error');

  return c.json({
    ok,
    checked_at: checkedAt,
    components,
  }, ok ? 200 : 503);
});

adminRoutes.get('/capacity', async (c) => {
  return c.json(await buildCapacityEstimate(c.env.DB));
});

adminRoutes.post('/maintenance/cleanup', async (c) => {
  try {
    return c.json(await runMaintenanceCleanup(c.env.DB, c.get('username')!));
  } catch (error) {
    await db.insertAuditLog(c.env.DB, c.get('username')!, 'maintenance_cleanup_error', `手动维护清理失败: ${errorDetail(error)}`, 'error');
    return c.json({ error: '维护清理失败' }, 500);
  }
});

// ============ 备份相关 ============

// 下载加密完整备份（包含配置和 token，不包含账号、审计和历史记录）
adminRoutes.post('/download/backup', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const backupPassword = typeof body.backup_password === 'string' ? body.backup_password : '';
    const backup = await buildBackupSnapshot(c.env.DB);
    const encrypted = await encryptBackup(backup, backupPassword);
    if (!encrypted.ok) {
      return c.json({ error: encrypted.error }, 400);
    }

    await db.insertAuditLog(
      c.env.DB,
      c.get('username')!,
      'backup_download',
      `下载加密完整备份: ${JSON.stringify({
        ...summarizeBackup(backup),
        encrypted: true,
        contains_sensitive_fields_after_decrypt: true,
        encryption: BACKUP_ENCRYPTION_ALGORITHM,
      })}`,
    );

    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(encrypted.encryptedBackup, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="cf-monitor-encrypted-backup-${date}.json"`,
        'X-CF-Monitor-Backup-Schema': ENCRYPTED_BACKUP_SCHEMA_ID,
        'X-CF-Monitor-Backup-Scope': BACKUP_SCOPE,
        'X-CF-Monitor-Backup-Encrypted': 'true',
      },
    });
  } catch {
    return c.json({ error: '备份失败' }, 500);
  }
});

// 上传备份恢复
adminRoutes.post('/upload/backup', async (c) => {
  try {
    const contentLength = Number(c.req.header('Content-Length') || '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_BACKUP_BYTES) {
      return c.json({ error: `备份文件不能超过 ${MAX_BACKUP_BYTES} 字节` }, 413);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '备份 JSON 格式错误' }, 400);
    }

    if (!body || typeof body !== 'object') {
      return c.json({ error: '备份内容无效' }, 400);
    }

    if (jsonSizeBytes(body) > MAX_BACKUP_BYTES) {
      return c.json({ error: `备份文件不能超过 ${MAX_BACKUP_BYTES} 字节` }, 413);
    }

    const dryRun = isQueryFlagEnabled(c.req.query('dry_run'));
    const confirmation = getRestoreConfirmationState(c, body);
    if (!dryRun && !confirmation.confirmed) {
      return c.json({
        error: '恢复备份需要同时确认 confirm_restore=true 和 acknowledge_overwrite=true',
        required: {
          confirm_restore: true,
          acknowledge_overwrite: true,
        },
        received: {
          confirm_restore: confirmation.confirmRestore,
          acknowledge_overwrite: confirmation.acknowledgeOverwrite,
        },
      }, 400);
    }

    let backupInput = body;
    const wrappedBackup = (body as Record<string, unknown>).backup;
    const encryptedBackup = isEncryptedBackupEnvelope(wrappedBackup) ? wrappedBackup : body;
    if (!isEncryptedBackupEnvelope(encryptedBackup)) {
      return c.json({ error: '只支持导入加密完整备份，不支持明文备份文件' }, 400);
    }
    const backupPassword = typeof (body as Record<string, unknown>).backup_password === 'string'
      ? String((body as Record<string, unknown>).backup_password)
      : c.req.header('X-Backup-Password') || '';
    const decrypted = await decryptBackup(encryptedBackup, backupPassword);
    if (!decrypted.ok) {
      return c.json({ error: decrypted.error }, 400);
    }
    backupInput = decrypted.backup;

    const validated = validateBackup(backupInput);
    if (!validated.ok) {
      return c.json({ error: '备份校验失败', details: validated.errors }, 400);
    }

    const restored = summarizeBackup(validated.backup);
    if (dryRun) {
      return c.json({
        success: true,
        dry_run: true,
        restored,
        warnings: validated.warnings,
      });
    }

    const beforeRestore = await buildBackupSnapshot(c.env.DB);
    await db.restoreBackupData(c.env.DB, validated.backup);
    const cleanup = await db.cleanupOrphanClientData(c.env.DB);

    await db.insertAuditLog(
      c.env.DB,
      c.get('username')!,
      'backup_restore',
      `恢复备份: ${JSON.stringify({
        restored,
        previous: summarizeBackup(beforeRestore),
        cleanup,
        warnings: validated.warnings.length,
        operator_ip: getRequestIp(c),
        backup_size_bytes: jsonSizeBytes(validated.backup),
        encrypted: true,
        plaintext_backup_supported: false,
        confirmed: {
          confirm_restore: confirmation.confirmRestore,
          acknowledge_overwrite: confirmation.acknowledgeOverwrite,
        },
      })}`,
    );
    return c.json({
      success: true,
      restored,
      cleanup,
      warnings: validated.warnings,
    });
  } catch {
    return c.json({ error: '恢复失败' }, 500);
  }
});

// ============ 测试 ============

// 测试发送消息
adminRoutes.post('/test/sendMessage', async (c) => {
  try {
    const body = await c.req.json();
    const settings = await db.getAllSettings(c.env.DB);

    // TG 通知测试
    const botToken = settings['telegram_bot_token'];
    const chatId = settings['telegram_chat_id'];

    if (!botToken || !chatId) {
      await bestEffortRecordHealthEvent(
        c.env.DB,
        'telegram',
        'disabled',
        'telegram credentials are not configured',
      );
      return c.json({ error: '请先配置 Telegram Bot Token 和 Chat ID' }, 400);
    }

    const message = body.message || 'CF Monitor 测试消息';
    const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: escapeTelegramHtml(message),
        parse_mode: 'HTML',
      }),
    });

    const result = await response.json();
    if ((result as any).ok) {
      await bestEffortRecordHealthEvent(c.env.DB, 'telegram', 'ok', 'Telegram test message sent');
    } else {
      await bestEffortRecordHealthEvent(
        c.env.DB,
        'telegram',
        'error',
        `Telegram test failed: ${JSON.stringify(result).slice(0, 500)}`,
        { auditAction: 'telegram_error', auditUser: c.get('username') || 'system' },
      );
    }
    return c.json({ success: (result as any).ok, result });
  } catch (e: any) {
    await bestEffortRecordHealthEvent(
      c.env.DB,
      'telegram',
      'error',
      `Telegram test failed: ${errorDetail(e)}`,
      { auditAction: 'telegram_error', auditUser: c.get('username') || 'system' },
    );
    return c.json({ error: e.message }, 500);
  }
});

export { adminRoutes };
