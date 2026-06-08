-- Add a D1 history write high-watermark so live monitoring can keep working
-- even when historical rows are close to the configured safety limit.
INSERT OR IGNORE INTO settings (key, value) VALUES ('record_high_watermark_rows', '450000');
