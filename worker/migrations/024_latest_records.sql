CREATE TABLE IF NOT EXISTS latest_records (
  client TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  cpu REAL DEFAULT 0,
  gpu REAL DEFAULT 0,
  ram INTEGER DEFAULT 0,
  ram_total INTEGER DEFAULT 0,
  swap INTEGER DEFAULT 0,
  swap_total INTEGER DEFAULT 0,
  load REAL DEFAULT 0,
  temp REAL DEFAULT 0,
  disk INTEGER DEFAULT 0,
  disk_total INTEGER DEFAULT 0,
  net_in INTEGER DEFAULT 0,
  net_out INTEGER DEFAULT 0,
  net_total_up INTEGER DEFAULT 0,
  net_total_down INTEGER DEFAULT 0,
  process_count INTEGER DEFAULT 0,
  connections INTEGER DEFAULT 0,
  connections_udp INTEGER DEFAULT 0,
  uptime INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_latest_records_time ON latest_records(time);

INSERT OR REPLACE INTO latest_records (
  client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
  disk, disk_total, net_in, net_out, net_total_up, net_total_down,
  process_count, connections, connections_udp, uptime
)
SELECT
  r.client, r.time, r.cpu, r.gpu, r.ram, r.ram_total, r.swap, r.swap_total, r.load, r.temp,
  r.disk, r.disk_total, r.net_in, r.net_out, r.net_total_up, r.net_total_down,
  r.process_count, r.connections, r.connections_udp, r.uptime
FROM records r
INNER JOIN (
  SELECT client, MAX(time) AS time
  FROM records
  GROUP BY client
) latest
  ON r.client = latest.client AND r.time = latest.time;

CREATE TRIGGER IF NOT EXISTS trg_records_latest_insert
AFTER INSERT ON records
BEGIN
  DELETE FROM latest_records
  WHERE client = NEW.client AND time <= NEW.time;

  INSERT OR IGNORE INTO latest_records (
    client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
    disk, disk_total, net_in, net_out, net_total_up, net_total_down,
    process_count, connections, connections_udp, uptime
  ) VALUES (
    NEW.client, NEW.time, NEW.cpu, NEW.gpu, NEW.ram, NEW.ram_total, NEW.swap, NEW.swap_total, NEW.load, NEW.temp,
    NEW.disk, NEW.disk_total, NEW.net_in, NEW.net_out, NEW.net_total_up, NEW.net_total_down,
    NEW.process_count, NEW.connections, NEW.connections_udp, NEW.uptime
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_records_latest_delete
AFTER DELETE ON records
BEGIN
  DELETE FROM latest_records
  WHERE client = OLD.client AND time = OLD.time;

  INSERT OR IGNORE INTO latest_records (
    client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
    disk, disk_total, net_in, net_out, net_total_up, net_total_down,
    process_count, connections, connections_udp, uptime
  )
  SELECT
    r.client, r.time, r.cpu, r.gpu, r.ram, r.ram_total, r.swap, r.swap_total, r.load, r.temp,
    r.disk, r.disk_total, r.net_in, r.net_out, r.net_total_up, r.net_total_down,
    r.process_count, r.connections, r.connections_udp, r.uptime
  FROM records r
  WHERE r.client = OLD.client
  ORDER BY r.time DESC
  LIMIT 1;
END;

INSERT OR REPLACE INTO settings (key, value)
  VALUES ('schema_bootstrap_version', '2026-06-14-latest-records-v1');
