-- CF Monitor D1 数据库初始化迁移
-- 基于 komari 数据模型精简（移除 2FA、远程执行、主题管理、session管理、clipboard 等功能）

-- 服务器节点表
CREATE TABLE IF NOT EXISTS clients (
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
);

-- 资源监控记录表
CREATE TABLE IF NOT EXISTS records (
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
);

CREATE INDEX IF NOT EXISTS idx_records_client_time ON records(client, time);
CREATE INDEX IF NOT EXISTS idx_records_time ON records(time);

-- GPU 详细记录表
CREATE TABLE IF NOT EXISTS gpu_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    device_index INTEGER DEFAULT 0,
    device_name TEXT DEFAULT '',
    mem_total INTEGER DEFAULT 0,
    mem_used INTEGER DEFAULT 0,
    utilization REAL DEFAULT 0,
    temperature INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gpu_records_client_time ON gpu_records(client, time);
CREATE INDEX IF NOT EXISTS idx_gpu_records_time ON gpu_records(time);

CREATE TABLE IF NOT EXISTS gpu_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    devices_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_client_time ON gpu_snapshots(client, time);
CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_time ON gpu_snapshots(time);

-- 用户表（仅管理员）
CREATE TABLE IF NOT EXISTS users (
    uuid TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwd TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 登录失败限速状态
CREATE TABLE IF NOT EXISTS login_rate_limits (
    bucket TEXT PRIMARY KEY,
    failures INTEGER DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL,
    locked_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_rate_limits_last_failed ON login_rate_limits(last_failed_at);

-- 系统配置表（键值对存储）
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);

-- Ping 监测任务表
CREATE TABLE IF NOT EXISTS ping_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    clients TEXT DEFAULT '[]',
    all_clients INTEGER DEFAULT 0,
    type TEXT DEFAULT 'icmp',
    target TEXT NOT NULL,
    interval_sec INTEGER DEFAULT 60
);

-- Ping 监测记录表
CREATE TABLE IF NOT EXISTS ping_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    time TEXT NOT NULL,
    value INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ping_records_client_task_time ON ping_records(client, task_id, time);
CREATE INDEX IF NOT EXISTS idx_ping_records_time ON ping_records(time);

CREATE TABLE IF NOT EXISTS ping_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    values_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ping_snapshots_client_time ON ping_snapshots(client, time);
CREATE INDEX IF NOT EXISTS idx_ping_snapshots_time ON ping_snapshots(time);

-- 离线通知设置表
CREATE TABLE IF NOT EXISTS offline_notifications (
    client TEXT PRIMARY KEY,
    enable INTEGER DEFAULT 0,
    grace_period INTEGER DEFAULT 180,
    last_notified TEXT,
    FOREIGN KEY (client) REFERENCES clients(uuid) ON DELETE CASCADE
);

-- 到期通知设置表
CREATE TABLE IF NOT EXISTS expiry_notifications (
    client TEXT PRIMARY KEY,
    enable INTEGER DEFAULT 0,
    advance_days INTEGER DEFAULT 7,
    last_notified TEXT,
    FOREIGN KEY (client) REFERENCES clients(uuid) ON DELETE CASCADE
);

-- 负载通知规则表
CREATE TABLE IF NOT EXISTS load_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '',
    clients TEXT DEFAULT '[]',
    metric TEXT DEFAULT 'cpu',
    threshold REAL DEFAULT 80.0,
    ratio REAL DEFAULT 0.8,
    interval_min INTEGER DEFAULT 15,
    last_notified TEXT
);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    user TEXT DEFAULT '',
    action TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    level TEXT DEFAULT 'info'
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(time);

-- 插入默认系统配置
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'CF Monitor');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_description', '服务器监控探针');
INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'zh-CN');
INSERT OR IGNORE INTO settings (key, value) VALUES ('record_enabled', 'true');
INSERT OR IGNORE INTO settings (key, value) VALUES ('record_preserve_time', '72');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ping_record_preserve_time', '72');
INSERT OR IGNORE INTO settings (key, value) VALUES ('record_persist_interval_sec', '60');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ping_record_persist_interval_sec', '300');
INSERT OR IGNORE INTO settings (key, value) VALUES ('record_high_watermark_rows', '450000');
INSERT OR IGNORE INTO settings (key, value) VALUES ('capacity_daily_view_minutes', '60');
INSERT OR IGNORE INTO settings (key, value) VALUES ('audit_log_preserve_time', '2160');
INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_active_interval_sec', '3');
INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_idle_interval_sec', '600');
INSERT OR IGNORE INTO settings (key, value) VALUES ('live_poll_active_max_duration_sec', '600');
INSERT OR IGNORE INTO settings (key, value) VALUES ('notification_method', 'telegram');
INSERT OR IGNORE INTO settings (key, value) VALUES ('telegram_bot_token', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('telegram_chat_id', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('enable_ip_change_notification', 'false');
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_bootstrap_version', '2026-06-09-runtime-intervals-v2');
