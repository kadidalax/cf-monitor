-- Explicit Ping task ordering for admin UI, Agent task delivery, and backups.
ALTER TABLE ping_tasks ADD COLUMN sort_order INTEGER DEFAULT 0;

UPDATE ping_tasks
SET sort_order = id
WHERE sort_order IS NULL OR sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_ping_tasks_sort_order ON ping_tasks(sort_order, id);
