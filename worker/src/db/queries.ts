/**
 * D1 数据库查询辅助函数 */

import type { Bindings } from '../index';
import type { BackupData } from '../utils/backup';

// ============ 客户端 (Clients) ============

export interface Client {
  uuid: string;
  token: string;
  name: string;
  cpu_name: string;
  virtualization: string;
  arch: string;
  cpu_cores: number;
  os: string;
  kernel_version: string;
  gpu_name: string;
  ipv4: string;
  ipv6: string;
  region: string;
  remark: string;
  public_remark: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  version: string;
  price: number;
  billing_cycle: number;
  auto_renewal: boolean;
  currency: string;
  expired_at: string;
  group: string;
  tags: string;
  hidden: boolean;
  traffic_limit: number;
  traffic_limit_type: string;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

export async function getClient(db: D1Database, uuid: string): Promise<Client | null> {
  return db.prepare('SELECT * FROM clients WHERE uuid = ?').bind(uuid).first<Client>();
}

export async function getClientByToken(db: D1Database, token: string): Promise<Client | null> {
  return db.prepare('SELECT * FROM clients WHERE token = ?').bind(token).first<Client>();
}

export async function listClients(db: D1Database): Promise<Client[]> {
  const result = await db.prepare('SELECT * FROM clients ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC').all<Client>();
  return result.results;
}

export async function createClient(db: D1Database, client: Partial<Client>): Promise<void> {
  const maxOrder = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM clients').first<{ max_order: number }>();
  const sortOrder = client.sort_order && client.sort_order > 0 ? client.sort_order : Number(maxOrder?.max_order || 0) + 1;
  await db.prepare(`INSERT INTO clients (uuid, token, name, sort_order) VALUES (?, ?, ?, ?)`)
    .bind(client.uuid, client.token, client.name || '', sortOrder).run();
}

export async function replaceAllClients(db: D1Database, clients: Partial<Client>[]): Promise<void> {
  await db.prepare('DELETE FROM clients').run();
  if (clients.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO clients (
      uuid, token, name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden, traffic_limit,
      traffic_limit_type, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = clients.map((client, index) =>
    stmt.bind(
      client.uuid || crypto.randomUUID(),
      client.token || crypto.randomUUID(),
      client.name || '',
      client.cpu_name || '',
      client.virtualization || '',
      client.arch || '',
      client.cpu_cores || 0,
      client.os || '',
      client.kernel_version || '',
      client.gpu_name || '',
      client.ipv4 || '',
      client.ipv6 || '',
      client.region || '',
      client.remark || '',
      client.public_remark || '',
      client.mem_total || 0,
      client.swap_total || 0,
      client.disk_total || 0,
      client.version || '',
      client.price || 0,
      client.billing_cycle || 0,
      client.auto_renewal ? 1 : 0,
      client.currency || '$',
      client.expired_at || null,
      client.group || '',
      client.tags || '',
      client.hidden ? 1 : 0,
      client.traffic_limit || 0,
      client.traffic_limit_type || 'max',
      client.sort_order || index + 1,
      client.created_at || new Date().toISOString(),
      client.updated_at || new Date().toISOString(),
    ),
  );

  await db.batch(batch);
}

const CLIENT_UPDATE_COLUMNS: Record<string, string> = {
  name: 'name',
  cpu_name: 'cpu_name',
  virtualization: 'virtualization',
  arch: 'arch',
  cpu_cores: 'cpu_cores',
  os: 'os',
  kernel_version: 'kernel_version',
  gpu_name: 'gpu_name',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
  region: 'region',
  remark: 'remark',
  public_remark: 'public_remark',
  mem_total: 'mem_total',
  swap_total: 'swap_total',
  disk_total: 'disk_total',
  version: 'version',
  price: 'price',
  billing_cycle: 'billing_cycle',
  auto_renewal: 'auto_renewal',
  currency: 'currency',
  expired_at: 'expired_at',
  group: '"group"',
  tags: 'tags',
  hidden: 'hidden',
  traffic_limit: 'traffic_limit',
  traffic_limit_type: 'traffic_limit_type',
  sort_order: 'sort_order',
};

function normalizeBooleanForStorage(value: unknown): number {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value === null || value === undefined) return 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return 1;
    if (normalized === 'false' || normalized === '0') return 0;
  }
  return 0;
}

function normalizeClientUpdateValue(key: string, value: unknown): unknown {
  if (key === 'auto_renewal' || key === 'hidden') {
    return normalizeBooleanForStorage(value);
  }
  return value;
}

export async function updateClient(db: D1Database, uuid: string, data: Partial<Client>): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(data)) {
    const column = CLIENT_UPDATE_COLUMNS[key];
    if (!column) continue;
    fields.push(`${column} = ?`);
    values.push(normalizeClientUpdateValue(key, value));
  }
  if (fields.length === 0) return;
  values.push(uuid);
  await db.prepare(`UPDATE clients SET ${fields.join(', ')}, updated_at = datetime('now') WHERE uuid = ?`)
    .bind(...values).run();
}

export async function rotateClientToken(db: D1Database, uuid: string, token: string): Promise<void> {
  await db.prepare('UPDATE clients SET token = ?, updated_at = datetime(\'now\') WHERE uuid = ?')
    .bind(token, uuid).run();
}

export async function deleteClient(db: D1Database, uuid: string): Promise<void> {
  await db.prepare('DELETE FROM clients WHERE uuid = ?').bind(uuid).run();
}

