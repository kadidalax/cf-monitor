-- Migration 017: last seen source, admin session version, and notification delivery state

ALTER TABLE clients ADD COLUMN last_seen_at TEXT;
ALTER TABLE clients ADD COLUMN last_report_source TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN last_report_persisted_at TEXT;

ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE offline_notifications ADD COLUMN last_attempt_at TEXT;
ALTER TABLE offline_notifications ADD COLUMN last_sent_at TEXT;
ALTER TABLE offline_notifications ADD COLUMN last_error TEXT;

ALTER TABLE expiry_notifications ADD COLUMN last_attempt_at TEXT;
ALTER TABLE expiry_notifications ADD COLUMN last_sent_at TEXT;
ALTER TABLE expiry_notifications ADD COLUMN last_error TEXT;

ALTER TABLE load_notifications ADD COLUMN last_attempt_at TEXT;
ALTER TABLE load_notifications ADD COLUMN last_sent_at TEXT;
ALTER TABLE load_notifications ADD COLUMN last_error TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_notify_never_reported', 'true');
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_bootstrap_version', '2026-06-13-security-last-seen-v1');
