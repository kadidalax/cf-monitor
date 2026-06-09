CREATE TABLE IF NOT EXISTS ping_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    values_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ping_snapshots_client_time ON ping_snapshots(client, time);
CREATE INDEX IF NOT EXISTS idx_ping_snapshots_time ON ping_snapshots(time);

