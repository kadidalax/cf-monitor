-- Migration 023: remember each client's latest advertised report interval.

ALTER TABLE clients ADD COLUMN last_report_interval_sec INTEGER;

INSERT OR REPLACE INTO settings (key, value)
  VALUES ('schema_bootstrap_version', '2026-06-13-client-report-interval-v1');
