-- 查询与维护任务索引补强
-- 001_init.sql 已包含这些索引；此迁移用于已初始化过的本地或远程 D1。

CREATE INDEX IF NOT EXISTS idx_gpu_records_time ON gpu_records(time);
CREATE INDEX IF NOT EXISTS idx_ping_records_time ON ping_records(time);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(time);
