INSERT OR IGNORE INTO settings (key, value) VALUES ('ping_record_persist_interval_sec', '300');
UPDATE settings SET value = '300' WHERE key = 'ping_record_persist_interval_sec' AND value = '600';
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_bootstrap_version', '2026-06-10-ping-unified-interval-v1');
