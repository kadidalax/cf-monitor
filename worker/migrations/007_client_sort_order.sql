-- Add persistent manual ordering for admin client rows.
ALTER TABLE clients ADD COLUMN sort_order INTEGER DEFAULT 0;

UPDATE clients
SET sort_order = rowid
WHERE sort_order IS NULL OR sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_clients_sort_order ON clients(sort_order, name);
