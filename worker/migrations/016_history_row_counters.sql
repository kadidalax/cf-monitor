-- Migration 016: 添加增量行计数表，优化容量检查性能
--
-- 问题: canPersistWithinCapacity() 使用 COUNT(*) 全表扫描，
--       在大规模场景下每天可能消耗数百万次 D1 读取配额
--
-- 解决方案: 使用增量计数表，写入时 +1，删除时 -N
--          容量检查从全表扫描变为单表查询（5行）
--
-- 性能提升: 100 节点场景下，从 227M reads/天 降低到 1440 reads/天

-- 创建计数表
CREATE TABLE IF NOT EXISTS history_row_counters (
  table_name TEXT PRIMARY KEY,
  row_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 初始化计数（从现有表统计）
INSERT OR REPLACE INTO history_row_counters (table_name, row_count, updated_at)
VALUES
  ('records', (SELECT COUNT(*) FROM records), datetime('now')),
  ('gpu_records', (SELECT COUNT(*) FROM gpu_records), datetime('now')),
  ('gpu_snapshots', (SELECT COUNT(*) FROM gpu_snapshots), datetime('now')),
  ('ping_records', (SELECT COUNT(*) FROM ping_records), datetime('now')),
  ('ping_snapshots', (SELECT COUNT(*) FROM ping_snapshots), datetime('now'));

-- 创建触发器：写入时自动 +1
CREATE TRIGGER IF NOT EXISTS trg_records_insert
AFTER INSERT ON records
BEGIN
  UPDATE history_row_counters
  SET row_count = row_count + 1, updated_at = datetime('now')
  WHERE table_name = 'records';
END;

CREATE TRIGGER IF NOT EXISTS trg_gpu_records_insert
AFTER INSERT ON gpu_records
BEGIN
  UPDATE history_row_counters
  SET row_count = row_count + 1, updated_at = datetime('now')
  WHERE table_name = 'gpu_records';
END;

CREATE TRIGGER IF NOT EXISTS trg_gpu_snapshots_insert
AFTER INSERT ON gpu_snapshots
BEGIN
  UPDATE history_row_counters
  SET row_count = row_count + 1, updated_at = datetime('now')
  WHERE table_name = 'gpu_snapshots';
END;

CREATE TRIGGER IF NOT EXISTS trg_ping_records_insert
AFTER INSERT ON ping_records
BEGIN
  UPDATE history_row_counters
  SET row_count = row_count + 1, updated_at = datetime('now')
  WHERE table_name = 'ping_records';
END;

CREATE TRIGGER IF NOT EXISTS trg_ping_snapshots_insert
AFTER INSERT ON ping_snapshots
BEGIN
  UPDATE history_row_counters
  SET row_count = row_count + 1, updated_at = datetime('now')
  WHERE table_name = 'ping_snapshots';
END;

-- 创建触发器：删除时自动 -1
CREATE TRIGGER IF NOT EXISTS trg_records_delete
AFTER DELETE ON records
BEGIN
  UPDATE history_row_counters
  SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
  WHERE table_name = 'records';
END;

CREATE TRIGGER IF NOT EXISTS trg_gpu_records_delete
AFTER DELETE ON gpu_records
BEGIN
  UPDATE history_row_counters
  SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
  WHERE table_name = 'gpu_records';
END;

CREATE TRIGGER IF NOT EXISTS trg_gpu_snapshots_delete
AFTER DELETE ON gpu_snapshots
BEGIN
  UPDATE history_row_counters
  SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
  WHERE table_name = 'gpu_snapshots';
END;

CREATE TRIGGER IF NOT EXISTS trg_ping_records_delete
AFTER DELETE ON ping_records
BEGIN
  UPDATE history_row_counters
  SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
  WHERE table_name = 'ping_records';
END;

CREATE TRIGGER IF NOT EXISTS trg_ping_snapshots_delete
AFTER DELETE ON ping_snapshots
BEGIN
  UPDATE history_row_counters
  SET row_count = MAX(row_count - 1, 0), updated_at = datetime('now')
  WHERE table_name = 'ping_snapshots';
END;
