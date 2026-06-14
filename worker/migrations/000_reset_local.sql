-- Reset local D1 tables before re-running the schema migrations and demo seed.
-- Intended for `npm run db:reset:local`; do not run against production data.
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS load_notifications;
DROP TABLE IF EXISTS expiry_notifications;
DROP TABLE IF EXISTS offline_notifications;
DROP TABLE IF EXISTS ping_snapshots;
DROP TABLE IF EXISTS ping_records;
DROP TABLE IF EXISTS ping_tasks;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS login_rate_limits;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS gpu_snapshots;
DROP TABLE IF EXISTS gpu_records;
DROP TABLE IF EXISTS records;
DROP TABLE IF EXISTS clients;