export async function reorderClients(db: D1Database, orderedUuids: string[]): Promise<number> {
  const uniqueUuids = [...new Set(orderedUuids.filter(uuid => typeof uuid === 'string' && uuid.trim()))];
  if (uniqueUuids.length === 0) return 0;

  const existing = await listClients(db);
  const existingUuids = new Set(existing.map(client => client.uuid));
  if (uniqueUuids.some(uuid => !existingUuids.has(uuid))) {
    throw new Error('Client uuid does not exist');
  }

  const orderedSet = new Set(uniqueUuids);
  const finalUuids = [
    ...uniqueUuids,
    ...existing
      .map(client => client.uuid)
      .filter(uuid => !orderedSet.has(uuid)),
  ];

  const stmt = db.prepare('UPDATE clients SET sort_order = ?, updated_at = datetime(\'now\') WHERE uuid = ?');
  await db.batch(finalUuids.map((uuid, index) => stmt.bind(index + 1, uuid)));
  return finalUuids.length;
}

// ============ 监控记录 (Records) ============

export interface MonitorRecord {
  id?: number;
  client: string;
  time: string;
  cpu: number;
  gpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  load: number;
  temp: number;
  disk: number;
  disk_total: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number;
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

function normalizePagination(page: number = 1, limit: number = 100, maxLimit: number = 500) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeLimit = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), maxLimit)
    : Math.min(100, maxLimit);
  return {
    page: safePage,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  };
}

function makePagedResult<T>(data: T[], total: number, page: number, limit: number): PagedResult<T> {
  return {
    data,
    total,
    page,
    limit,
    has_more: page * limit < total,
  };
}

const DELETE_BATCH_SIZE = 100;
const DELETE_BATCH_LIMIT = 200;
const FULL_DELETE_BATCH_LIMIT = 1000;

async function deleteRowsByIdBatch(
  db: D1Database,
  table: string,
  whereClause: string,
  bindings: unknown[] = [],
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchSize = Math.max(1, Math.min(options.batchSize || DELETE_BATCH_SIZE, 100));
  const maxBatches = Math.max(1, Math.min(options.maxBatches || DELETE_BATCH_LIMIT, FULL_DELETE_BATCH_LIMIT));
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const selectResult = await db.prepare(
      `SELECT id FROM ${table} ${whereClause} ORDER BY id LIMIT ?`,
    ).bind(...bindings, batchSize).all<{ id: number }>();
    const ids = selectResult.results
      .map(row => Number(row.id))
      .filter(id => Number.isInteger(id) && id > 0);
    if (ids.length === 0) break;

    const deleteResult = await db.prepare(
      `DELETE FROM ${table} WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ).bind(...ids).run();
    deleted += Number(deleteResult.meta.changes || ids.length);
    if (ids.length < batchSize) break;
  }

  return deleted;
}

export async function insertRecord(db: D1Database, record: MonitorRecord): Promise<void> {
  await db.prepare(`INSERT INTO records (client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp, disk, disk_total, net_in, net_out, net_total_up, net_total_down, process_count, connections, connections_udp, uptime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(record.client, record.time, record.cpu, record.gpu, record.ram, record.ram_total,
      record.swap, record.swap_total, record.load, record.temp, record.disk, record.disk_total,
      record.net_in, record.net_out, record.net_total_up, record.net_total_down,
      record.process_count, record.connections, record.connections_udp, record.uptime).run();
}

export async function getRecentRecords(db: D1Database, client: string, limit: number = 30): Promise<MonitorRecord[]> {
  const result = await db.prepare(
    'SELECT * FROM records WHERE client = ? ORDER BY time DESC LIMIT ?'
  ).bind(client, limit).all<MonitorRecord>();
  return result.results.reverse();
}

export async function getRecordsByTimeRange(db: D1Database, client: string, start: string, end: string): Promise<MonitorRecord[]> {
  const result = await db.prepare(
    'SELECT * FROM records WHERE client = ? AND time >= ? AND time <= ? ORDER BY time ASC'
  ).bind(client, start, end).all<MonitorRecord>();
  return result.results;
}

export async function getRecordsByTimeRangeLimited(
  db: D1Database,
  client: string,
  start: string,
  end: string,
  limit: number,
): Promise<MonitorRecord[]> {
  const safeLimit = normalizePagination(1, limit, 2000).limit;
  const result = await db.prepare(
    `SELECT * FROM (
      SELECT * FROM records
      WHERE client = ? AND time >= ? AND time <= ?
      ORDER BY time DESC
      LIMIT ?
    ) ORDER BY time ASC`
  ).bind(client, start, end, safeLimit).all<MonitorRecord>();
  return result.results;
}

export async function getRecordsByTimeRangePaged(
  db: D1Database,
  client: string,
  start: string,
  end: string,
  page: number = 1,
  limit: number = 100,
): Promise<PagedResult<MonitorRecord>> {
  const pagination = normalizePagination(page, limit, 500);
  const totalRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM records WHERE client = ? AND time >= ? AND time <= ?'
  ).bind(client, start, end).first<{ total: number }>();
  const total = Number(totalRow?.total || 0);
  const result = await db.prepare(
    `SELECT * FROM (
      SELECT * FROM records
      WHERE client = ? AND time >= ? AND time <= ?
      ORDER BY time DESC
      LIMIT ? OFFSET ?
    ) ORDER BY time ASC`
  ).bind(client, start, end, pagination.limit, pagination.offset).all<MonitorRecord>();

  return makePagedResult(result.results, total, pagination.page, pagination.limit);
}

export async function getGPURecords(db: D1Database, client: string, start?: string, end?: string, limit: number = 100): Promise<any[]> {
  const safeLimit = normalizePagination(1, limit, 1000).limit;
  if (start && end) {
    const result = await db.prepare(
      `SELECT * FROM (
        SELECT * FROM gpu_records
        WHERE client = ? AND time >= ? AND time <= ?
        ORDER BY time DESC
        LIMIT ?
      ) ORDER BY time ASC`
    ).bind(client, start, end, safeLimit).all();
    return result.results;
  }
  const result = await db.prepare(
    'SELECT * FROM gpu_records WHERE client = ? ORDER BY time DESC LIMIT ?'
  ).bind(client, safeLimit).all();
  return result.results.reverse();
}

export async function getGPURecordsPaged(
  db: D1Database,
  client: string,
  start?: string,
  end?: string,
  page: number = 1,
  limit: number = 100,
): Promise<PagedResult<any>> {
  const pagination = normalizePagination(page, limit, 500);
  if (start && end) {
    const totalRow = await db.prepare(
      'SELECT COUNT(*) AS total FROM gpu_records WHERE client = ? AND time >= ? AND time <= ?'
    ).bind(client, start, end).first<{ total: number }>();
    const total = Number(totalRow?.total || 0);
    const result = await db.prepare(
      `SELECT * FROM (
        SELECT * FROM gpu_records
        WHERE client = ? AND time >= ? AND time <= ?
        ORDER BY time DESC
        LIMIT ? OFFSET ?
      ) ORDER BY time ASC`
    ).bind(client, start, end, pagination.limit, pagination.offset).all();
    return makePagedResult(result.results, total, pagination.page, pagination.limit);
  }

  const totalRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM gpu_records WHERE client = ?'
  ).bind(client).first<{ total: number }>();
  const total = Number(totalRow?.total || 0);
  const result = await db.prepare(
    `SELECT * FROM (
      SELECT * FROM gpu_records
      WHERE client = ?
      ORDER BY time DESC
      LIMIT ? OFFSET ?
    ) ORDER BY time ASC`
  ).bind(client, pagination.limit, pagination.offset).all();

  return makePagedResult(result.results, total, pagination.page, pagination.limit);
}

