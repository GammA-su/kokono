-- Public listing eligibility re-evaluated the managed-media regex once per candidate row.
-- At 50k listings that regex alone measured ~1,491 ms of a ~2,200 ms page (EXPLAIN ANALYZE).
-- A partial index evaluates the pattern at write time instead, so reads only probe the index.
--
-- The predicate must stay byte-identical to `managedImagePattern.source` in
-- src/modules/publication/media.ts, otherwise PostgreSQL cannot prove the query
-- predicate implies the index predicate and silently falls back to per-row regex.
-- tests/publication.media-index.test.ts asserts that equality.
CREATE INDEX item_images_public_managed_idx
  ON item_images (merchandise_item_id, id)
  WHERE approved_for_public_use
    AND storage_key ~ '^admin-media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$';
