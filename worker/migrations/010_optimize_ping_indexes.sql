DROP INDEX IF EXISTS idx_ping_records_client_time;
DROP INDEX IF EXISTS idx_ping_records_task;
CREATE INDEX IF NOT EXISTS idx_ping_records_client_task_time ON ping_records(client, task_id, time);
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_bootstrap_version', '2026-06-09-d1-quota-v1');
