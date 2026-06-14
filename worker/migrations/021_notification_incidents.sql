-- Migration 021: notification incident state tracking.

CREATE TABLE IF NOT EXISTS notification_incidents (
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
);

CREATE INDEX IF NOT EXISTS idx_notification_incidents_status_type
  ON notification_incidents(status, notification_type);

CREATE INDEX IF NOT EXISTS idx_notification_incidents_client
  ON notification_incidents(client, status);

CREATE INDEX IF NOT EXISTS idx_notification_incidents_updated_at
  ON notification_incidents(updated_at);

INSERT OR REPLACE INTO settings (key, value)
  VALUES ('schema_bootstrap_version', '2026-06-13-notification-incidents-v1');
