/**
 * D1 数据库查询辅助函数 */

import type { BackupData } from '../utils/backup';
import {
  hashAgentToken,
  isTokenHash,
  prepareAgentTokenForStorage,
  readStoredTokenHash,
  storedTokenHash,
  tokenPrefix,
} from '../utils/agent-token';

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
  token_hash: string | null;
  token_prefix: string | null;
  last_seen_at: string | null;
  last_report_source: string;
  last_report_persisted_at: string | null;
  last_report_interval_sec: number | null;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

export type PublicClientRow = Omit<Client, 'token' | 'token_hash' | 'token_prefix' | 'remark' | 'last_seen_at' | 'last_report_source' | 'last_report_persisted_at' | 'last_report_interval_sec'> & {
  ipv4: string;
  ipv6: string;
};

export type ScheduledClientRow = Pick<Client, 'uuid' | 'name' | 'created_at' | 'expired_at' | 'last_seen_at' | 'last_report_interval_sec'>;
export type ClientTokenMeta = Pick<Client, 'uuid' | 'token' | 'token_hash' | 'token_prefix' | 'name'>;
export type ClientIdentity = Pick<Client, 'uuid' | 'token' | 'token_hash' | 'token_prefix' | 'name' | 'hidden'>;

export interface ClientVisibility {
  uuid: string;
  hidden: boolean;
}

export async function getClient(db: D1Database, uuid: string): Promise<Client | null> {
  return db.prepare('SELECT * FROM clients WHERE uuid = ?').bind(uuid).first<Client>();
}

export async function clientExists(db: D1Database, uuid: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS found FROM clients WHERE uuid = ? LIMIT 1').bind(uuid).first<{ found: number }>();
  return Boolean(row);
}

export async function getClientTokenMeta(db: D1Database, uuid: string): Promise<ClientTokenMeta | null> {
  return db.prepare('SELECT uuid, token, token_hash, token_prefix, name FROM clients WHERE uuid = ?').bind(uuid).first<ClientTokenMeta>();
}

