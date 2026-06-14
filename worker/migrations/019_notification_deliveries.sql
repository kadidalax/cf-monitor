-- Migration 019: notification delivery event log.

CREATE TABLE IF NOT EXISTS notification_deliveries (
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
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_attempted_at
  ON notification_deliveries(attempted_at);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_type_time
  ON notification_deliveries(notification_type, attempted_at);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_client_time
  ON notification_deliveries(client, attempted_at);

INSERT OR REPLACE INTO settings (key, value)
  VALUES ('schema_bootstrap_version', '2026-06-13-notification-deliveries-v1');