export type DeleteOldRowsOptions = {
  maxBatches?: number;
};

export async function deleteOldRecords(db: D1Database, beforeTime: string, options: DeleteOldRowsOptions = {}): Promise<{ records: number; gpu_records: number }> {
  return {
    records: await deleteRowsByIdBatch(db, 'records', 'WHERE time < ?', [beforeTime], options),
    gpu_records: await deleteRowsByIdBatch(db, 'gpu_records', 'WHERE time < ?', [beforeTime], options),
  };
}

export async function deleteOldPingRecords(db: D1Database, beforeTime: string, options: DeleteOldRowsOptions = {}): Promise<{ ping_records: number }> {
  return {
    ping_records: await deleteRowsByIdBatch(db, 'ping_records', 'WHERE time < ?', [beforeTime], options),
  };
}

export async function getLatestRecordTimes(db: D1Database): Promise<Array<{ client: string; last_time: string }>> {
  const result = await db.prepare(
    'SELECT client, MAX(time) as last_time FROM records GROUP BY client'
  ).all<{ client: string; last_time: string }>();
  return result.results;
}

export async function getLatestRecords(db: D1Database): Promise<MonitorRecord[]> {
  const result = await db.prepare(`
    SELECT r.*
    FROM records r
    INNER JOIN (
      SELECT client, MAX(time) AS time
      FROM records
      GROUP BY client
    ) latest
      ON r.client = latest.client AND r.time = latest.time
    ORDER BY r.time DESC
  `).all<MonitorRecord>();
  return result.results;
}