function normalizeUuidList(uuids: string[]): string[] {
  return [...new Set(
    uuids
      .filter((uuid): uuid is string => typeof uuid === 'string')
      .map(uuid => uuid.trim())
      .filter(Boolean),
  )];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export async function getClientsByIds(db: D1Database, uuids: string[]): Promise<Client[]> {
  const uniqueUuids = normalizeUuidList(uuids);
  if (uniqueUuids.length === 0) return [];

  const clients: Client[] = [];
  for (let index = 0; index < uniqueUuids.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueUuids.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const result = await db.prepare(
      `SELECT * FROM clients WHERE uuid IN (${placeholders(chunk.length)})`,
    ).bind(...chunk).all<Client>();
    clients.push(...result.results);
  }
  return clients;
}

export async function getClientByToken(db: D1Database, token: string): Promise<Client | null> {
  const tokenHash = await hashAgentToken(token);
  const client = await db.prepare(`
    SELECT * FROM clients
    WHERE token_hash = ?
       OR ((token_hash IS NULL OR token_hash = '') AND token = ?)
  `)
    .bind(tokenHash, token)
    .first<Client>();
  if (client && (!client.token_hash || client.token !== storedTokenHash(tokenHash))) {
    await storeClientTokenHash(db, client.uuid, token, tokenHash);
    return {
      ...client,
      token: storedTokenHash(tokenHash),
      token_hash: tokenHash,
      token_prefix: tokenPrefix(token),
    };
  }
  return client;
}

export async function getClientIdentityByToken(db: D1Database, token: string): Promise<ClientIdentity | null> {
  const tokenHash = await hashAgentToken(token);
  const client = await db.prepare(`
    SELECT uuid, token, token_hash, token_prefix, name, hidden FROM clients
    WHERE token_hash = ?
       OR ((token_hash IS NULL OR token_hash = '') AND token = ?)
  `)
    .bind(tokenHash, token)
    .first<ClientIdentity>();
  if (client && (!client.token_hash || client.token !== storedTokenHash(tokenHash))) {
    await storeClientTokenHash(db, client.uuid, token, tokenHash);
    return {
      ...client,
      token: storedTokenHash(tokenHash),
      token_hash: tokenHash,
      token_prefix: tokenPrefix(token),
    };
  }
  return client;
}

export async function clientTokenExists(db: D1Database, token: string): Promise<boolean> {
  const tokenHash = await hashAgentToken(token);
  const row = await db.prepare(`
    SELECT 1 AS found FROM clients
    WHERE token_hash = ?
       OR ((token_hash IS NULL OR token_hash = '') AND token = ?)
    LIMIT 1
  `)
    .bind(tokenHash, token)
    .first<{ found: number }>();
  return Boolean(row);
}

export async function listClients(db: D1Database): Promise<Client[]> {
  const result = await db.prepare('SELECT * FROM clients ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC').all<Client>();
  return result.results;
}

export interface ClientCapacityCounts {
  clients: number;
  gpu_clients: number;
}

export async function countClientCapacityTargets(db: D1Database): Promise<ClientCapacityCounts> {
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS clients,
      COALESCE(SUM(CASE WHEN TRIM(COALESCE(gpu_name, '')) != '' THEN 1 ELSE 0 END), 0) AS gpu_clients
    FROM clients
  `).first<ClientCapacityCounts>();
  return {
    clients: Number(row?.clients || 0),
    gpu_clients: Number(row?.gpu_clients || 0),
  };
}

export async function listPublicClientRows(db: D1Database): Promise<PublicClientRow[]> {
  const result = await db.prepare(`
    SELECT
      uuid, name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden,
      traffic_limit, traffic_limit_type, sort_order, created_at, updated_at
    FROM clients
    ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC
  `).all<PublicClientRow>();
  return result.results;
}

export async function getClientVisibility(db: D1Database, uuid: string): Promise<ClientVisibility | null> {
  return db.prepare('SELECT uuid, hidden FROM clients WHERE uuid = ?').bind(uuid).first<ClientVisibility>();
}

export async function listScheduledClientRows(db: D1Database): Promise<ScheduledClientRow[]> {
  const result = await db.prepare(
    'SELECT uuid, name, created_at, expired_at, last_seen_at, last_report_interval_sec FROM clients ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC',
  ).all<ScheduledClientRow>();
  return result.results;
}

export async function getScheduledClientRowsByIds(db: D1Database, uuids: string[]): Promise<ScheduledClientRow[]> {
  const uniqueUuids = normalizeUuidList(uuids);
  if (uniqueUuids.length === 0) return [];

  const clients: ScheduledClientRow[] = [];
  for (let index = 0; index < uniqueUuids.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueUuids.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const result = await db.prepare(
      `SELECT uuid, name, created_at, expired_at, last_seen_at, last_report_interval_sec FROM clients WHERE uuid IN (${placeholders(chunk.length)})`,
    ).bind(...chunk).all<ScheduledClientRow>();
    clients.push(...result.results);
  }
  return clients;
}

export async function listClientIds(db: D1Database): Promise<string[]> {
  const result = await db.prepare('SELECT uuid FROM clients').all<{ uuid: string }>();
  return result.results.map(row => row.uuid);
}

async function storeClientTokenHash(db: D1Database, uuid: string, rawToken: string, knownHash?: string): Promise<{
  storedToken: string;
  tokenHash: string;
  tokenPrefix: string;
}> {
  const tokenHash = knownHash || await hashAgentToken(rawToken);
  const prepared = {
    storedToken: storedTokenHash(tokenHash),
    tokenHash,
    tokenPrefix: tokenPrefix(rawToken),
  };
  await db.prepare(`
    UPDATE clients
    SET token = ?,
        token_hash = ?,
        token_prefix = ?,
        updated_at = datetime('now')
    WHERE uuid = ?
  `).bind(prepared.storedToken, prepared.tokenHash, prepared.tokenPrefix, uuid).run();
  return prepared;
}

async function normalizeClientTokenForStorage(client: Partial<Client>): Promise<{
  storedToken: string;
  tokenHash: string;
  tokenPrefix: string;
}> {
  const explicitHash = isTokenHash(client.token_hash) ? client.token_hash : readStoredTokenHash(client.token);
  if (explicitHash) {
    return {
      storedToken: storedTokenHash(explicitHash),
      tokenHash: explicitHash,
      tokenPrefix: typeof client.token_prefix === 'string' ? client.token_prefix.slice(0, 8) : '',
    };
  }

  const rawToken = typeof client.token === 'string' && client.token.trim() !== ''
    ? client.token.trim()
    : crypto.randomUUID();
  return prepareAgentTokenForStorage(rawToken);
}

export async function createClient(db: D1Database, client: Partial<Client>): Promise<void> {
  const maxOrder = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM clients').first<{ max_order: number }>();
  const sortOrder = client.sort_order && client.sort_order > 0 ? client.sort_order : Number(maxOrder?.max_order || 0) + 1;
  const token = await normalizeClientTokenForStorage(client);
  await db.prepare(`INSERT INTO clients (uuid, token, token_hash, token_prefix, name, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(client.uuid, token.storedToken, token.tokenHash, token.tokenPrefix, client.name || '', sortOrder).run();
}

export async function replaceAllClients(db: D1Database, clients: Partial<Client>[]): Promise<void> {
  // Atomic delete+insert: DELETE must be in the same batch to prevent data loss if batch fails
  const batch: D1PreparedStatement[] = [db.prepare('DELETE FROM clients')];

  if (clients.length === 0) {
    await runD1Batch(db, 'replaceAllClients', batch);
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO clients (
      uuid, token, token_hash, token_prefix, name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden, traffic_limit,
      traffic_limit_type, sort_order, last_report_interval_sec, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [index, client] of clients.entries()) {
    const token = await normalizeClientTokenForStorage(client);
    batch.push(stmt.bind(
      client.uuid || crypto.randomUUID(),
      token.storedToken,
      token.tokenHash,
      token.tokenPrefix,
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
      client.last_report_interval_sec || null,
      client.created_at || new Date().toISOString(),
      client.updated_at || new Date().toISOString(),
    ));
  }

  await runD1Batch(db, 'replaceAllClients', batch);
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

export async function updateClient(db: D1Database, uuid: string, data: Partial<Client>): Promise<boolean> {
  const fields: string[] = [];
  const values: any[] = [];
  const changePredicates: string[] = [];
  const changeValues: any[] = [];
  for (const [key, value] of Object.entries(data)) {
    const column = CLIENT_UPDATE_COLUMNS[key];
    if (!column) continue;
    const normalizedValue = normalizeClientUpdateValue(key, value);
    fields.push(`${column} = ?`);
    values.push(normalizedValue);
    changePredicates.push(`${column} IS NOT ?`);
    changeValues.push(normalizedValue);
  }
  if (fields.length === 0) return false;
  values.push(uuid);
  const result = await db.prepare(
    `UPDATE clients SET ${fields.join(', ')}, updated_at = datetime('now') WHERE uuid = ? AND (${changePredicates.join(' OR ')})`,
  ).bind(...values, ...changeValues).run();
  return Number(result.meta.changes || 0) > 0;
}

export async function rotateClientToken(db: D1Database, uuid: string, token: string): Promise<void> {
  await storeClientTokenHash(db, uuid, token);
}

export async function markClientSeen(
  db: D1Database,
  uuid: string,
  time: string,
  source: string,
  persistedAt?: string | null,
  reportIntervalSec?: number | null,
): Promise<void> {
  const safeSource = source.slice(0, 32);
  const safeReportIntervalSec = Number.isFinite(Number(reportIntervalSec))
    ? Math.min(3600, Math.max(1, Math.floor(Number(reportIntervalSec))))
    : null;
  // Monotonic guard: only update if new timestamp is greater than or equal to existing
  // This prevents out-of-order/replayed reports from moving last_seen_at backwards
  if (persistedAt) {
    await db.prepare(`
      UPDATE clients
      SET last_seen_at = CASE
            WHEN last_seen_at IS NULL OR ? >= last_seen_at THEN ?
            ELSE last_seen_at
          END,
          last_report_source = ?,
          last_report_persisted_at = CASE
            WHEN last_report_persisted_at IS NULL OR ? >= COALESCE(last_report_persisted_at, '') THEN ?
            ELSE last_report_persisted_at
          END,
          last_report_interval_sec = CASE
            WHEN ? IS NOT NULL AND (last_seen_at IS NULL OR ? >= last_seen_at) THEN ?
            ELSE last_report_interval_sec
          END,
          updated_at = datetime('now')
      WHERE uuid = ?
    `).bind(time, time, safeSource, persistedAt, persistedAt, safeReportIntervalSec, time, safeReportIntervalSec, uuid).run();
    return;
  }

  await db.prepare(`
    UPDATE clients
    SET last_seen_at = CASE
          WHEN last_seen_at IS NULL OR ? >= last_seen_at THEN ?
          ELSE last_seen_at
        END,
        last_report_source = ?,
        last_report_interval_sec = CASE
          WHEN ? IS NOT NULL AND (last_seen_at IS NULL OR ? >= last_seen_at) THEN ?
          ELSE last_report_interval_sec
        END,
        updated_at = datetime('now')
    WHERE uuid = ?
  `).bind(time, time, safeSource, safeReportIntervalSec, time, safeReportIntervalSec, uuid).run();
}

export async function deleteClient(db: D1Database, uuid: string): Promise<void> {
  await db.prepare('DELETE FROM clients WHERE uuid = ?').bind(uuid).run();
}

export async function deleteClients(db: D1Database, uuids: string[]): Promise<number> {
  const uniqueUuids = normalizeUuidList(uuids);
  if (uniqueUuids.length === 0) return 0;

  let deleted = 0;
  for (let index = 0; index < uniqueUuids.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueUuids.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const result = await db.prepare(
      `DELETE FROM clients WHERE uuid IN (${placeholders(chunk.length)})`,
    ).bind(...chunk).run();
    deleted += Number(result.meta.changes || 0);
  }
  return deleted;
}

export async function updateClientsHidden(db: D1Database, uuids: string[], hidden: boolean): Promise<number> {
  const uniqueUuids = normalizeUuidList(uuids);
  if (uniqueUuids.length === 0) return 0;

  const hiddenValue = hidden ? 1 : 0;
  let changed = 0;
  for (let index = 0; index < uniqueUuids.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueUuids.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const result = await db.prepare(
      `UPDATE clients SET hidden = ?, updated_at = datetime('now') WHERE hidden != ? AND uuid IN (${placeholders(chunk.length)})`,
    ).bind(hiddenValue, hiddenValue, ...chunk).run();
    changed += Number(result.meta.changes || 0);
  }
  return changed;
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

  const currentOrderByUuid = new Map(existing.map(client => [
    client.uuid,
    Number(client.sort_order || 0),
  ]));
  const changed = finalUuids
    .map((uuid, index) => ({ uuid, sortOrder: index + 1 }))
    .filter(item => currentOrderByUuid.get(item.uuid) !== item.sortOrder);
  if (changed.length === 0) return 0;

  const stmt = db.prepare('UPDATE clients SET sort_order = ?, updated_at = datetime(\'now\') WHERE uuid = ?');
  const results = await runD1Batch(db, 'reorderClients', changed.map(item => stmt.bind(item.sortOrder, item.uuid)));
  return results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0);
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

function makeProbePagedResult<T>(data: T[], page: number, limit: number, hasMore: boolean): PagedResult<T> {
  const lowerBoundTotal = (page - 1) * limit + data.length + (hasMore ? 1 : 0);
  return {
    data,
    total: lowerBoundTotal,
    page,
    limit,
    has_more: hasMore,
  };
}

const DELETE_BATCH_SIZE = 100;
const DELETE_BATCH_LIMIT = 200;
const FULL_DELETE_BATCH_LIMIT = 1000;
const D1_BATCH_CHUNK_SIZE = 100;
const D1_BATCH_SAFE_STATEMENT_LIMIT = 900;

type HistoryDeleteCounts = {
  records: number;
  gpu_records: number;
  gpu_snapshots: number;
  ping_records: number;
  ping_snapshots: number;
};

function assertD1BatchSize(label: string, statements: D1PreparedStatement[]): void {
  if (statements.length <= D1_BATCH_SAFE_STATEMENT_LIMIT) return;
  throw new Error(`${label} would execute ${statements.length} D1 statements in one batch; split the operation or reduce the import size`);
}

async function runD1Batch(db: D1Database, label: string, statements: D1PreparedStatement[]) {
  assertD1BatchSize(label, statements);
  return db.batch(statements);
}

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
  const orderBy = /\btime\s*</i.test(whereClause) ? 'time, id' : 'id';

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const selectResult = await db.prepare(
      `SELECT id FROM ${table} ${whereClause} ORDER BY ${orderBy} LIMIT ?`,
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

export async function getRecentRecords(db: D1Database, client: string, limit: number = 30): Promise<MonitorRecord[]> {
  const result = await db.prepare(
    'SELECT * FROM records WHERE client = ? ORDER BY time DESC LIMIT ?'
  ).bind(client, limit).all<MonitorRecord>();
  return result.results.reverse();
}

export type LoadNotificationMetric = 'cpu' | 'ram' | 'load' | 'disk' | 'temp';

export interface LoadMetricWindowStats {
  samples: number;
  exceeded: number;
  avg_value: number;
}

const LOAD_METRIC_SQL: Record<LoadNotificationMetric, string> = {
  cpu: 'COALESCE(cpu, 0)',
  ram: 'CASE WHEN ram_total > 0 THEN (CAST(ram AS REAL) / ram_total) * 100 ELSE 0 END',
  load: 'COALESCE(load, 0)',
  disk: 'CASE WHEN disk_total > 0 THEN (CAST(disk AS REAL) / disk_total) * 100 ELSE 0 END',
  temp: 'COALESCE(temp, 0)',
};

export async function getLoadMetricWindowStatsForClients(
  db: D1Database,
  clients: string[],
  start: string,
  end: string,
  metric: LoadNotificationMetric,
  threshold: number,
): Promise<Map<string, LoadMetricWindowStats>> {
  const uniqueClients = normalizeUuidList(clients);
  const resultMap = new Map<string, LoadMetricWindowStats>();
  if (uniqueClients.length === 0) return resultMap;

  const expression = LOAD_METRIC_SQL[metric] || LOAD_METRIC_SQL.cpu;
  for (let index = 0; index < uniqueClients.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueClients.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const result = await db.prepare(
      `SELECT
        client,
        COUNT(*) AS samples,
        COALESCE(SUM(CASE WHEN ${expression} >= ? THEN 1 ELSE 0 END), 0) AS exceeded,
        COALESCE(AVG(${expression}), 0) AS avg_value
      FROM records
      WHERE client IN (${placeholders(chunk.length)}) AND time >= ? AND time <= ?
      GROUP BY client`
    ).bind(threshold, ...chunk, start, end).all<LoadMetricWindowStats & { client: string }>();

    for (const row of result.results) {
      resultMap.set(row.client, {
        samples: Number(row.samples || 0),
        exceeded: Number(row.exceeded || 0),
        avg_value: Number(row.avg_value || 0),
      });
    }
  }

  return resultMap;
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
  const result = await db.prepare(
    `SELECT * FROM (
      SELECT * FROM records
      WHERE client = ? AND time >= ? AND time <= ?
      ORDER BY time DESC
      LIMIT ? OFFSET ?
    ) ORDER BY time ASC`
  ).bind(client, start, end, pagination.limit + 1, pagination.offset).all<MonitorRecord>();

  const hasMore = result.results.length > pagination.limit;
  const data = hasMore ? result.results.slice(1) : result.results;
  return makeProbePagedResult(data, pagination.page, pagination.limit, hasMore);
}

function normalizeGPURecord(row: any): any | null {
  if (!row || !row.client || !row.time) return null;
  return {
    id: typeof row.id === 'number' ? row.id : undefined,
    client: row.client,
    time: row.time,
    device_index: Number(row.device_index || 0),
    device_name: row.device_name || '',
    mem_total: Number(row.mem_total || 0),
    mem_used: Number(row.mem_used || 0),
    utilization: Number(row.utilization || 0),
    temperature: Number(row.temperature || 0),
  };
}

function normalizeGPUDevice(input: any): Omit<GPUInfo, 'client' | 'time'> {
  return {
    device_index: Number(input?.device_index ?? 0),
    device_name: input?.device_name || '',
    mem_total: Number(input?.mem_total || 0),
    mem_used: Number(input?.mem_used || 0),
    utilization: Number(input?.utilization || 0),
    temperature: Number(input?.temperature || 0),
  };
}

function flattenGPUSnapshots(rows: any[]): any[] {
  const records: any[] = [];
  for (const row of rows) {
    let devices: any[] = [];
    try {
      const parsed = JSON.parse(row.devices_json || '[]');
      devices = Array.isArray(parsed) ? parsed : [];
    } catch {
      devices = [];
    }
    for (const device of devices) {
      records.push({
        id: row.id,
        client: row.client,
        time: row.time,
        ...normalizeGPUDevice(device),
      });
    }
  }
  return records;
}

async function queryGPUSnapshotRecords(db: D1Database, client: string, start: string | undefined, end: string | undefined, limit: number): Promise<any[]> {
  if (start && end) {
    const result = await db.prepare(
      `SELECT id, client, time, devices_json
      FROM gpu_snapshots
      WHERE client = ? AND time >= ? AND time <= ?
      ORDER BY time DESC
      LIMIT ?`
    ).bind(client, start, end, limit).all<any>();
    return flattenGPUSnapshots(result.results);
  }
  const result = await db.prepare(
    `SELECT id, client, time, devices_json
    FROM gpu_snapshots
    WHERE client = ?
    ORDER BY time DESC
    LIMIT ?`
  ).bind(client, limit).all<any>();
  return flattenGPUSnapshots(result.results);
}

async function queryLegacyGPURecords(db: D1Database, client: string, start: string | undefined, end: string | undefined, limit: number): Promise<any[]> {
  if (start && end) {
    const result = await db.prepare(
      `SELECT * FROM gpu_records
      WHERE client = ? AND time >= ? AND time <= ?
      ORDER BY time DESC
      LIMIT ?`
    ).bind(client, start, end, limit).all<any>();
    return result.results
      .map(normalizeGPURecord)
      .filter(Boolean);
  }
  const result = await db.prepare(
    'SELECT * FROM gpu_records WHERE client = ? ORDER BY time DESC LIMIT ?'
  ).bind(client, limit).all<any>();
  return result.results
    .map(normalizeGPURecord)
    .filter(Boolean);
}

function mergeGPUHistoryRows(snapshotRows: any[], legacyRows: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const row of snapshotRows) {
    byKey.set(`${row.client}:${row.time}:${row.device_index}`, row);
  }
  for (const row of legacyRows) {
    const key = `${row.client}:${row.time}:${row.device_index}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.time.localeCompare(a.time) || Number(a.device_index || 0) - Number(b.device_index || 0));
}

export async function getGPURecords(db: D1Database, client: string, start?: string, end?: string, limit: number = 100): Promise<any[]> {
  const safeLimit = normalizePagination(1, limit, 1000).limit;
  const [snapshotRows, legacyRows] = await Promise.all([
    queryGPUSnapshotRecords(db, client, start, end, safeLimit),
    queryLegacyGPURecords(db, client, start, end, safeLimit),
  ]);
  return mergeGPUHistoryRows(snapshotRows, legacyRows).slice(0, safeLimit).reverse();
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
  const probeLimit = pagination.offset + pagination.limit + 1;
  const [snapshotRows, legacyRows] = await Promise.all([
    queryGPUSnapshotRecords(db, client, start, end, probeLimit),
    queryLegacyGPURecords(db, client, start, end, probeLimit),
  ]);
  const pageRows = mergeGPUHistoryRows(snapshotRows, legacyRows)
    .slice(pagination.offset, pagination.offset + pagination.limit + 1);
  const hasMore = pageRows.length > pagination.limit;
  const data = (hasMore ? pageRows.slice(0, pagination.limit) : pageRows).reverse();
  return makeProbePagedResult(data, pagination.page, pagination.limit, hasMore);
}

export type DeleteOldRowsOptions = {
  maxBatches?: number;
};

export async function deleteOldRecords(db: D1Database, beforeTime: string, options: DeleteOldRowsOptions = {}): Promise<{ records: number; gpu_records: number; gpu_snapshots: number }> {
  return {
    records: await deleteRowsByIdBatch(db, 'records', 'WHERE time < ?', [beforeTime], options),
    gpu_records: await deleteRowsByIdBatch(db, 'gpu_records', 'WHERE time < ?', [beforeTime], options),
    gpu_snapshots: await deleteRowsByIdBatch(db, 'gpu_snapshots', 'WHERE time < ?', [beforeTime], options),
  };
}

export async function deleteOldPingRecords(db: D1Database, beforeTime: string, options: DeleteOldRowsOptions = {}): Promise<{ ping_records: number; ping_snapshots: number }> {
  return {
    ping_records: await deleteRowsByIdBatch(db, 'ping_records', 'WHERE time < ?', [beforeTime], options),
    ping_snapshots: await deleteRowsByIdBatch(db, 'ping_snapshots', 'WHERE time < ?', [beforeTime], options),
  };
}

export async function getLatestRecordTimes(db: D1Database): Promise<Array<{ client: string; last_time: string }>> {
  const result = await db.prepare(
    'SELECT client, time as last_time FROM latest_records ORDER BY time DESC'
  ).all<{ client: string; last_time: string }>();
  return result.results;
}

export async function getLatestRecordTimesForClients(
  db: D1Database,
  clients: string[],
): Promise<Array<{ client: string; last_time: string }>> {
  const uniqueClients = [...new Set(
    clients
      .filter((client): client is string => typeof client === 'string')
      .map(client => client.trim())
      .filter(Boolean),
  )];
  if (uniqueClients.length === 0) return [];

  const rows: Array<{ client: string; last_time: string }> = [];
  const stmt = db.prepare('SELECT client, time AS last_time FROM records WHERE client = ? ORDER BY time DESC LIMIT 1');
  for (let index = 0; index < uniqueClients.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueClients.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const results = await runD1Batch(db, 'getLatestRecordTimesForClients', chunk.map(client => stmt.bind(client)));
    for (const result of results) {
      const row = result.results?.[0] as { client?: string; last_time?: string } | undefined;
      if (row?.client && row.last_time) {
        rows.push({ client: row.client, last_time: row.last_time });
      }
    }
  }

  return rows;
}

export async function getLatestRecords(db: D1Database): Promise<MonitorRecord[]> {
  const result = await db.prepare('SELECT * FROM latest_records ORDER BY time DESC').all<MonitorRecord>();
  return result.results;
}

export async function clearAllRecords(db: D1Database): Promise<{ records: number; gpu_records: number; gpu_snapshots: number; ping_records: number; ping_snapshots: number }> {
  return {
    records: await deleteRowsByIdBatch(db, 'records', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    gpu_records: await deleteRowsByIdBatch(db, 'gpu_records', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    gpu_snapshots: await deleteRowsByIdBatch(db, 'gpu_snapshots', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    ping_records: await deleteRowsByIdBatch(db, 'ping_records', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    ping_snapshots: await deleteRowsByIdBatch(db, 'ping_snapshots', '', [], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
  };
}

export async function clearClientRecords(db: D1Database, client: string): Promise<HistoryDeleteCounts> {
  return {
    records: await deleteRowsByIdBatch(db, 'records', 'WHERE client = ?', [client], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    gpu_records: await deleteRowsByIdBatch(db, 'gpu_records', 'WHERE client = ?', [client], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    gpu_snapshots: await deleteRowsByIdBatch(db, 'gpu_snapshots', 'WHERE client = ?', [client], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    ping_records: await deleteRowsByIdBatch(db, 'ping_records', 'WHERE client = ?', [client], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
    ping_snapshots: await deleteRowsByIdBatch(db, 'ping_snapshots', 'WHERE client = ?', [client], { maxBatches: FULL_DELETE_BATCH_LIMIT }),
  };
}

export async function clearClientsRecords(db: D1Database, clients: string[]): Promise<HistoryDeleteCounts> {
  const uniqueClients = normalizeUuidList(clients);
  const deleted = { records: 0, gpu_records: 0, gpu_snapshots: 0, ping_records: 0, ping_snapshots: 0 };
  if (uniqueClients.length === 0) return deleted;

  for (let index = 0; index < uniqueClients.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueClients.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const whereClause = `WHERE client IN (${placeholders(chunk.length)})`;
    deleted.records += await deleteRowsByIdBatch(db, 'records', whereClause, chunk, { maxBatches: FULL_DELETE_BATCH_LIMIT });
    deleted.gpu_records += await deleteRowsByIdBatch(db, 'gpu_records', whereClause, chunk, { maxBatches: FULL_DELETE_BATCH_LIMIT });
    deleted.gpu_snapshots += await deleteRowsByIdBatch(db, 'gpu_snapshots', whereClause, chunk, { maxBatches: FULL_DELETE_BATCH_LIMIT });
    deleted.ping_records += await deleteRowsByIdBatch(db, 'ping_records', whereClause, chunk, { maxBatches: FULL_DELETE_BATCH_LIMIT });
    deleted.ping_snapshots += await deleteRowsByIdBatch(db, 'ping_snapshots', whereClause, chunk, { maxBatches: FULL_DELETE_BATCH_LIMIT });
  }
  return deleted;
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

function normalizeGPUInfo(input: any): GPUInfo {
  return {
    device_index: Number(input?.device_index ?? 0),
    device_name: input?.device_name || '',
    mem_total: Number(input?.mem_total || 0),
    mem_used: Number(input?.mem_used || 0),
    utilization: Number(input?.utilization || 0),
    temperature: Number(input?.temperature || 0),
  };
}

export async function insertGPURecords(db: D1Database, client: string, time: string, gpus: GPUInfo[]): Promise<void> {
  const devices = gpus.map(normalizeGPUInfo);
  if (devices.length === 0) return;
  await db.prepare('INSERT INTO gpu_snapshots (client, time, devices_json) VALUES (?, ?, ?)')
    .bind(client, time, JSON.stringify(devices)).run();
}

// ============ 用户 ============

export interface User {
  uuid: string;
  username: string;
  passwd: string;
  session_version: number;
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

export async function getUserByUuid(db: D1Database, uuid: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE uuid = ?').bind(uuid).first<User>();
}

export async function updateUserUsername(db: D1Database, uuid: string, username: string): Promise<void> {
  await db.prepare("UPDATE users SET username = ?, updated_at = datetime('now') WHERE uuid = ?")
    .bind(username, uuid).run();
}

export async function updateUserPassword(db: D1Database, uuid: string, hashedPassword: string): Promise<void> {
  await db.prepare("UPDATE users SET passwd = ?, updated_at = datetime('now') WHERE uuid = ?")
    .bind(hashedPassword, uuid).run();
}

export async function rotateUserSessionVersion(db: D1Database, uuid: string): Promise<number> {
  await db.prepare(`
    UPDATE users
    SET session_version = COALESCE(session_version, 0) + 1,
        updated_at = datetime('now')
    WHERE uuid = ?
  `).bind(uuid).run();
  const row = await db.prepare('SELECT session_version FROM users WHERE uuid = ?')
    .bind(uuid)
    .first<{ session_version: number }>();
  return Number(row?.session_version || 0);
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

export async function getSettingsByKeys(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  const uniqueKeys = [...new Set(keys.map(key => key.trim()).filter(Boolean))];
  if (uniqueKeys.length === 0) return {};

  const result = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${placeholders(uniqueKeys.length)})`,
  ).bind(...uniqueKeys).all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const row of result.results) {
    settings[row.key] = row.value;
  }
  return settings;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
}

export async function replaceAllSettings(db: D1Database, settings: Record<string, string>): Promise<void> {
  // Atomic delete+insert: DELETE must be in the same batch to prevent data loss if batch fails
  const batch: D1PreparedStatement[] = [db.prepare('DELETE FROM settings')];
  const entries = Object.entries(settings);

  if (entries.length === 0) {
    await runD1Batch(db, 'replaceAllSettings', batch);
    return;
  }

  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  batch.push(...entries.map(([key, value]) => stmt.bind(key, value)));
  await runD1Batch(db, 'replaceAllSettings', batch);
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

export type PingTaskEstimateRow = Pick<PingTask, 'id' | 'name' | 'clients' | 'all_clients' | 'interval_sec'>;

function normalizePingTask(row: any): PingTask {
  let clients: string[] = [];
  try {
    clients = JSON.parse(row.clients || '[]');
    if (!Array.isArray(clients)) {
      console.error('[normalizePingTask] clients is not an array:', row.clients);
      clients = [];
    }
  } catch (error) {
    console.error('[normalizePingTask] JSON.parse failed for clients:', row.clients, error);
    clients = [];
  }

  return {
    ...row,
    clients,
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

export async function listPingTaskEstimateRows(db: D1Database): Promise<PingTaskEstimateRow[]> {
  const result = await db.prepare(
    'SELECT id, name, clients, all_clients, interval_sec FROM ping_tasks ORDER BY sort_order ASC, id ASC',
  ).all<any>();
  return result.results.map(row => {
    let clients: string[] = [];
    try {
      clients = JSON.parse(row.clients || '[]');
      if (!Array.isArray(clients)) {
        console.error('[listPingTaskEstimateRows] clients is not an array:', row.clients);
        clients = [];
      }
    } catch (error) {
      console.error('[listPingTaskEstimateRows] JSON.parse failed for clients:', row.clients, error);
      clients = [];
    }

    return {
      id: row.id,
      name: row.name,
      clients,
      all_clients: !!row.all_clients,
      interval_sec: Number(row.interval_sec || 60),
    };
  });
}

export async function createPingTask(db: D1Database, task: PingTask): Promise<void> {
  const maxOrder = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM ping_tasks').first<{ max_order: number }>();
  const sortOrder = task.sort_order && task.sort_order > 0 ? task.sort_order : Number(maxOrder?.max_order || 0) + 1;
  await db.prepare('INSERT INTO ping_tasks (name, clients, all_clients, type, target, interval_sec, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(task.name, JSON.stringify(task.clients), task.all_clients ? 1 : 0, task.type, task.target, task.interval_sec, sortOrder).run();
}

export async function replaceAllPingTasks(db: D1Database, tasks: PingTask[]): Promise<void> {
  // Atomic delete+insert: DELETE must be in the same batch to prevent data loss if batch fails
  const batch: D1PreparedStatement[] = [db.prepare('DELETE FROM ping_tasks')];

  if (tasks.length === 0) {
    await runD1Batch(db, 'replaceAllPingTasks', batch);
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  batch.push(...tasks.map((task) =>
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

  await runD1Batch(db, 'replaceAllPingTasks', batch);
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

export async function updatePingTask(db: D1Database, id: number, task: Partial<PingTask>): Promise<boolean> {
  const fields: string[] = [];
  const values: any[] = [];
  const changePredicates: string[] = [];
  const changeValues: any[] = [];
  for (const [key, value] of Object.entries(task)) {
    if (key === 'id') continue;
    const column = PING_TASK_UPDATE_COLUMNS[key];
    if (!column) continue;
    let storedValue = value;
    if (key === 'clients') {
      storedValue = JSON.stringify(value);
    } else if (key === 'all_clients') {
      storedValue = value ? 1 : 0;
    }
    fields.push(`${column} = ?`);
    values.push(storedValue);
    changePredicates.push(`${column} IS NOT ?`);
    changeValues.push(storedValue);
  }
  if (fields.length === 0) return false;
  values.push(id);
  const result = await db.prepare(
    `UPDATE ping_tasks SET ${fields.join(', ')} WHERE id = ? AND (${changePredicates.join(' OR ')})`,
  ).bind(...values, ...changeValues).run();
  return Number(result.meta.changes || 0) > 0;
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

  const currentOrderById = new Map(existing.map(task => [
    task.id,
    Number(task.sort_order ?? task.id ?? 0),
  ]));
  const changed = finalIds
    .map((id, index) => ({ id, sortOrder: index + 1 }))
    .filter(item => currentOrderById.get(item.id) !== item.sortOrder);
  if (changed.length === 0) return 0;

  const stmt = db.prepare('UPDATE ping_tasks SET sort_order = ? WHERE id = ?');
  const results = await runD1Batch(db, 'reorderPingTasks', changed.map(item => stmt.bind(item.sortOrder, item.id)));
  return results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0);
}

export async function deletePingTask(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM ping_tasks WHERE id = ?').bind(id).run();
  await db.prepare('DELETE FROM ping_records WHERE task_id = ?').bind(id).run();
}

// ============ Ping 记录 ============

export interface PingHistoryRecord {
  id?: number;
  client: string;
  task_id: number;
  time: string;
  value: number;
}

export interface PingSnapshotInput {
  taskId: number;
  value: number;
}

export interface PingTaskHistoryRequest {
  taskId: number;
  limit?: number;
  intervalSec?: number;
}

export async function insertPingSnapshot(db: D1Database, client: string, time: string, results: PingSnapshotInput[]): Promise<void> {
  const values: Record<string, number> = {};
  for (const result of results) {
    if (!Number.isInteger(result.taskId) || result.taskId <= 0 || !Number.isFinite(result.value)) continue;
    values[String(result.taskId)] = Math.round(result.value);
  }
  if (Object.keys(values).length === 0) return;
  await db.prepare('INSERT INTO ping_snapshots (client, time, values_json) VALUES (?, ?, ?)')
    .bind(client, time, JSON.stringify(values)).run();
}

function normalizePingHistoryRow(row: any, taskId: number): PingHistoryRecord | null {
  const value = Number(row?.value);
  if (!row || !row.client || !row.time || !Number.isFinite(value)) return null;
  return {
    id: typeof row.id === 'number' ? row.id : undefined,
    client: row.client,
    task_id: taskId,
    time: row.time,
    value,
  };
}

async function queryPingSnapshotRows(db: D1Database, client: string, taskId: number, limit: number): Promise<PingHistoryRecord[]> {
  const taskKey = String(taskId);
  const result = await db.prepare(
    `SELECT
      id,
      client,
      time,
      CAST(json_extract(values_json, '$."' || ? || '"') AS INTEGER) AS value
    FROM ping_snapshots
    WHERE client = ? AND json_type(values_json, '$."' || ? || '"') IS NOT NULL
    ORDER BY time DESC
    LIMIT ?`,
  ).bind(taskKey, client, taskKey, limit).all<any>();
  return result.results
    .map(row => normalizePingHistoryRow(row, taskId))
    .filter((row): row is PingHistoryRecord => Boolean(row));
}

async function queryLegacyPingRows(db: D1Database, client: string, taskId: number, limit: number): Promise<PingHistoryRecord[]> {
  const result = await db.prepare(
    'SELECT * FROM ping_records WHERE client = ? AND task_id = ? ORDER BY time DESC LIMIT ?'
  ).bind(client, taskId, limit).all<any>();
  return result.results
    .map(row => normalizePingHistoryRow(row, taskId))
    .filter((row): row is PingHistoryRecord => Boolean(row));
}

function mergePingHistoryRows(snapshotRows: PingHistoryRecord[], legacyRows: PingHistoryRecord[]): PingHistoryRecord[] {
  const byKey = new Map<string, PingHistoryRecord>();
  for (const row of snapshotRows) {
    byKey.set(`${row.client}:${row.task_id}:${row.time}`, row);
  }
  for (const row of legacyRows) {
    const key = `${row.client}:${row.task_id}:${row.time}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.time.localeCompare(a.time));
}

export async function getPingRecords(db: D1Database, client: string, taskId: number, limit: number = 120): Promise<PingHistoryRecord[]> {
  const safeLimit = normalizePagination(1, limit, 1000).limit;
  const [snapshotRows, legacyRows] = await Promise.all([
    queryPingSnapshotRows(db, client, taskId, safeLimit),
    queryLegacyPingRows(db, client, taskId, safeLimit),
  ]);
  return mergePingHistoryRows(snapshotRows, legacyRows).slice(0, safeLimit).reverse();
}

function normalizeHistoryLimit(limit: unknown): number {
  return normalizePagination(1, Number(limit), 1000).limit;
}

function normalizeTaskHistoryRequests(
  taskRequests: number[] | PingTaskHistoryRequest[],
  fallbackLimit: number,
  maxCount = 50,
): Array<{ taskId: number; limit: number; intervalSec?: number }> {
  const fallbackSafeLimit = normalizeHistoryLimit(fallbackLimit);
  const byTask = new Map<number, { taskId: number; limit: number; intervalSec?: number }>();
  for (const item of taskRequests) {
    const raw = typeof item === 'number'
      ? { taskId: item }
      : item;
    const taskId = Math.floor(Number(raw?.taskId));
    if (!Number.isInteger(taskId) || taskId <= 0) continue;
    const limit = normalizeHistoryLimit(raw?.limit ?? fallbackSafeLimit);
    const interval = Math.floor(Number(raw?.intervalSec));
    const intervalSec = Number.isInteger(interval) && interval > 0
      ? Math.min(Math.max(interval, 5), 86_400)
      : undefined;
    const current = byTask.get(taskId);
    byTask.set(taskId, {
      taskId,
      limit: Math.max(current?.limit || 0, limit),
      intervalSec: intervalSec ?? current?.intervalSec,
    });
  }
  return [...byTask.values()].slice(0, maxCount);
}

export async function getPingRecordsForTasks(
  db: D1Database,
  client: string,
  taskIds: number[] | PingTaskHistoryRequest[],
  limit: number = 120,
  baseIntervalSec?: number,
): Promise<Record<string, PingHistoryRecord[]>> {
  const requests = normalizeTaskHistoryRequests(taskIds, limit);
  const empty = Object.fromEntries(requests.map(request => [String(request.taskId), [] as PingHistoryRecord[]]));
  if (requests.length === 0) return empty;

  const normalizedTaskIds = requests.map(request => request.taskId);
  const maxLimit = Math.max(...requests.map(request => request.limit));
  const limitByTask = new Map(requests.map(request => [request.taskId, request.limit]));
  const boundedBaseIntervalSec = Math.floor(Number(baseIntervalSec));
  const knownIntervals = requests
    .map(request => request.intervalSec)
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0);
  const minIntervalSec = Number.isInteger(boundedBaseIntervalSec) && boundedBaseIntervalSec > 0
    ? Math.min(Math.max(boundedBaseIntervalSec, 5), 86_400)
    : Math.min(...knownIntervals, 60);
  const snapshotScanLimit = Math.min(5000, Math.max(
    maxLimit,
    ...requests.map((request) => {
      const intervalSec = request.intervalSec || minIntervalSec;
      return request.limit * Math.max(1, Math.ceil(intervalSec / minIntervalSec));
    }),
  ));

  const taskIdSet = new Set(normalizedTaskIds);
  const snapshotRowsByTask = new Map<number, PingHistoryRecord[]>();
  const legacyRowsByTask = new Map<number, PingHistoryRecord[]>();
  for (const taskId of normalizedTaskIds) {
    snapshotRowsByTask.set(taskId, []);
    legacyRowsByTask.set(taskId, []);
  }

  const snapshotResult = await db.prepare(
    `SELECT id, client, time, values_json
    FROM ping_snapshots
    WHERE client = ?
    ORDER BY time DESC
    LIMIT ?`,
  ).bind(client, snapshotScanLimit).all<any>();

  for (const row of snapshotResult.results) {
    let values: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.values_json || '{}');
      values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      values = {};
    }

    for (const taskId of normalizedTaskIds) {
      const rows = snapshotRowsByTask.get(taskId)!;
      const requestLimit = limitByTask.get(taskId) || maxLimit;
      if (rows.length >= requestLimit) continue;
      if (!Object.prototype.hasOwnProperty.call(values, String(taskId))) continue;
      const value = Number(values[String(taskId)]);
      if (!Number.isFinite(value)) continue;
      rows.push({
        id: typeof row.id === 'number' ? row.id : undefined,
        client: row.client,
        task_id: taskId,
        time: row.time,
        value,
      });
    }
  }

  const legacyLimit = Math.min(5000, requests.reduce((sum, request) => sum + request.limit, 0));
  const legacyResult = await db.prepare(
    `SELECT id, client, task_id, time, value
    FROM ping_records
    WHERE client = ? AND task_id IN (${placeholders(normalizedTaskIds.length)})
    ORDER BY time DESC
    LIMIT ?`,
  ).bind(client, ...normalizedTaskIds, legacyLimit).all<any>();

  for (const row of legacyResult.results) {
    const taskId = Number(row.task_id);
    if (!taskIdSet.has(taskId)) continue;
    const normalized = normalizePingHistoryRow(row, taskId);
    if (normalized) legacyRowsByTask.get(taskId)!.push(normalized);
  }

  return Object.fromEntries(normalizedTaskIds.map((taskId) => [
    String(taskId),
    mergePingHistoryRows(
      snapshotRowsByTask.get(taskId) || [],
      legacyRowsByTask.get(taskId) || [],
    ).slice(0, limitByTask.get(taskId) || maxLimit).reverse(),
  ]));
}

export async function getPingRecordsPaged(
  db: D1Database,
  client: string,
  taskId: number,
  page: number = 1,
  limit: number = 120,
): Promise<PagedResult<PingHistoryRecord>> {
  const pagination = normalizePagination(page, limit, 500);
  const probeLimit = pagination.offset + pagination.limit + 1;
  const [snapshotRows, legacyRows] = await Promise.all([
    queryPingSnapshotRows(db, client, taskId, probeLimit),
    queryLegacyPingRows(db, client, taskId, probeLimit),
  ]);
  const pageRows = mergePingHistoryRows(snapshotRows, legacyRows)
    .slice(pagination.offset, pagination.offset + pagination.limit + 1);
  const hasMore = pageRows.length > pagination.limit;
  const data = (hasMore ? pageRows.slice(0, pagination.limit) : pageRows).reverse();
  return makeProbePagedResult(data, pagination.page, pagination.limit, hasMore);
}

// ============ 通知设置 ============

export type NotificationDeliveryStatus = 'sent' | 'failed' | 'skipped';
export type NotificationIncidentStatus = 'open' | 'resolved';

export interface NotificationDeliveryInput {
  notification_type: string;
  channel?: string;
  status: NotificationDeliveryStatus;
  target?: string | null;
  client?: string | null;
  rule_id?: number | null;
  attempted_at: string;
  sent_at?: string | null;
  error?: unknown;
}

export interface NotificationIncidentRow {
  id: number;
  incident_key: string;
  notification_type: string;
  target: string;
  client: string | null;
  rule_id: number | null;
  status: NotificationIncidentStatus;
  first_detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  last_attempt_at: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationIncidentInput {
  incident_key?: string | null;
  notification_type: string;
  target: string;
  client?: string | null;
  rule_id?: number | null;
  detected_at: string;
}

export async function getOfflineNotification(db: D1Database, client: string): Promise<any> {
  return db.prepare('SELECT * FROM offline_notifications WHERE client = ?').bind(client).first();
}

export async function listOfflineNotifications(db: D1Database): Promise<any[]> {
  const result = await db.prepare('SELECT * FROM offline_notifications').all();
  return result.results;
}

export async function replaceAllOfflineNotifications(db: D1Database, notifications: any[]): Promise<void> {
  // Atomic delete+insert: DELETE must be in the same batch to prevent data loss if batch fails
  const batch: D1PreparedStatement[] = [db.prepare('DELETE FROM offline_notifications')];

  if (notifications.length === 0) {
    await runD1Batch(db, 'replaceAllOfflineNotifications', batch);
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO offline_notifications (client, enable, grace_period, last_notified)
    VALUES (?, ?, ?, ?)
  `);

  batch.push(
    ...notifications.map((item) =>
      stmt.bind(
        item.client,
        item.enable ? 1 : 0,
        item.grace_period || 180,
        item.last_notified || null,
      ),
    ),
  );

  await runD1Batch(db, 'replaceAllOfflineNotifications', batch);
}

export async function setOfflineNotification(db: D1Database, client: string, enable: boolean, gracePeriod: number): Promise<boolean> {
  const result = await db.prepare(`
    INSERT INTO offline_notifications (client, enable, grace_period)
    VALUES (?, ?, ?)
    ON CONFLICT(client) DO UPDATE SET
      enable = excluded.enable,
      grace_period = excluded.grace_period
    WHERE offline_notifications.enable IS NOT excluded.enable
       OR offline_notifications.grace_period IS NOT excluded.grace_period
  `).bind(client, enable ? 1 : 0, gracePeriod).run();
  return Number(result.meta.changes || 0) > 0;
}

function truncateNotificationError(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return String(error).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function normalizeNotificationDeliveryText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return (trimmed || fallback).slice(0, maxLength);
}

export async function insertNotificationDelivery(db: D1Database, delivery: NotificationDeliveryInput): Promise<void> {
  const ruleId = Number.isInteger(delivery.rule_id) ? Number(delivery.rule_id) : null;
  const client = typeof delivery.client === 'string' && delivery.client.trim()
    ? delivery.client.trim().slice(0, 128)
    : null;
  const target = normalizeNotificationDeliveryText(
    delivery.target,
    client || (ruleId === null ? '' : String(ruleId)),
    128,
  );

  await db.prepare(`
    INSERT INTO notification_deliveries (
      notification_type,
      channel,
      status,
      target,
      client,
      rule_id,
      attempted_at,
      sent_at,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      normalizeNotificationDeliveryText(delivery.notification_type, 'unknown', 64),
      normalizeNotificationDeliveryText(delivery.channel, 'telegram', 32),
      delivery.status,
      target,
      client,
      ruleId,
      delivery.attempted_at || new Date().toISOString(),
      delivery.sent_at || null,
      truncateNotificationError(delivery.error),
    )
    .run();
}

export function makeNotificationIncidentKey(notificationType: string, target: string): string {
  const safeType = normalizeNotificationDeliveryText(notificationType, 'unknown', 64);
  const safeTarget = normalizeNotificationDeliveryText(target, '', 192);
  return `${safeType}:${safeTarget}`.slice(0, 256);
}

export async function listOpenNotificationIncidents(
  db: D1Database,
  notificationType: string,
  targets: string[],
): Promise<Map<string, NotificationIncidentRow>> {
  const incidents = new Map<string, NotificationIncidentRow>();
  const safeType = normalizeNotificationDeliveryText(notificationType, 'unknown', 64);
  const uniqueTargets = [...new Set(
    targets
      .filter((target): target is string => typeof target === 'string')
      .map(target => target.trim())
      .filter(Boolean)
      .map(target => target.slice(0, 192)),
  )];
  if (uniqueTargets.length === 0) return incidents;

  for (let index = 0; index < uniqueTargets.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueTargets.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const result = await db.prepare(`
      SELECT *
      FROM notification_incidents
      WHERE notification_type = ?
        AND status = 'open'
        AND target IN (${placeholders(chunk.length)})
    `)
      .bind(safeType, ...chunk)
      .all<NotificationIncidentRow>();

    for (const row of result.results || []) {
      incidents.set(row.target, row);
    }
  }

  return incidents;
}

export async function openNotificationIncident(db: D1Database, incident: NotificationIncidentInput): Promise<string> {
  const notificationType = normalizeNotificationDeliveryText(incident.notification_type, 'unknown', 64);
  const target = normalizeNotificationDeliveryText(incident.target, '', 192);
  const incidentKey = normalizeNotificationDeliveryText(
    incident.incident_key,
    makeNotificationIncidentKey(notificationType, target),
    256,
  );
  const client = typeof incident.client === 'string' && incident.client.trim()
    ? incident.client.trim().slice(0, 128)
    : null;
  const ruleId = Number.isInteger(incident.rule_id) ? Number(incident.rule_id) : null;
  const detectedAt = incident.detected_at || new Date().toISOString();

  await db.prepare(`
    INSERT INTO notification_incidents (
      incident_key,
      notification_type,
      target,
      client,
      rule_id,
      status,
      first_detected_at,
      last_detected_at,
      resolved_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?)
    ON CONFLICT(incident_key) DO UPDATE SET
      notification_type = excluded.notification_type,
      target = excluded.target,
      client = excluded.client,
      rule_id = excluded.rule_id,
      status = 'open',
      first_detected_at = CASE
        WHEN notification_incidents.status = 'open' THEN notification_incidents.first_detected_at
        ELSE excluded.first_detected_at
      END,
      last_detected_at = excluded.last_detected_at,
      resolved_at = NULL,
      last_attempt_at = CASE
        WHEN notification_incidents.status = 'open' THEN notification_incidents.last_attempt_at
        ELSE NULL
      END,
      last_sent_at = CASE
        WHEN notification_incidents.status = 'open' THEN notification_incidents.last_sent_at
        ELSE NULL
      END,
      last_error = CASE
        WHEN notification_incidents.status = 'open' THEN notification_incidents.last_error
        ELSE NULL
      END,
      updated_at = excluded.updated_at
  `)
    .bind(incidentKey, notificationType, target, client, ruleId, detectedAt, detectedAt, detectedAt)
    .run();

  return incidentKey;
}

export async function markNotificationIncidentAttempt(db: D1Database, incidentKey: string, time: string, error?: unknown): Promise<void> {
  await db.prepare(`
    UPDATE notification_incidents
    SET last_attempt_at = ?,
        last_error = ?,
        updated_at = ?
    WHERE incident_key = ?
  `)
    .bind(time, truncateNotificationError(error), time, incidentKey)
    .run();
}

export async function markNotificationIncidentSent(db: D1Database, incidentKey: string, time: string): Promise<void> {
  await db.prepare(`
    UPDATE notification_incidents
    SET last_attempt_at = ?,
        last_sent_at = ?,
        last_error = NULL,
        updated_at = ?
    WHERE incident_key = ?
  `)
    .bind(time, time, time, incidentKey)
    .run();
}

export async function resolveNotificationIncident(db: D1Database, incidentKey: string, time: string): Promise<void> {
  await db.prepare(`
    UPDATE notification_incidents
    SET status = 'resolved',
        resolved_at = ?,
        updated_at = ?
    WHERE incident_key = ?
      AND status = 'open'
  `)
    .bind(time, time, incidentKey)
    .run();
}

export async function listRecentlySentLoadNotificationClients(
  db: D1Database,
  ruleId: number,
  clientIds: string[],
  sinceTime: string,
): Promise<Set<string>> {
  const sentClients = new Set<string>();
  if (!Number.isInteger(ruleId) || ruleId <= 0) return sentClients;

  const uniqueClientIds = normalizeUuidList(clientIds);
  if (uniqueClientIds.length === 0) return sentClients;

  for (let index = 0; index < uniqueClientIds.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueClientIds.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const result = await db.prepare(`
      SELECT DISTINCT client
      FROM notification_deliveries
      WHERE notification_type = 'load'
        AND status = 'sent'
        AND rule_id = ?
        AND client IN (${placeholders(chunk.length)})
        AND sent_at >= ?
    `)
      .bind(ruleId, ...chunk, sinceTime)
      .all<{ client: string }>();

    for (const row of result.results || []) {
      if (row.client) sentClients.add(row.client);
    }
  }

  return sentClients;
}

export async function markOfflineNotificationAttempt(db: D1Database, client: string, time: string, error?: unknown): Promise<void> {
  await db.prepare('UPDATE offline_notifications SET last_attempt_at = ?, last_error = ? WHERE client = ?')
    .bind(time, truncateNotificationError(error), client).run();
}

export async function markOfflineNotificationSent(db: D1Database, client: string, time: string): Promise<void> {
  await db.prepare('UPDATE offline_notifications SET last_notified = ?, last_sent_at = ?, last_attempt_at = ?, last_error = NULL WHERE client = ?')
    .bind(time, time, time, client).run();
}

export async function markExpiryNotificationAttempt(db: D1Database, client: string, time: string, error?: unknown): Promise<void> {
  await db.prepare('UPDATE expiry_notifications SET last_attempt_at = ?, last_error = ? WHERE client = ?')
    .bind(time, truncateNotificationError(error), client).run();
}

export async function markExpiryNotificationSent(db: D1Database, client: string, time: string): Promise<void> {
  await db.prepare('UPDATE expiry_notifications SET last_notified = ?, last_sent_at = ?, last_attempt_at = ?, last_error = NULL WHERE client = ?')
    .bind(time, time, time, client).run();
}

export async function markLoadNotificationAttempt(db: D1Database, id: number, time: string, error?: unknown): Promise<void> {
  await db.prepare('UPDATE load_notifications SET last_attempt_at = ?, last_error = ? WHERE id = ?')
    .bind(time, truncateNotificationError(error), id).run();
}

export async function markLoadNotificationSent(db: D1Database, id: number, time: string): Promise<void> {
  await db.prepare('UPDATE load_notifications SET last_notified = ?, last_sent_at = ?, last_attempt_at = ?, last_error = NULL WHERE id = ?')
    .bind(time, time, time, id).run();
}

export async function listExpiryNotifications(db: D1Database): Promise<any[]> {
  const result = await db.prepare('SELECT * FROM expiry_notifications').all();
  return result.results;
}

export async function replaceAllExpiryNotifications(db: D1Database, notifications: any[]): Promise<void> {
  // Atomic delete+insert: DELETE must be in the same batch to prevent data loss if batch fails
  const batch: D1PreparedStatement[] = [db.prepare('DELETE FROM expiry_notifications')];

  if (notifications.length === 0) {
    await runD1Batch(db, 'replaceAllExpiryNotifications', batch);
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO expiry_notifications (client, enable, advance_days, last_notified)
    VALUES (?, ?, ?, ?)
  `);

  batch.push(
    ...notifications.map((item) =>
      stmt.bind(
        item.client,
        item.enable ? 1 : 0,
        item.advance_days || 7,
        item.last_notified || null,
      ),
    ),
  );

  await runD1Batch(db, 'replaceAllExpiryNotifications', batch);
}

export async function setExpiryNotification(db: D1Database, client: string, enable: boolean, advanceDays: number): Promise<boolean> {
  const result = await db.prepare(`
    INSERT INTO expiry_notifications (client, enable, advance_days)
    VALUES (?, ?, ?)
    ON CONFLICT(client) DO UPDATE SET
      enable = excluded.enable,
      advance_days = excluded.advance_days
    WHERE expiry_notifications.enable IS NOT excluded.enable
       OR expiry_notifications.advance_days IS NOT excluded.advance_days
  `).bind(client, enable ? 1 : 0, advanceDays).run();
  return Number(result.meta.changes || 0) > 0;
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

function parseLoadNotificationClients(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((client): client is string => typeof client === 'string');
  } catch {
    return [];
  }
}

export async function listLoadNotifications(db: D1Database): Promise<any[]> {
  const result = await db.prepare('SELECT * FROM load_notifications').all<any>();
  return result.results.map(row => ({ ...row, clients: parseLoadNotificationClients(row.clients) }));
}

export async function getLoadNotification(db: D1Database, id: number): Promise<any | null> {
  const row = await db.prepare('SELECT * FROM load_notifications WHERE id = ?').bind(id).first<any>();
  return row ? { ...row, clients: parseLoadNotificationClients(row.clients) } : null;
}

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
  // Atomic delete+insert: DELETE must be in the same batch to prevent data loss if batch fails
  const batch: D1PreparedStatement[] = [db.prepare('DELETE FROM load_notifications')];

  if (notifications.length === 0) {
    await runD1Batch(db, 'replaceAllLoadNotifications', batch);
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO load_notifications (
      id, name, clients, metric, threshold, ratio, interval_min, last_notified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  batch.push(
    ...notifications.map((item) =>
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

  await runD1Batch(db, 'replaceAllLoadNotifications', batch);
}

export async function updateLoadNotification(db: D1Database, id: number, data: any): Promise<boolean> {
  const fields: string[] = [];
  const values: any[] = [];
  const changePredicates: string[] = [];
  const changeValues: any[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id') continue;
    const column = LOAD_NOTIFICATION_UPDATE_COLUMNS[key];
    if (!column) continue;

    const normalizedValue = normalizeLoadNotificationValue(key, value);
    if (normalizedValue === undefined) continue;

    fields.push(`${column} = ?`);
    values.push(normalizedValue);
    changePredicates.push(`${column} IS NOT ?`);
    changeValues.push(normalizedValue);
  }
  if (fields.length === 0) return false;
  values.push(id, ...changeValues);
  const result = await db.prepare(
    `UPDATE load_notifications SET ${fields.join(', ')} WHERE id = ? AND (${changePredicates.join(' OR ')})`
  ).bind(...values).run();
  return Number(result.meta.changes || 0) > 0;
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
  return pruneClientReferencesForClients(db, [uuid]);
}

export async function pruneClientReferencesForClients(db: D1Database, uuids: string[]): Promise<ClientReferenceCleanupResult> {
  const removeSet = new Set(normalizeUuidList(uuids));
  if (removeSet.size === 0) {
    return {
      ping_tasks_updated: 0,
      load_notifications_updated: 0,
      load_notifications_deleted: 0,
      expiry_notifications_deleted: 0,
    };
  }

  let pingTasksUpdated = 0;
  const pingTasks = await listPingTasks(db);
  for (const task of pingTasks) {
    if (!task.id || task.all_clients) continue;
    const clients = task.clients.filter(client => !removeSet.has(client));
    if (clients.length === task.clients.length) continue;
    await updatePingTask(db, task.id, { clients });
    pingTasksUpdated += 1;
  }

  let loadNotificationsUpdated = 0;
  let loadNotificationsDeleted = 0;
  const loadNotifications = await listLoadNotifications(db);
  for (const notification of loadNotifications) {
    if (!notification.id || !Array.isArray(notification.clients)) continue;
    const clients = notification.clients.filter((client: string) => !removeSet.has(client));
    if (clients.length === notification.clients.length) continue;
    if (clients.length === 0) {
      await deleteLoadNotification(db, notification.id);
      loadNotificationsDeleted += 1;
    } else {
      if (await updateLoadNotification(db, notification.id, { clients })) {
        loadNotificationsUpdated += 1;
      }
    }
  }

  let expiryNotificationsDeleted = 0;
  const uniqueUuids = [...removeSet];
  for (let index = 0; index < uniqueUuids.length; index += D1_BATCH_CHUNK_SIZE) {
    const chunk = uniqueUuids.slice(index, index + D1_BATCH_CHUNK_SIZE);
    const expiryNotifications = await db.prepare(
      `DELETE FROM expiry_notifications WHERE client IN (${placeholders(chunk.length)})`,
    ).bind(...chunk).run();
    expiryNotificationsDeleted += Number(expiryNotifications.meta.changes || 0);
  }

  return {
    ping_tasks_updated: pingTasksUpdated,
    load_notifications_updated: loadNotificationsUpdated,
    load_notifications_deleted: loadNotificationsDeleted,
    expiry_notifications_deleted: expiryNotificationsDeleted,
  };
}

export interface OrphanClientDataCleanupResult extends ClientReferenceCleanupResult {
  offline_notifications_deleted: number;
  records_deleted: number;
  gpu_records_deleted: number;
  gpu_snapshots_deleted: number;
  ping_records_deleted: number;
  ping_snapshots_deleted: number;
}

export async function cleanupOrphanClientData(db: D1Database): Promise<OrphanClientDataCleanupResult> {
  const allowedClientIds = new Set(await listClientIds(db));
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
      if (await updateLoadNotification(db, notification.id, { clients: filtered })) {
        loadNotificationsUpdated += 1;
      }
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
  const gpuSnapshots = await db.prepare(
    'DELETE FROM gpu_snapshots WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();
  const pingRecords = await db.prepare(
    'DELETE FROM ping_records WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();
  const pingSnapshots = await db.prepare(
    'DELETE FROM ping_snapshots WHERE client NOT IN (SELECT uuid FROM clients)'
  ).run();

  return {
    ping_tasks_updated: pingTasksUpdated,
    load_notifications_updated: loadNotificationsUpdated,
    load_notifications_deleted: loadNotificationsDeleted,
    expiry_notifications_deleted: Number(expiryNotifications.meta.changes || 0),
    offline_notifications_deleted: Number(offlineNotifications.meta.changes || 0),
    records_deleted: Number(records.meta.changes || 0),
    gpu_records_deleted: Number(gpuRecords.meta.changes || 0),
    gpu_snapshots_deleted: Number(gpuSnapshots.meta.changes || 0),
    ping_records_deleted: Number(pingRecords.meta.changes || 0),
    ping_snapshots_deleted: Number(pingSnapshots.meta.changes || 0),
  };
}

// ============ 备份恢复 ============

function backupClientIds(backup: BackupData): Set<string> | null {
  if (!Array.isArray(backup.clients)) return null;
  return new Set(
    backup.clients
      .map(client => typeof client.uuid === 'string' ? client.uuid.trim() : '')
      .filter(Boolean),
  );
}

function backupClientList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((client): client is string => typeof client === 'string')
      .map(client => client.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return backupClientList(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function assertKnownBackupClients(label: string, values: string[], knownClients: Set<string>, missing: string[]): void {
  for (const client of values) {
    if (!knownClients.has(client)) missing.push(`${label}:${client}`);
  }
}

function validateBackupReferences(backup: BackupData): void {
  const knownClients = backupClientIds(backup);
  if (!knownClients) return;

  const missing: string[] = [];
  for (const item of backup.offline_notifications || []) {
    assertKnownBackupClients('offline_notifications', backupClientList([item.client]), knownClients, missing);
  }
  for (const item of backup.expiry_notifications || []) {
    assertKnownBackupClients('expiry_notifications', backupClientList([item.client]), knownClients, missing);
  }
  for (const task of backup.ping_tasks || []) {
    if (!task.all_clients) {
      assertKnownBackupClients(`ping_tasks:${task.name || task.id || 'unknown'}`, backupClientList(task.clients), knownClients, missing);
    }
  }
  for (const notification of backup.load_notifications || []) {
    assertKnownBackupClients(`load_notifications:${notification.name || notification.id || 'unknown'}`, backupClientList(notification.clients), knownClients, missing);
  }

  if (missing.length > 0) {
    const sample = missing.slice(0, 20).join(', ');
    const suffix = missing.length > 20 ? `; plus ${missing.length - 20} more` : '';
    throw new Error(`Backup references clients that are not present in backup.clients: ${sample}${suffix}`);
  }
}

export async function restoreBackupData(db: D1Database, backup: BackupData): Promise<void> {
  validateBackupReferences(backup);
  const sections: D1PreparedStatement[][] = [];

  if (backup.settings !== undefined) {
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM settings')];
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(backup.settings)) {
      statements.push(stmt.bind(key, value));
    }
    sections.push(statements);
  }

  if (backup.clients !== undefined) {
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM clients')];
    const stmt = db.prepare(`
      INSERT INTO clients (
        uuid, token, token_hash, token_prefix, name, cpu_name, virtualization, arch, cpu_cores, os,
        kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
        mem_total, swap_total, disk_total, version, price, billing_cycle,
        auto_renewal, currency, expired_at, "group", tags, hidden, traffic_limit,
        traffic_limit_type, sort_order, last_report_interval_sec, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, client] of backup.clients.entries()) {
      const token = await normalizeClientTokenForStorage(client);
      statements.push(stmt.bind(
        client.uuid || crypto.randomUUID(),
        token.storedToken,
        token.tokenHash,
        token.tokenPrefix,
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
        client.last_report_interval_sec || null,
        client.created_at || new Date().toISOString(),
        client.updated_at || new Date().toISOString(),
      ));
    }
    sections.push(statements);
  }

  if (backup.ping_tasks !== undefined) {
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM ping_tasks')];
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
    sections.push(statements);
  }

  if (backup.offline_notifications !== undefined) {
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM offline_notifications')];
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
    sections.push(statements);
  }

  if (backup.expiry_notifications !== undefined) {
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM expiry_notifications')];
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
    sections.push(statements);
  }

  if (backup.load_notifications !== undefined) {
    const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM load_notifications')];
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
    sections.push(statements);
  }

  if (sections.length === 0) return;
  for (const statements of sections) {
    await runD1Batch(db, 'restoreBackupData', statements);
  }
}

// ============ 审计日志 ============

export type AuditLogLevel = 'info' | 'warning' | 'error';

export function normalizeAuditLogLevel(level: unknown): AuditLogLevel {
  if (level === 'error') return 'error';
  if (level === 'warning' || level === 'warn') return 'warning';
  return 'info';
}

// SEC-5: Sanitize audit detail to remove control characters that could break log parsing
function sanitizeAuditDetail(detail: string): string {
  if (!detail) return '';
  // Remove control characters (0x00-0x1F except tab/newline, and 0x7F-0x9F)
  // Keep tab (0x09), newline (0x0A), carriage return (0x0D) for structured logs
  return detail.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

export async function insertAuditLog(db: D1Database, user: string, action: string, detail: string, level: string = 'info'): Promise<void> {
  const sanitizedDetail = sanitizeAuditDetail(detail);
  await db.prepare('INSERT INTO audit_logs (time, user, action, detail, level) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), user, action, sanitizedDetail, normalizeAuditLogLevel(level)).run();
}

export async function listAuditLogsPaged(
  db: D1Database,
  page: number = 1,
  limit: number = 50,
): Promise<{ logs: any[]; total: number; has_more: boolean }> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const safePage = Math.max(1, page);
  const offset = (safePage - 1) * safeLimit;

  const result = await db
    .prepare('SELECT * FROM audit_logs ORDER BY time DESC LIMIT ? OFFSET ?')
    .bind(safeLimit + 1, offset)
    .all();
  const rows = result.results;
  const hasMore = rows.length > safeLimit;
  const logs = hasMore ? rows.slice(0, safeLimit) : rows;

  return {
    logs,
    total: offset + logs.length + (hasMore ? 1 : 0),
    has_more: hasMore,
  };
}

export async function deleteOldAuditLogs(db: D1Database, beforeTime: string, options: DeleteOldRowsOptions = {}): Promise<{ audit_logs: number }> {
  return {
    audit_logs: await deleteRowsByIdBatch(db, 'audit_logs', 'WHERE unixepoch(time) < unixepoch(?)', [beforeTime], options),
  };
}

export async function deleteOldNotificationDeliveries(
  db: D1Database,
  beforeTime: string,
  options: DeleteOldRowsOptions = {},
): Promise<{ notification_deliveries: number }> {
  return {
    notification_deliveries: await deleteRowsByIdBatch(
      db,
      'notification_deliveries',
      'WHERE attempted_at < ?',
      [beforeTime],
      options,
    ),
  };
}

export interface TableRowCounts {
  records: number;
  gpu_records: number;
  gpu_snapshots: number;
  ping_records: number;
  ping_snapshots: number;
  audit_logs: number;
  notification_deliveries: number;
}

export type HistoryTableRowCounts = Pick<
  TableRowCounts,
  'records' | 'gpu_records' | 'gpu_snapshots' | 'ping_records' | 'ping_snapshots'
>;

async function countTableRows(db: D1Database, table: keyof TableRowCounts): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count || 0);
}

export async function getStorageRowCounts(db: D1Database): Promise<TableRowCounts> {
  const [records, gpuRecords, gpuSnapshots, pingRecords, pingSnapshots, auditLogs, notificationDeliveries] = await Promise.all([
    countTableRows(db, 'records'),
    countTableRows(db, 'gpu_records'),
    countTableRows(db, 'gpu_snapshots'),
    countTableRows(db, 'ping_records'),
    countTableRows(db, 'ping_snapshots'),
    countTableRows(db, 'audit_logs'),
    countTableRows(db, 'notification_deliveries'),
  ]);
  return {
    records,
    gpu_records: gpuRecords,
    gpu_snapshots: gpuSnapshots,
    ping_records: pingRecords,
    ping_snapshots: pingSnapshots,
    audit_logs: auditLogs,
    notification_deliveries: notificationDeliveries,
  };
}

export async function getStorageRowCountsFast(db: D1Database): Promise<TableRowCounts> {
  const [historyCounts, auditLogs, notificationDeliveries] = await Promise.all([
    getHistoryStorageRowCountsFast(db),
    countTableRows(db, 'audit_logs'),
    countTableRows(db, 'notification_deliveries'),
  ]);
  return {
    ...historyCounts,
    audit_logs: auditLogs,
    notification_deliveries: notificationDeliveries,
  };
}

/**
 * 快速获取历史表行数（使用增量计数表）
 *
 * 性能优化：从 COUNT(*) 全表扫描（每次读取所有行）
 *          优化为单表查询（5行）
 *
 * 在 100 节点、72h 保留场景下：
 * - 修复前: 每次检查读取 ~157,680 行，blocked 模式下 227M reads/天
 * - 修复后: 每次检查读取 5 行，blocked 模式下 ~7,200 reads/天
 * - 节省: 99.997% 配额
 */
export async function getHistoryStorageRowCountsFast(db: D1Database): Promise<HistoryTableRowCounts> {
  const tables = ['records', 'gpu_records', 'gpu_snapshots', 'ping_records', 'ping_snapshots'] as const;
  const rows = await db.prepare(
    'SELECT table_name, row_count FROM history_row_counters WHERE table_name IN (?, ?, ?, ?, ?)'
  )
    .bind(...tables)
    .all<{ table_name: string; row_count: number }>();

  const countsMap = new Map(rows.results.map(r => [r.table_name, r.row_count]));
  if (tables.some(table => !countsMap.has(table))) {
    const counts = await getHistoryStorageRowCounts(db);
    const stmt = db.prepare(`
      INSERT INTO history_row_counters (table_name, row_count, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(table_name) DO UPDATE SET
        row_count = excluded.row_count,
        updated_at = excluded.updated_at
    `);
    await runD1Batch(db, 'updateHistoryRowCounters', tables.map(table => stmt.bind(table, counts[table])));
    return counts;
  }

  return {
    records: countsMap.get('records') || 0,
    gpu_records: countsMap.get('gpu_records') || 0,
    gpu_snapshots: countsMap.get('gpu_snapshots') || 0,
    ping_records: countsMap.get('ping_records') || 0,
    ping_snapshots: countsMap.get('ping_snapshots') || 0,
  };
}

/**
 * 获取历史表行数（使用 COUNT(*) 全表扫描）
 *
 * ⚠️ 警告：此函数在大规模场景下性能较差
 * 建议使用 getHistoryStorageRowCountsFast() 替代
 *
 * 保留此函数用于：
 * 1. 迁移后验证计数准确性
 * 2. 手动修复计数偏差
 */
export async function getHistoryStorageRowCounts(db: D1Database): Promise<HistoryTableRowCounts> {
  const [records, gpuRecords, gpuSnapshots, pingRecords, pingSnapshots] = await Promise.all([
    countTableRows(db, 'records'),
    countTableRows(db, 'gpu_records'),
    countTableRows(db, 'gpu_snapshots'),
    countTableRows(db, 'ping_records'),
    countTableRows(db, 'ping_snapshots'),
  ]);
  return {
    records,
    gpu_records: gpuRecords,
    gpu_snapshots: gpuSnapshots,
    ping_records: pingRecords,
    ping_snapshots: pingSnapshots,
  };
}

async function countExpiredRows(
  db: D1Database,
  table: keyof TableRowCounts,
  beforeTime: string,
  timeColumn = 'time',
): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${timeColumn} < ?`)
    .bind(beforeTime)
    .first<{ count: number }>();
  return Number(row?.count || 0);
}

export async function getExpiredRowCounts(
  db: D1Database,
  beforeTimes: { records: string; ping_records: string; audit_logs: string; notification_deliveries?: string },
): Promise<TableRowCounts> {
  const notificationDeliveriesBefore = beforeTimes.notification_deliveries || beforeTimes.audit_logs;
  const [records, gpuRecords, gpuSnapshots, pingRecords, pingSnapshots, auditLogs, notificationDeliveries] = await Promise.all([
    countExpiredRows(db, 'records', beforeTimes.records),
    countExpiredRows(db, 'gpu_records', beforeTimes.records),
    countExpiredRows(db, 'gpu_snapshots', beforeTimes.records),
    countExpiredRows(db, 'ping_records', beforeTimes.ping_records),
    countExpiredRows(db, 'ping_snapshots', beforeTimes.ping_records),
    countExpiredRows(db, 'audit_logs', beforeTimes.audit_logs),
    countExpiredRows(db, 'notification_deliveries', notificationDeliveriesBefore, 'attempted_at'),
  ]);
  return {
    records,
    gpu_records: gpuRecords,
    gpu_snapshots: gpuSnapshots,
    ping_records: pingRecords,
    ping_snapshots: pingSnapshots,
    audit_logs: auditLogs,
    notification_deliveries: notificationDeliveries,
  };
}
