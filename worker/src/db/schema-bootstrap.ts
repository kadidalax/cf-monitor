import {
  hashAgentToken,
  isTokenHash,
  readStoredTokenHash,
  storedTokenHash,
  tokenPrefix,
} from '../utils/agent-token';

const SCHEMA_BOOTSTRAP_VERSION = '2026-06-13-client-report-interval-v1';
const SCHEMA_BOOTSTRAP_KEY = 'schema_bootstrap_version';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS clients (
    uuid TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    token_hash TEXT,
    token_prefix TEXT,
    name TEXT DEFAULT '',
    cpu_name TEXT DEFAULT '',
    virtualization TEXT DEFAULT '',
    arch TEXT DEFAULT '',
    cpu_cores INTEGER DEFAULT 0,
    os TEXT DEFAULT '',
    kernel_version TEXT DEFAULT '',
    gpu_name TEXT DEFAULT '',
    ipv4 TEXT DEFAULT '',
    ipv6 TEXT DEFAULT '',
    region TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    public_remark TEXT DEFAULT '',
    mem_total INTEGER DEFAULT 0,
    swap_total INTEGER DEFAULT 0,
    disk_total INTEGER DEFAULT 0,
    version TEXT DEFAULT '',
    price REAL DEFAULT 0.0,
    billing_cycle INTEGER DEFAULT 0,
    auto_renewal INTEGER DEFAULT 0,
    currency TEXT DEFAULT '$',
    expired_at TEXT,
    "group" TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    hidden INTEGER DEFAULT 0,
    traffic_limit INTEGER DEFAULT 0,
    traffic_limit_type TEXT DEFAULT 'max',
    last_seen_at TEXT,
    last_report_source TEXT DEFAULT '',
    last_report_persisted_at TEXT,
    last_report_interval_sec INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_token_hash ON clients(token_hash)`,
  `CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    cpu REAL DEFAULT 0,
    gpu REAL DEFAULT 0,
    ram INTEGER DEFAULT 0,
    ram_total INTEGER DEFAULT 0,
    swap INTEGER DEFAULT 0,
    swap_total INTEGER DEFAULT 0,
    load REAL DEFAULT 0,
    temp REAL DEFAULT 0,
    disk INTEGER DEFAULT 0,
    disk_total INTEGER DEFAULT 0,
    net_in INTEGER DEFAULT 0,
    net_out INTEGER DEFAULT 0,
    net_total_up INTEGER DEFAULT 0,
    net_total_down INTEGER DEFAULT 0,
    process_count INTEGER DEFAULT 0,
    connections INTEGER DEFAULT 0,
    connections_udp INTEGER DEFAULT 0,
    uptime INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_records_client_time ON records(client, time)`,
  `CREATE INDEX IF NOT EXISTS idx_records_time ON records(time)`,
  `CREATE TABLE IF NOT EXISTS gpu_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    device_index INTEGER DEFAULT 0,
    device_name TEXT DEFAULT '',
    mem_total INTEGER DEFAULT 0,
    mem_used INTEGER DEFAULT 0,
    utilization REAL DEFAULT 0,
    temperature INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gpu_records_client_time ON gpu_records(client, time)`,
  `CREATE INDEX IF NOT EXISTS idx_gpu_records_time ON gpu_records(time)`,
  `CREATE TABLE IF NOT EXISTS gpu_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    devices_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_client_time ON gpu_snapshots(client, time)`,
  `CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_time ON gpu_snapshots(time)`,
  `CREATE TABLE IF NOT EXISTS users (
    uuid TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwd TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS login_rate_limits (
    bucket TEXT PRIMARY KEY,
    failures INTEGER DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL,
    locked_until TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_rate_limits_last_failed ON login_rate_limits(last_failed_at)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ping_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    clients TEXT DEFAULT '[]',
    all_clients INTEGER DEFAULT 0,
    type TEXT DEFAULT 'icmp',
    target TEXT NOT NULL,
    interval_sec INTEGER DEFAULT 60
  )`,
  `CREATE TABLE IF NOT EXISTS ping_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    time TEXT NOT NULL,
    value INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ping_records_client_task_time ON ping_records(client, task_id, time)`,
  `CREATE INDEX IF NOT EXISTS idx_ping_records_time ON ping_records(time)`,
  `CREATE TABLE IF NOT EXISTS ping_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    values_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ping_snapshots_client_time ON ping_snapshots(client, time)`,
  `CREATE INDEX IF NOT EXISTS idx_ping_snapshots_time ON ping_snapshots(time)`,
  `CREATE TABLE IF NOT EXISTS history_row_counters (
    table_name TEXT PRIMARY KEY,
    row_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `INSERT OR REPLACE INTO history_row_counters (table_name, row_count, updated_at)
    VALUES
      ('records', (SELECT COUNT(*) FROM records), datetime('now')),
      ('gpu_records', (SELECT COUNT(*) FROM gpu_records), datetime('now')),
      ('gpu_snapshots', (SELECT COUNT(*) FROM gpu_snapshots), datetime('now')),
      ('ping_records', (SELECT COUNT(*) FROM ping_records), datetime('now')),
      ('ping_snapshots', (SELECT COUNT(*) FROM ping_snapshots), datetime('now'))`,
  `CREATE TRIGGER IF NOT EXISTS trg_records_insert
    AFTER INSERT ON records
    BEGIN
      UPDATE history_row_counters
      SET row_count = row_count + 1, updated_at = datetime('now')
      WHERE table_name = 'records';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_gpu_records_insert
    AFTER INSERT ON gpu_records
    BEGIN
      UPDATE history_row_counters
      SET row_count = row_count + 1, updated_at = datetime('now')
      WHERE table_name = 'gpu_records';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_gpu_snapshots_insert
    AFTER INSERT ON gpu_snapshots
    BEGIN
      UPDATE history_row_counters
      SET row_count = row_count + 1, updated_at = datetime('now')
      WHERE table_name = 'gpu_snapshots';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_ping_records_insert
    AFTER INSERT ON ping_records
    BEGIN
      UPDATE history_row_counters
      SET row_count = row_count + 1, updated_at = datetime('now')
      WHERE table_name = 'ping_records';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_ping_snapshots_insert
    AFTER INSERT ON ping_snapshots
    BEGIN
      UPDATE history_row_counters
      SET row_count = row_count + 1, updated_at = datetime('now')
      WHERE table_name = 'ping_snapshots';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_records_delete
    AFTER DELETE ON records
    BEGIN
      UPDATE history_row_counters
      SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
      WHERE table_name = 'records';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_gpu_records_delete
    AFTER DELETE ON gpu_records
    BEGIN
      UPDATE history_row_counters
      SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
      WHERE table_name = 'gpu_records';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_gpu_snapshots_delete
    AFTER DELETE ON gpu_snapshots
    BEGIN
      UPDATE history_row_counters
      SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
      WHERE table_name = 'gpu_snapshots';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_ping_records_delete
    AFTER DELETE ON ping_records
    BEGIN
      UPDATE history_row_counters
      SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
      WHERE table_name = 'ping_records';
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_ping_snapshots_delete
    AFTER DELETE ON ping_snapshots
    BEGIN
      UPDATE history_row_counters
      SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
      WHERE table_name = 'ping_snapshots';
    END`,
  `CREATE TABLE IF NOT EXISTS offline_notifications (
    client TEXT PRIMARY KEY,
    enable INTEGER DEFAULT 0,
    grace_period INTEGER DEFAULT 180,
    last_notified TEXT,
    last_attempt_at TEXT,
    last_sent_at TEXT,
    last_error TEXT,
    FOREIGN KEY (client) REFERENCES clients(uuid) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS expiry_notifications (
    client TEXT PRIMARY KEY,
    enable INTEGER DEFAULT 0,
    advance_days INTEGER DEFAULT 7,
    last_notified TEXT,
    last_attempt_at TEXT,
    last_sent_at TEXT,
    last_error TEXT,
    FOREIGN KEY (client) REFERENCES clients(uuid) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS load_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '',
    clients TEXT DEFAULT '[]',
    metric TEXT DEFAULT 'cpu',
    threshold REAL DEFAULT 80.0,
    ratio REAL DEFAULT 0.8,
    interval_min INTEGER DEFAULT 15,
    last_notified TEXT,
    last_attempt_at TEXT,
    last_sent_at TEXT,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_type TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram',
    status TEXT NOT NULL,
    target TEXT DEFAULT '',
    client TEXT,
    rule_id INTEGER,
    attempted_at TEXT NOT NULL,
    sent_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_attempted_at
    ON notification_deliveries(attempted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_type_time
    ON notification_deliveries(notification_type, attempted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_deliveries_client_time
    ON notification_deliveries(client, attempted_at)`,
  `CREATE TABLE IF NOT EXISTS notification_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_key TEXT NOT NULL UNIQUE,
    notification_type TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    client TEXT,
    rule_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    first_detected_at TEXT NOT NULL,
    last_detected_at TEXT NOT NULL,
    resolved_at TEXT,
    last_attempt_at TEXT,
    last_sent_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notification_incidents_status_type
    ON notification_incidents(status, notification_type)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_incidents_client
    ON notification_incidents(client, status)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_incidents_updated_at
    ON notification_incidents(updated_at)`,
  `CREATE TABLE IF NOT EXISTS notification_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_type TEXT NOT NULL,
    target TEXT NOT NULL,
    message TEXT NOT NULL,
    client TEXT,
    rule_id INTEGER,
    attempt_count INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    next_retry_at TEXT NOT NULL,
    last_attempt_at TEXT,
    last_error TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notification_queue_status_retry
    ON notification_queue(status, next_retry_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_queue_client
    ON notification_queue(client, status)`,
  `CREATE TABLE IF NOT EXISTS cron_health (
    component TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL,
    last_success_at TEXT,
    last_error TEXT,
    consecutive_failures INTEGER DEFAULT 0,
    total_runs INTEGER DEFAULT 0,
    total_failures INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS token_blacklist (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    revoked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires
    ON token_blacklist(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_token_blacklist_user
    ON token_blacklist(user_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS ip_change_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    old_ipv4 TEXT,
    new_ipv4 TEXT,
    old_ipv6 TEXT,
    new_ipv6 TEXT,
    changed_at TEXT NOT NULL,
    notified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ip_change_history_client
    ON ip_change_history(client_id, changed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ip_change_history_changed_at
    ON ip_change_history(changed_at)`,
  `CREATE TABLE IF NOT EXISTS load_check_states (
    client_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    consecutive_breaches INTEGER DEFAULT 0,
    last_check_at TEXT NOT NULL,
    last_breach_value REAL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (client_id, metric)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_load_check_states_updated
    ON load_check_states(updated_at)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    user TEXT DEFAULT '',
    action TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    level TEXT DEFAULT 'info'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(time)`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'CF Monitor')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('site_description', '服务器监控探针')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'zh-CN')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('public_privacy_mode', 'false')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_enabled', 'true')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_preserve_time', '72')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('ping_record_preserve_time', '72')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_persist_interval_sec', '60')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('ping_record_persist_interval_sec', '300')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_high_watermark_rows', '450000')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('capacity_daily_view_minutes', '60')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('audit_log_preserve_time', '2160')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_active_interval_sec', '3')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_idle_interval_sec', '600')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_active_max_duration_sec', '600')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('notification_method', 'telegram')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('telegram_bot_token', '')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('telegram_chat_id', '')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('enable_ip_change_notification', 'false')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_notify_never_reported', 'true')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('notification_silence_period_sec', '600')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('notification_max_per_client_daily', '10')`,
  `DELETE FROM settings
    WHERE key IN (
      'allow_cors',
      'private_site',
      'private_site_password',
      'tempory_share_token',
      'tempory_share_token_expire_at',
      'temporary_share_token',
      'temporary_share_token_expire_at',
      'custom_head',
      'custom_body',
      'custom_footer_html',
      'agent_auto_discovery_key'
    )`,
] as const;

const MAINTENANCE_STATEMENTS = [
  `DROP INDEX IF EXISTS idx_ping_records_client_time`,
  `DROP INDEX IF EXISTS idx_ping_records_task`,
  `DROP INDEX IF EXISTS idx_clients_token`,
  `DROP INDEX IF EXISTS idx_clients_group`,
] as const;

const COLUMN_MIGRATIONS = [
  `ALTER TABLE ping_tasks ADD COLUMN sort_order INTEGER DEFAULT 0`,
  `UPDATE ping_tasks SET sort_order = id WHERE sort_order IS NULL OR sort_order = 0`,
  `CREATE INDEX IF NOT EXISTS idx_ping_tasks_sort_order ON ping_tasks(sort_order, id)`,
  `ALTER TABLE clients ADD COLUMN sort_order INTEGER DEFAULT 0`,
  `UPDATE clients SET sort_order = rowid WHERE sort_order IS NULL OR sort_order = 0`,
  `CREATE INDEX IF NOT EXISTS idx_clients_sort_order ON clients(sort_order, name)`,
  `ALTER TABLE clients ADD COLUMN token_hash TEXT`,
  `ALTER TABLE clients ADD COLUMN token_prefix TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_token_hash ON clients(token_hash)`,
  `ALTER TABLE clients ADD COLUMN last_seen_at TEXT`,
  `ALTER TABLE clients ADD COLUMN last_report_source TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN last_report_persisted_at TEXT`,
  `ALTER TABLE clients ADD COLUMN last_report_interval_sec INTEGER`,
  `ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE offline_notifications ADD COLUMN last_attempt_at TEXT`,
  `ALTER TABLE offline_notifications ADD COLUMN last_sent_at TEXT`,
  `ALTER TABLE offline_notifications ADD COLUMN last_error TEXT`,
  `ALTER TABLE expiry_notifications ADD COLUMN last_attempt_at TEXT`,
  `ALTER TABLE expiry_notifications ADD COLUMN last_sent_at TEXT`,
  `ALTER TABLE expiry_notifications ADD COLUMN last_error TEXT`,
  `ALTER TABLE load_notifications ADD COLUMN last_attempt_at TEXT`,
  `ALTER TABLE load_notifications ADD COLUMN last_sent_at TEXT`,
  `ALTER TABLE load_notifications ADD COLUMN last_error TEXT`,
] as const;

const REQUIRED_BOOTSTRAP_TABLES = [
  'expiry_notifications',
  'history_row_counters',
  'notification_deliveries',
  'notification_incidents',
  'notification_queue',
  'cron_health',
  'token_blacklist',
  'ip_change_history',
  'load_check_states',
] as const;

const REQUIRED_BOOTSTRAP_COLUMNS: Record<string, readonly string[]> = {
  clients: ['token_hash', 'token_prefix', 'last_seen_at', 'last_report_source', 'last_report_persisted_at', 'last_report_interval_sec'],
  users: ['session_version'],
  offline_notifications: ['last_attempt_at', 'last_sent_at', 'last_error'],
  expiry_notifications: ['last_attempt_at', 'last_sent_at', 'last_error'],
  load_notifications: ['last_attempt_at', 'last_sent_at', 'last_error'],
  notification_deliveries: ['notification_type', 'channel', 'status', 'target', 'client', 'rule_id', 'attempted_at', 'sent_at', 'error', 'created_at'],
  notification_incidents: ['incident_key', 'notification_type', 'target', 'client', 'rule_id', 'status', 'first_detected_at', 'last_detected_at', 'resolved_at', 'last_attempt_at', 'last_sent_at', 'last_error', 'created_at', 'updated_at'],
};

const REQUIRED_BOOTSTRAP_TRIGGERS = [
  'trg_records_insert',
  'trg_gpu_records_insert',
  'trg_gpu_snapshots_insert',
  'trg_ping_records_insert',
  'trg_ping_snapshots_insert',
  'trg_records_delete',
  'trg_gpu_records_delete',
  'trg_gpu_snapshots_delete',
  'trg_ping_records_delete',
  'trg_ping_snapshots_delete',
] as const;

const REQUIRED_BOOTSTRAP_SETTINGS = [
  'offline_notify_never_reported',
  'public_privacy_mode',
] as const;

let schemaReady = false;
let schemaPromise: Promise<void> | null = null;

function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('duplicate column name') || message.includes('already exists');
}

async function runStatement(db: D1Database, statement: string): Promise<void> {
  await db.prepare(statement).run();
}

async function schemaHasRequiredBootstrapObjects(db: D1Database): Promise<boolean> {
  try {
    const tableRows = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_BOOTSTRAP_TABLES.map(() => '?').join(', ')})`,
    ).bind(...REQUIRED_BOOTSTRAP_TABLES).all<{ name: string }>();
    const existingTables = new Set((tableRows.results || []).map(row => row.name));
    if (REQUIRED_BOOTSTRAP_TABLES.some(table => !existingTables.has(table))) {
      return false;
    }

    for (const [table, columns] of Object.entries(REQUIRED_BOOTSTRAP_COLUMNS)) {
      const columnRows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const existingColumns = new Set((columnRows.results || []).map(row => row.name));
      if (columns.some(column => !existingColumns.has(column))) {
        return false;
      }
    }

    const triggerRows = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${REQUIRED_BOOTSTRAP_TRIGGERS.map(() => '?').join(', ')})`,
    ).bind(...REQUIRED_BOOTSTRAP_TRIGGERS).all<{ name: string }>();
    const existingTriggers = new Set((triggerRows.results || []).map(row => row.name));
    if (REQUIRED_BOOTSTRAP_TRIGGERS.some(trigger => !existingTriggers.has(trigger))) {
      return false;
    }

    const settingRows = await db.prepare(
      `SELECT key FROM settings WHERE key IN (${REQUIRED_BOOTSTRAP_SETTINGS.map(() => '?').join(', ')})`,
    ).bind(...REQUIRED_BOOTSTRAP_SETTINGS).all<{ key: string }>();
    const existingSettings = new Set((settingRows.results || []).map(row => row.key));
    return REQUIRED_BOOTSTRAP_SETTINGS.every(setting => existingSettings.has(setting));
  } catch {
    return false;
  }
}

async function schemaVersionMatches(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?')
      .bind(SCHEMA_BOOTSTRAP_KEY)
      .first<{ value: string }>();
    return row?.value === SCHEMA_BOOTSTRAP_VERSION && await schemaHasRequiredBootstrapObjects(db);
  } catch {
    return false;
  }
}

async function bootstrapSchema(db: D1Database): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await runStatement(db, statement);
  }

  for (const statement of MAINTENANCE_STATEMENTS) {
    await runStatement(db, statement);
  }

  for (const statement of COLUMN_MIGRATIONS) {
    try {
      await runStatement(db, statement);
    } catch (error) {
      if (/^\s*ALTER\s+TABLE/i.test(statement) && isDuplicateColumnError(error)) {
        continue;
      }
      throw error;
    }
  }

  await migrateStoredClientTokens(db);

  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind(SCHEMA_BOOTSTRAP_KEY, SCHEMA_BOOTSTRAP_VERSION)
    .run();
}

async function migrateStoredClientTokens(db: D1Database): Promise<void> {
  const rows = await db.prepare('SELECT uuid, token, token_hash, token_prefix FROM clients')
    .all<{ uuid: string; token: string; token_hash: string | null; token_prefix: string | null }>();
  const updates: D1PreparedStatement[] = [];
  const update = db.prepare(`
    UPDATE clients
    SET token = ?,
        token_hash = ?,
        token_prefix = ?,
        updated_at = datetime('now')
    WHERE uuid = ?
  `);

  for (const row of rows.results || []) {
    const hashFromToken = readStoredTokenHash(row.token);
    const tokenHash = isTokenHash(row.token_hash) ? row.token_hash : hashFromToken || await hashAgentToken(row.token);
    const storedToken = storedTokenHash(tokenHash);
    const prefix = row.token_prefix || (hashFromToken ? '' : tokenPrefix(row.token));
    if (row.token === storedToken && row.token_hash === tokenHash && row.token_prefix === prefix) {
      continue;
    }
    updates.push(update.bind(storedToken, tokenHash, prefix, row.uuid));
  }

  if (updates.length > 0) {
    await db.batch(updates);
  }
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      if (await schemaVersionMatches(db)) {
        schemaReady = true;
        return;
      }
      await bootstrapSchema(db);
    })()
      .then(() => {
        schemaReady = true;
      })
      .catch((error) => {
        schemaPromise = null;
        throw error;
      });
  }
  await schemaPromise;
}