export async function clearAllRecords(db: D1Database): Promise<{ records: number; gpu_records: number; ping_records: number }> {
  return {
    records: await deleteRowsByIdBatch(db, 'records', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    gpu_records: await deleteRowsByIdBatch(db, 'gpu_records', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    ping_records: await deleteRowsByIdBatch(db, 'ping_records', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
  };
}

export async function clearClientRecords(db: D1Database, client: string): Promise<void> {
  await db.prepare('DELETE FROM records WHERE client = ?').bind(client).run();
  await db.prepare('DELETE FROM gpu_records WHERE client = ?').bind(client).run();
  await db.prepare('DELETE FROM ping_records WHERE client = ?').bind(client).run();
}

// ============ GPU 记录 ============

export interface GPUInfo {
  device_index: number;
  device_name: string;
  mem_total: number;
  mem_used: number;
  utilization: number;
  temperature: number;
}

export async function insertGPURecords(db: D1Database, client: string, time: string, gpus: GPUInfo[]): Promise<void> {
  const stmt = db.prepare(
    'INSERT INTO gpu_records (client, time, device_index, device_name, mem_total, mem_used, utilization, temperature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const batch: D1PreparedStatement[] = [];
  for (const gpu of gpus) {
    batch.push(stmt.bind(client, time, gpu.device_index, gpu.device_name, gpu.mem_total, gpu.mem_used, gpu.utilization, gpu.temperature));
  }
  await db.batch(batch);
}

// ============ 用户 ============

export interface User {
  uuid: string;
  username: string;
  passwd: string;
  created_at: string;
  updated_at: string;
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function createUser(
  db: D1Database,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO users (uuid, username, passwd) VALUES (?, ?, ?)')
    .bind(user.uuid, user.username, user.hashedPassword)
    .run();
  return result.meta.changes > 0;
}

export async function deleteUserIfMatches(
  db: D1Database,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<boolean> {
  const result = await db.prepare('DELETE FROM users WHERE uuid = ? AND username = ? AND passwd = ?')
    .bind(user.uuid, user.username, user.hashedPassword)
    .run();
  return result.meta.changes > 0;
}

export async function getUserByUsername(db: D1Database, username: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<User>();
}

export async function updateUserPassword(db: D1Database, uuid: string, hashedPassword: string): Promise<void> {
  await db.prepare("UPDATE users SET passwd = ?, updated_at = datetime('now') WHERE uuid = ?")
    .bind(hashedPassword, uuid).run();
}

// ============ 登录限速 ============

export interface LoginRateLimit {
  bucket: string;
  failures: number;
  first_failed_at: string;
  last_failed_at: string;
  locked_until: string | null;
}

export async function getLoginRateLimit(db: D1Database, bucket: string): Promise<LoginRateLimit | null> {
  return db.prepare('SELECT * FROM login_rate_limits WHERE bucket = ?')
    .bind(bucket)
    .first<LoginRateLimit>();
}

export async function setLoginRateLimit(db: D1Database, state: LoginRateLimit): Promise<void> {
  await db.prepare(`
    INSERT INTO login_rate_limits (bucket, failures, first_failed_at, last_failed_at, locked_until)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      failures = excluded.failures,
      first_failed_at = excluded.first_failed_at,
      last_failed_at = excluded.last_failed_at,
      locked_until = excluded.locked_until
  `).bind(
    state.bucket,
    state.failures,
    state.first_failed_at,
    state.last_failed_at,
    state.locked_until,
  ).run();
}

export async function clearLoginRateLimit(db: D1Database, bucket: string): Promise<void> {
  await db.prepare('DELETE FROM login_rate_limits WHERE bucket = ?').bind(bucket).run();
}

export async function deleteLoginRateLimitsBefore(db: D1Database, beforeTime: string): Promise<void> {
  await db.prepare(`
    DELETE FROM login_rate_limits
    WHERE last_failed_at < ?
      AND (locked_until IS NULL OR locked_until < ?)
  `).bind(beforeTime, beforeTime).run();
}

// ============ 系统设置 ============

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
}

export async function replaceAllSettings(db: D1Database, settings: Record<string, string>): Promise<void> {
  await db.prepare('DELETE FROM settings').run();
  const entries = Object.entries(settings);
  if (entries.length === 0) return;

  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  await db.batch(entries.map(([key, value]) => stmt.bind(key, value)));
}

export async function getAllSettings(db: D1Database): Promise<Record<string, string>> {
  const result = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const row of result.results) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ============ Ping 任务 ============

export interface PingTask {
  id?: number;
  name: string;
  clients: string[];
  all_clients: boolean;
  type: string;
  target: string;
  interval_sec: number;
  sort_order?: number;
}

function normalizePingTask(row: any): PingTask {
  return {
    ...row,
    clients: JSON.parse(row.clients || '[]'),
    all_clients: !!row.all_clients,
    sort_order: Number(row.sort_order ?? row.id ?? 0),
  };
}

export async function getPingTask(db: D1Database, id: number): Promise<PingTask | null> {
  const row = await db.prepare('SELECT * FROM ping_tasks WHERE id = ?').bind(id).first<any>();
  if (!row) return null;
  return normalizePingTask(row);
}

export async function listPingTasks(db: D1Database): Promise<PingTask[]> {
  const result = await db.prepare('SELECT * FROM ping_tasks ORDER BY sort_order ASC, id ASC').all<any>();
  return result.results.map(normalizePingTask);
}

export async function createPingTask(db: D1Database, task: PingTask): Promise<void> {
  const maxOrder = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM ping_tasks').first<{ max_order: number }>();
  const sortOrder = task.sort_order && task.sort_order > 0 ? task.sort_order : Number(maxOrder?.max_order || 0) + 1;
  await db.prepare('INSERT INTO ping_tasks (name, clients, all_clients, type, target, interval_sec, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(task.name, JSON.stringify(task.clients), task.all_clients ? 1 : 0, task.type, task.target, task.interval_sec, sortOrder).run();
}

export async function replaceAllPingTasks(db: D1Database, tasks: PingTask[]): Promise<void> {
  await db.prepare('DELETE FROM ping_tasks').run();
  if (tasks.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await db.batch(tasks.map((task) =>
    stmt.bind(
      task.id || null,
      task.name || '',
      JSON.stringify(task.clients || []),
      task.all_clients ? 1 : 0,
      task.type || 'icmp',
      task.target || '',
      task.interval_sec || 60,
      task.sort_order || task.id || 0,
    ),
  ));
}

const PING_TASK_UPDATE_COLUMNS: Record<string, string> = {
  name: 'name',
  clients: 'clients',
  all_clients: 'all_clients',
  type: 'type',
  target: 'target',
  interval_sec: 'interval_sec',
  sort_order: 'sort_order',
};

export async function updatePingTask(db: D1Database, id: number, task: Partial<PingTask>): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(task)) {
    if (key === 'id') continue;
    const column = PING_TASK_UPDATE_COLUMNS[key];
    if (!column) continue;
    if (key === 'clients') {
      fields.push('clients = ?');
      values.push(JSON.stringify(value));
    } else if (key === 'all_clients') {
      fields.push('all_clients = ?');
      values.push(value ? 1 : 0);
    } else {
      fields.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  await db.prepare(`UPDATE ping_tasks SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function reorderPingTasks(db: D1Database, orderedIds: number[]): Promise<number> {
  const uniqueIds = [...new Set(orderedIds.filter(id => Number.isInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return 0;

  const existing = await listPingTasks(db);
  const existingIds = new Set(existing.map(task => task.id).filter((id): id is number => typeof id === 'number' && Number.isInteger(id)));
  if (uniqueIds.some(id => !existingIds.has(id))) {
    throw new Error('Ping task id does not exist');
  }

  const orderedSet = new Set(uniqueIds);
  const finalIds = [
    ...uniqueIds,
    ...existing
      .map(task => task.id)
      .filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && !orderedSet.has(id)),
  ];

  const stmt = db.prepare('UPDATE ping_tasks SET sort_order = ? WHERE id = ?');
  await db.batch(finalIds.map((id, index) => stmt.bind(index + 1, id)));
  return finalIds.length;
}

export async function deletePingTask(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM ping_tasks WHERE id = ?').bind(id).run();
  await db.prepare('DELETE FROM ping_records WHERE task_id = ?').bind(id).run();
}

// ============ Ping 记录 ============

export async function insertPingRecord(db: D1Database, client: string, taskId: number, time: string, value: number): Promise<void> {
  await db.prepare('INSERT INTO ping_records (client, task_id, time, value) VALUES (?, ?, ?, ?)')
    .bind(client, taskId, time, value).run();
}

export async function getPingRecords(db: D1Database, client: string, taskId: number, limit: number = 120): Promise<any[]> {
  const safeLimit = normalizePagination(1, limit, 1000).limit;
  const result = await db.prepare(
    'SELECT * FROM ping_records WHERE client = ? AND task_id = ? ORDER BY time DESC LIMIT ?'
  ).bind(client, taskId, safeLimit).all();
  return result.results.reverse();
}

export async function getPingRecordsPaged(
  db: D1Database,
  client: string,
  taskId: number,
  page: number = 1,
  limit: number = 120,
): Promise<PagedResult<any>> {
  const pagination = normalizePagination(page, limit, 500);
  const totalRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM ping_records WHERE client = ? AND task_id = ?'
  ).bind(client, taskId).first<{ total: number }>();
  const total = Number(totalRow?.total || 0);
  const result = await db.prepare(
    `SELECT * FROM (
      SELECT * FROM ping_records
      WHERE client = ? AND task_id = ?
      ORDER BY time DESC
      LIMIT ? OFFSET ?
    ) ORDER BY time ASC`
  ).bind(client, taskId, pagination.limit, pagination.offset).all();

  return makePagedResult(result.results, total, pagination.page, pagination.limit);
}

// ============ 通知设置 ============

export async function getOfflineNotification(db: D1Database, client: string): Promise<any> {
  return db.prepare('SELECT * FROM offline_notifications WHERE client = ?').bind(client).first();
}

export async function listOfflineNotifications(db: D1Database): Promise<any[]> {
  const result = await db.prepare('SELECT * FROM offline_notifications').all();
  return result.results;
}

export async function replaceAllOfflineNotifications(db: D1Database, notifications: any[]): Promise<void> {
  await db.prepare('DELETE FROM offline_notifications').run();
  if (notifications.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO offline_notifications (client, enable, grace_period, last_notified)
    VALUES (?, ?, ?, ?)
  `);

  await db.batch(
    notifications.map((item) =>
      stmt.bind(
        item.client,
        item.enable ? 1 : 0,
        item.grace_period || 180,
        item.last_notified || null,
      ),
    ),
  );
}

export async function setOfflineNotification(db: D1Database, client: string, enable: boolean, gracePeriod: number): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO offline_notifications (client, enable, grace_period) VALUES (?, ?, ?)')
    .bind(client, enable ? 1 : 0, gracePeriod).run();
}

export async function markOfflineNotificationSent(db: D1Database, client: string, time: string): Promise<void> {
  await db.prepare('UPDATE offline_notifications SET last_notified = ? WHERE client = ?')
    .bind(time, client).run();
}

export async function getExpiryNotification(db: D1Database, client: string): Promise<any> {
  return db.prepare('SELECT * FROM expiry_notifications WHERE client = ?').bind(client).first();
}

export async function listExpiryNotifications(db: D1Database): Promise<any[]> {
  const result = await db.prepare('SELECT * FROM expiry_notifications').all();
  return result.results;
}

export async function replaceAllExpiryNotifications(db: D1Database, notifications: any[]): Promise<void> {
  await db.prepare('DELETE FROM expiry_notifications').run();
  if (notifications.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO expiry_notifications (client, enable, advance_days, last_notified)
    VALUES (?, ?, ?, ?)
  `);

  await db.batch(
    notifications.map((item) =>
      stmt.bind(
        item.client,
        item.enable ? 1 : 0,
        item.advance_days || 7,
        item.last_notified || null,
      ),
    ),
  );
}

export async function setExpiryNotification(db: D1Database, client: string, enable: boolean, advanceDays: number): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO expiry_notifications (client, enable, advance_days) VALUES (?, ?, ?)')
    .bind(client, enable ? 1 : 0, advanceDays).run();
}

export async function markExpiryNotificationSent(db: D1Database, client: string, time: string): Promise<void> {
  await db.prepare('UPDATE expiry_notifications SET last_notified = ? WHERE client = ?')
    .bind(time, client).run();
}

export async function listLoadNotifications(db: D1Database): Promise<any[]> {
  const result = await db.prepare('SELECT * FROM load_notifications').all<any>();
  return result.results.map(row => ({ ...row, clients: JSON.parse(row.clients || '[]') }));
}

export async function getLoadNotification(db: D1Database, id: number): Promise<any | null> {
  const row = await db.prepare('SELECT * FROM load_notifications WHERE id = ?').bind(id).first<any>();
  return row ? { ...row, clients: JSON.parse(row.clients || '[]') } : null;
}

const LOAD_NOTIFICATION_METRICS = new Set(['cpu', 'ram', 'load', 'disk', 'temp']);
const LOAD_NOTIFICATION_UPDATE_COLUMNS: Record<string, string> = {
  name: 'name',
  clients: 'clients',
  metric: 'metric',
  threshold: 'threshold',
  ratio: 'ratio',
  interval_min: 'interval_min',
  last_notified: 'last_notified',
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.floor(clampNumber(value, fallback, min, max));
}

function normalizeLoadNotificationClients(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  const clients = value
    .filter((client): client is string => typeof client === 'string')
    .map(client => client.trim())
    .filter(Boolean)
    .slice(0, 200);
  return JSON.stringify(clients);
}

function normalizeLoadNotificationMetric(value: unknown, fallback = 'cpu'): string {
  return typeof value === 'string' && LOAD_NOTIFICATION_METRICS.has(value) ? value : fallback;
}

function normalizeLoadNotificationValue(key: string, value: unknown): unknown {
  switch (key) {
    case 'name':
      return typeof value === 'string' ? value.slice(0, 128) : '';
    case 'clients':
      return normalizeLoadNotificationClients(value);
    case 'metric':
      return normalizeLoadNotificationMetric(value);
    case 'threshold':
      return clampNumber(value, 80, 0, 100000);
    case 'ratio':
      return clampNumber(value, 0.8, 0, 1);
    case 'interval_min':
      return clampInteger(value, 15, 1, 10080);
    case 'last_notified':
      return typeof value === 'string' && value.length <= 64 ? value : null;
    default:
      return undefined;
  }
}

export async function createLoadNotification(db: D1Database, data: any): Promise<void> {
  await db.prepare('INSERT INTO load_notifications (name, clients, metric, threshold, ratio, interval_min) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(
      normalizeLoadNotificationValue('name', data.name),
      normalizeLoadNotificationValue('clients', data.clients),
      normalizeLoadNotificationValue('metric', data.metric),
      normalizeLoadNotificationValue('threshold', data.threshold),
      normalizeLoadNotificationValue('ratio', data.ratio),
      normalizeLoadNotificationValue('interval_min', data.interval_min),
    ).run();
}

export async function replaceAllLoadNotifications(db: D1Database, notifications: any[]): Promise<void> {
  await db.prepare('DELETE FROM load_notifications').run();
  if (notifications.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO load_notifications (
      id, name, clients, metric, threshold, ratio, interval_min, last_notified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await db.batch(
    notifications.map((item) =>
      stmt.bind(
        item.id || null,
        normalizeLoadNotificationValue('name', item.name),
        normalizeLoadNotificationValue('clients', item.clients),
        normalizeLoadNotificationValue('metric', item.metric),
        normalizeLoadNotificationValue('threshold', item.threshold),
        normalizeLoadNotificationValue('ratio', item.ratio),
        normalizeLoadNotificationValue('interval_min', item.interval_min),
        normalizeLoadNotificationValue('last_notified', item.last_notified),
      ),
    ),
  );
}

export async function updateLoadNotification(db: D1Database, id: number, data: any): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id') continue;
    const column = LOAD_NOTIFICATION_UPDATE_COLUMNS[key];
    if (!column) continue;

    const normalizedValue = normalizeLoadNotificationValue(key, value);
    if (normalizedValue === undefined) continue;

    fields.push(`${column} = ?`);
    values.push(normalizedValue);
  }
  if (fields.length === 0) return;
  values.push(id);
  await db.prepare(`UPDATE load_notifications SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteLoadNotification(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM load_notifications WHERE id = ?').bind(id).run();
}

export interface ClientReferenceCleanupResult {
  ping_tasks_updated: number;
  load_notifications_updated: number;
  load_notifications_deleted: number;
  expiry_notifications_deleted: number;
}

export async function pruneClientReferences(db: D1Database, uuid: string): Promise<ClientReferenceCleanupResult> {
  let pingTasksUpdated = 0;
  let loadNotificationsUpdated = 0;
  let loadNotificationsDeleted = 0;

  const pingTasks = await listPingTasks(db);
  for (const task of pingTasks) {
    if (!task.id || task.all_clients || !task.clients.includes(uuid)) continue;
    const clients = task.clients.filter(client => client !== uuid);
    await updatePingTask(db, task.id, { clients });
    pingTasksUpdated += 1;
  }

  const loadNotifications = await listLoadNotifications(db);
  for (const notification of loadNotifications) {
    if (!notification.id || !Array.isArray(notification.clients) || !notification.clients.includes(uuid)) continue;
    const clients = notification.clients.filter((client: string) => client !== uuid);
    if (clients.length === 0) {
      await deleteLoadNotification(db, notification.id);
      loadNotificationsDeleted += 1;
    } else {
      await updateLoadNotification(db, notification.id, { clients });
      loadNotificationsUpdated += 1;
    }
  }

  const expiryNotifications = await db.prepare('DELETE FROM expiry_notifications WHERE client = ?').bind(uuid).run();

  return {
    ping_tasks_updated: pingTasksUpdated,
    load_notifications_updated: loadNotificationsUpdated,
    load_notifications_deleted: loadNotificationsDeleted,
    expiry_notifications_deleted: Number(expiryNotifications.meta.changes || 0),
  };
}

export interface OrphanClientDataCleanupResult extends ClientReferenceCleanupResult {
  offline_notifications_deleted: number;
  records_deleted: number;
  gpu_records_deleted: number;
  ping_records_deleted: number;
}

export async function cleanupOrphanClientData(db: D1Database): Promise<OrphanClientDataCleanupResult> {
  const clients = await listClients(db);
  const allowedClientIds = new Set(clients.map(client => client.uuid));
  let pingTasksUpdated = 0;
  let loadNotificationsUpdated = 0;
  let loadNotificationsDeleted = 0;

  const pingTasks = await listPingTasks(db);
  for (const task of pingTasks) {
    if (!task.id || task.all_clients) continue;
    const filtered = task.clients.filter(client => allowedClientIds.has(client));
    if (filtered.length === task.clients.length) continue;
    await updatePingTask(db, task.id, { clients: filtered });
    pingTasksUpdated += 1;
  }

  const loadNotifications = await listLoadNotifications(db);
  for (const notification of loadNotifications) {
    if (!notification.id || !Array.isArray(notification.clients) || notification.clients.length === 0) continue;
    const filtered = notification.clients.filter((client: string) => allowedClientIds.has(client));
    if (filtered.length === notification.clients.length) continue;
    if (filtered.length === 0) {
      await deleteLoadNotification(db, notification.id);
      loadNotificationsDeleted += 1;
    } else {
      await updateLoadNotification(db, notification.id, { clients: filtered });
      loadNotificationsUpdated += 1;
    }
  }

  const offlineNotifications = await db.prepare(
    'DELETE FROM offline_notifications WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();
  const expiryNotifications = await db.prepare(
    'DELETE FROM expiry_notifications WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();
  const records = await db.prepare(
    'DELETE FROM records WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();
  const gpuRecords = await db.prepare(
    'DELETE FROM gpu_records WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();
  const pingRecords = await db.prepare(
    'DELETE FROM ping_records WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();

  return {
    ping_tasks_updated: pingTasksUpdated,
    load_notifications_updated: loadNotificationsUpdated,
    load_notifications_deleted: loadNotificationsDeleted,
    expiry_notifications_deleted: Number(expiryNotifications.meta.changes || 0),
    offline_notifications_deleted: Number(offlineNotifications.meta.changes || 0),
    records_deleted: Number(records.meta.changes || 0),
    gpu_records_deleted: Number(gpuRecords.meta.changes || 0),
    ping_records_deleted: Number(pingRecords.meta.changes || 0),
  };
}

// ============ 备份恢复 ============

export async function restoreBackupData(db: D1Database, backup: BackupData): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  if (backup.settings !== undefined) {
    statements.push(db.prepare('DELETE FROM settings'));
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(backup.settings)) {
      statements.push(stmt.bind(key, value));
    }
  }

  if (backup.clients !== undefined) {
    statements.push(db.prepare('DELETE FROM clients'));
    const stmt = db.prepare(`
      INSERT INTO clients (
        uuid, token, name, cpu_name, virtualization, arch, cpu_cores, os,
        kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
        mem_total, swap_total, disk_total, version, price, billing_cycle,
        auto_renewal, currency, expired_at, "group", tags, hidden, traffic_limit,
        traffic_limit_type, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, client] of backup.clients.entries()) {
      statements.push(stmt.bind(
        client.uuid || crypto.randomUUID(),
        client.token || crypto.randomUUID(),
        client.name || '',
        client.cpu_name || '',
        client.virtualization || '',
        client.arch || '',
        client.cpu_cores || 0,
        client.os || '',
        client.kernel_version || '',
        client.gpu_name || '',
        client.ipv4 || '',
        client.ipv6 || '',
        client.region || '',
        client.remark || '',
        client.public_remark || '',
        client.mem_total || 0,
        client.swap_total || 0,
        client.disk_total || 0,
        client.version || '',
        client.price || 0,
        client.billing_cycle || 0,
        client.auto_renewal ? 1 : 0,
        client.currency || '$',
        client.expired_at || null,
        client.group || '',
        client.tags || '',
        client.hidden ? 1 : 0,
        client.traffic_limit || 0,
        client.traffic_limit_type || 'max',
        client.sort_order || index + 1,
        client.created_at || new Date().toISOString(),
        client.updated_at || new Date().toISOString(),
      ));
    }
  }

  if (backup.ping_tasks !== undefined) {
    statements.push(db.prepare('DELETE FROM ping_tasks'));
    const stmt = db.prepare(`
      INSERT INTO ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const task of backup.ping_tasks) {
      statements.push(stmt.bind(
        task.id || null,
        task.name || '',
        JSON.stringify(task.clients || []),
        task.all_clients ? 1 : 0,
        task.type || 'icmp',
        task.target || '',
        task.interval_sec || 60,
        task.sort_order || task.id || 0,
      ));
    }
  }

  if (backup.offline_notifications !== undefined) {
    statements.push(db.prepare('DELETE FROM offline_notifications'));
    const stmt = db.prepare(`
      INSERT INTO offline_notifications (client, enable, grace_period, last_notified)
      VALUES (?, ?, ?, ?)
    `);
    for (const item of backup.offline_notifications) {
      statements.push(stmt.bind(
        item.client,
        item.enable ? 1 : 0,
        item.grace_period || 180,
        item.last_notified || null,
      ));
    }
  }

  if (backup.expiry_notifications !== undefined) {
    statements.push(db.prepare('DELETE FROM expiry_notifications'));
    const stmt = db.prepare(`
      INSERT INTO expiry_notifications (client, enable, advance_days, last_notified)
      VALUES (?, ?, ?, ?)
    `);
    for (const item of backup.expiry_notifications) {
      statements.push(stmt.bind(
        item.client,
        item.enable ? 1 : 0,
        item.advance_days || 7,
        item.last_notified || null,
      ));
    }
  }

  if (backup.load_notifications !== undefined) {
    statements.push(db.prepare('DELETE FROM load_notifications'));
    const stmt = db.prepare(`
      INSERT INTO load_notifications (
        id, name, clients, metric, threshold, ratio, interval_min, last_notified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of backup.load_notifications) {
      statements.push(stmt.bind(
        item.id || null,
        normalizeLoadNotificationValue('name', item.name),
        normalizeLoadNotificationValue('clients', item.clients),
        normalizeLoadNotificationValue('metric', item.metric),
        normalizeLoadNotificationValue('threshold', item.threshold),
        normalizeLoadNotificationValue('ratio', item.ratio),
        normalizeLoadNotificationValue('interval_min', item.interval_min),
        normalizeLoadNotificationValue('last_notified', item.last_notified),
      ));
    }
  }

  if (statements.length === 0) return;
  await db.batch(statements);
}

// ============ 审计日志 ============

export async function insertAuditLog(db: D1Database, user: string, action: string, detail: string, level: string = 'info'): Promise<void> {
  await db.prepare('INSERT INTO audit_logs (user, action, detail, level) VALUES (?, ?, ?, ?)')
    .bind(user, action, detail, level).run();
}

export async function listAuditLogs(db: D1Database, limit: number = 100): Promise<any[]> {
  const result = await db.prepare('SELECT * FROM audit_logs ORDER BY time DESC LIMIT ?').bind(limit).all();
  return result.results;
}

export async function listAuditLogsPaged(
  db: D1Database,
  page: number = 1,
  limit: number = 50,
): Promise<{ logs: any[]; total: number }> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const safePage = Math.max(1, page);
  const offset = (safePage - 1) * safeLimit;

  const totalRow = await db
    .prepare('SELECT COUNT(*) as total FROM audit_logs')
    .first<{ total: number }>();
  const total = Number(totalRow?.total || 0);

  const result = await db
    .prepare('SELECT * FROM audit_logs ORDER BY time DESC LIMIT ? OFFSET ?')
    .bind(safeLimit, offset)
    .all();

  return {
    logs: result.results,
    total,
  };
}

export async function deleteOldAuditLogs(db: D1Database, beforeTime: string, options: DeleteOldRowsOptions = {}): Promise<{ audit_logs: number }> {
  return {
    audit_logs: await deleteRowsByIdBatch(db, 'audit_logs', 'WHERE time < ?', [beforeTime], options),
  };
}

export interface TableRowCounts {
  records: number;
  gpu_records: number;
  ping_records: number;
  audit_logs: number;
}

async function countTableRows(db: D1Database, table: keyof TableRowCounts): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count || 0);
}

export async function getStorageRowCounts(db: D1Database): Promise<TableRowCounts> {
  const [records, gpuRecords, pingRecords, auditLogs] = await Promise.all([
    countTableRows(db, 'records'),
    countTableRows(db, 'gpu_records'),
    countTableRows(db, 'ping_records'),
    countTableRows(db, 'audit_logs'),
  ]);
  return {
    records,
    gpu_records: gpuRecords,
    ping_records: pingRecords,
    audit_logs: auditLogs,
  };
}

async function countExpiredRows(db: D1Database, table: keyof TableRowCounts, beforeTime: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE time < ?`).bind(beforeTime).first<{ count: number }>();
  return Number(row?.count || 0);
}

export async function getExpiredRowCounts(
  db: D1Database,
  beforeTimes: { records: string; ping_records: string; audit_logs: string },
): Promise<TableRowCounts> {
  const [records, gpuRecords, pingRecords, auditLogs] = await Promise.all([
    countExpiredRows(db, 'records', beforeTimes.records),
    countExpiredRows(db, 'gpu_records', beforeTimes.records),
    countExpiredRows(db, 'ping_records', beforeTimes.ping_records),
    countExpiredRows(db, 'audit_logs', beforeTimes.audit_logs),
  ]);
  return {
    records,
    gpu_records: gpuRecords,
    ping_records: pingRecords,
    audit_logs: auditLogs,
  };
}
