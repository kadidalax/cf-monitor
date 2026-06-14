-- Migration 018: store Agent tokens as hashes with a short display prefix.

ALTER TABLE clients ADD COLUMN token_hash TEXT;
ALTER TABLE clients ADD COLUMN token_prefix TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_token_hash ON clients(token_hash);

INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_bootstrap_version', '2026-06-13-token-hash-v1');
