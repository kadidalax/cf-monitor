CREATE TABLE IF NOT EXISTS gpu_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    devices_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_client_time ON gpu_snapshots(client, time);
CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_time ON gpu_snapshots(time);

