-- SB-2: Add partial index on token_hash for faster authentication queries
-- Only index non-empty token_hash values (migrated clients)
-- This speeds up: WHERE token_hash = ? (new auth path)
-- while avoiding index overhead for unmigrated clients

CREATE INDEX IF NOT EXISTS idx_clients_token_hash_nonempty
ON clients(token_hash)
WHERE token_hash IS NOT NULL AND token_hash != '';

-- After migration completes and all clients have token_hash,
-- the authentication query can be simplified to:
-- SELECT uuid FROM clients WHERE token_hash = ?
-- (remove the OR clause for token)
