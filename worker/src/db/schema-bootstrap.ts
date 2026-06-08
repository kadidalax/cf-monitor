const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS clients (
    uuid TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clients_token ON clients(token)`,
  `CREATE INDEX IF NOT EXISTS idx_clients_group ON clients("group")`,
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
  `CREATE TABLE IF NOT EXISTS users (
    uuid TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwd TEXT NOT NULL,
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
  `CREATE INDEX IF NOT EXISTS idx_ping_records_client_time ON ping_records(client, time)`,
  `CREATE INDEX IF NOT EXISTS idx_ping_records_task ON ping_records(task_id, time)`,
  `CREATE INDEX IF NOT EXISTS idx_ping_records_time ON ping_records(time)`,
  `CREATE TABLE IF NOT EXISTS offline_notifications (
    client TEXT PRIMARY KEY,
    enable INTEGER DEFAULT 0,
    grace_period INTEGER DEFAULT 180,
    last_notified TEXT,
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
    last_notified TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT DEFAULT (datetime('now')),
    user TEXT DEFAULT '',
    action TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    level TEXT DEFAULT 'info'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(time)`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'CF Monitor')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('site_description', '服务器监控探针')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'zh-CN')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_enabled', 'true')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_preserve_time', '72')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('ping_record_preserve_time', '72')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_persist_interval_sec', '60')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('record_high_watermark_rows', '450000')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('capacity_daily_view_minutes', '60')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_active_interval_sec', '3')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_idle_interval_sec', '600')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_active_max_duration_sec', '600')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('notification_method', 'telegram')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('telegram_bot_token', '')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('telegram_chat_id', '')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('enable_ip_change_notification', 'false')`,
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

const COLUMN_MIGRATIONS = [
  `ALTER TABLE ping_tasks ADD COLUMN sort_order INTEGER DEFAULT 0`,
  `UPDATE ping_tasks SET sort_order = id WHERE sort_order IS NULL OR sort_order = 0`,
  `CREATE INDEX IF NOT EXISTS idx_ping_tasks_sort_order ON ping_tasks(sort_order, id)`,
  `ALTER TABLE clients ADD COLUMN sort_order INTEGER DEFAULT 0`,
  `UPDATE clients SET sort_order = rowid WHERE sort_order IS NULL OR sort_order = 0`,
  `CREATE INDEX IF NOT EXISTS idx_clients_sort_order ON clients(sort_order, name)`,
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

async function bootstrapSchema(db: D1Database): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
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
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  if (!schemaPromise) {
    schemaPromise = bootstrapSchema(db)
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
