CREATE TABLE IF NOT EXISTS expiry_notifications (
    client TEXT PRIMARY KEY,
    enable INTEGER DEFAULT 0,
    advance_days INTEGER DEFAULT 7,
    last_notified TEXT,
    FOREIGN KEY (client) REFERENCES clients(uuid) ON DELETE CASCADE
);
