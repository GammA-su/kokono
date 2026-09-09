ALTER TABLE storage_locations ADD COLUMN country_code varchar(2);
ALTER TABLE storage_locations ADD CONSTRAINT location_country_code CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');
UPDATE storage_locations SET country_code = CASE type WHEN 'JAPAN_WAREHOUSE' THEN 'JP' WHEN 'FRANCE_HOME' THEN 'FR' END
WHERE type IN ('JAPAN_WAREHOUSE', 'FRANCE_HOME');
CREATE INDEX purchase_watch_checked_idx ON purchase_watches (enabled, last_checked_at, merchandise_item_id);
