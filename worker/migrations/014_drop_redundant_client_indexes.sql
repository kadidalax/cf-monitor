DROP INDEX IF EXISTS idx_clients_token;
DROP INDEX IF EXISTS idx_clients_group;
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_bootstrap_version', '2026-06-09-client-index-prune-v1');
