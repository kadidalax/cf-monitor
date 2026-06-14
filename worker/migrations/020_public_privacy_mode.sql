-- Migration 020: optional public metadata privacy mode.

INSERT OR IGNORE INTO settings (key, value)
  VALUES ('public_privacy_mode', 'false');

INSERT OR REPLACE INTO settings (key, value)
  VALUES ('schema_bootstrap_version', '2026-06-13-public-privacy-mode-v1');
