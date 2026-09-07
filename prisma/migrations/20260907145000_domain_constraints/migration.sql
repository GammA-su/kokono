-- Prisma does not express CHECK constraints or append-only/cycle triggers.
-- Keep these in migration history; db push is not a substitute for migrations.

ALTER TABLE lineups
  ADD CONSTRAINT lineup_release_date_precision CHECK (
    (release_date IS NULL AND release_date_precision IS NULL) OR
    (release_date IS NOT NULL AND release_date_precision IS NOT NULL AND
      release_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND
      CASE release_date_precision
        WHEN 'YEAR' THEN EXTRACT(MONTH FROM release_date) = 1 AND EXTRACT(DAY FROM release_date) = 1
        WHEN 'MONTH' THEN EXTRACT(DAY FROM release_date) = 1
        WHEN 'DAY' THEN TRUE END)
  ),
  ADD CONSTRAINT lineup_announced_date_precision CHECK (
    (announced_date IS NULL AND announced_date_precision IS NULL) OR
    (announced_date IS NOT NULL AND announced_date_precision IS NOT NULL AND
      announced_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND
      CASE announced_date_precision
        WHEN 'YEAR' THEN EXTRACT(MONTH FROM announced_date) = 1 AND EXTRACT(DAY FROM announced_date) = 1
        WHEN 'MONTH' THEN EXTRACT(DAY FROM announced_date) = 1
        WHEN 'DAY' THEN TRUE END)
  );

ALTER TABLE merchandise_items
  ADD CONSTRAINT item_msrp_money CHECK (
    (official_msrp_amount IS NULL AND official_msrp_currency IS NULL AND official_msrp_tax_inclusion = 'UNKNOWN') OR
    (official_msrp_amount IS NOT NULL AND official_msrp_amount >= 0 AND
     official_msrp_currency IS NOT NULL AND official_msrp_currency ~ '^[A-Z]{3}$')
  ),
  ADD CONSTRAINT item_sku_not_blank CHECK (length(btrim(internal_sku)) > 0);

ALTER TABLE purchase_watches
  ADD CONSTRAINT watch_quantity_positive CHECK (target_quantity IS NULL OR target_quantity > 0),
  ADD CONSTRAINT watch_price_nonnegative CHECK (max_unit_price_amount IS NULL OR max_unit_price_amount >= 0),
  ADD CONSTRAINT watch_currency_format CHECK (max_unit_price_currency ~ '^[A-Z]{3}$');

ALTER TABLE item_images ADD CONSTRAINT image_order_nonnegative CHECK (display_order >= 0);
ALTER TABLE inventory_balances ADD CONSTRAINT inventory_quantity_nonnegative CHECK (quantity >= 0);
ALTER TABLE storage_locations
  ADD CONSTRAINT location_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
  ADD CONSTRAINT transit_not_fulfillable CHECK (type <> 'IN_TRANSIT' OR NOT fulfillment_enabled);
ALTER TABLE categories ADD CONSTRAINT category_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id);

ALTER TABLE inventory_movements
  ADD CONSTRAINT movement_nonzero_quantity CHECK (quantity_delta <> 0 AND quantity_delta > -2147483648),
  ADD CONSTRAINT movement_location_shape CHECK (
    (movement_type = 'TRANSFER' AND quantity_delta > 0 AND source_location_id IS NOT NULL AND
     destination_location_id IS NOT NULL AND source_location_id <> destination_location_id) OR
    (movement_type <> 'TRANSFER' AND (
      (quantity_delta > 0 AND source_location_id IS NULL AND destination_location_id IS NOT NULL) OR
      (quantity_delta < 0 AND source_location_id IS NOT NULL AND destination_location_id IS NULL)))
  ),
  ADD CONSTRAINT movement_type_direction CHECK (
    (movement_type NOT IN ('PURCHASE', 'GACHA') OR quantity_delta > 0) AND
    (movement_type NOT IN ('SALE', 'DAMAGED', 'LOST') OR quantity_delta < 0)
  ),
  ADD CONSTRAINT movement_cost_money CHECK (
    (acquisition_unit_cost_amount IS NULL AND acquisition_unit_cost_currency IS NULL) OR
    (acquisition_unit_cost_amount IS NOT NULL AND acquisition_unit_cost_amount >= 0 AND
     acquisition_unit_cost_currency IS NOT NULL AND acquisition_unit_cost_currency ~ '^[A-Z]{3}$')
  ),
  ADD CONSTRAINT movement_reference_pair CHECK (
    (reference_type IS NULL AND reference_id IS NULL) OR
    (reference_type IS NOT NULL AND reference_id IS NOT NULL AND length(btrim(reference_type)) > 0 AND length(btrim(reference_id)) > 0)
  ),
  ADD CONSTRAINT movement_adjustment_explained CHECK (
    movement_type <> 'ADJUSTMENT' OR (notes IS NOT NULL AND length(btrim(notes)) > 0)
  ),
  ADD CONSTRAINT movement_operation_key_not_blank CHECK (length(btrim(operation_key)) > 0),
  ADD CONSTRAINT movement_fingerprint_format CHECK (request_fingerprint ~ '^[0-9a-f]{64}$');

ALTER TABLE sale_listings
  ADD CONSTRAINT listing_price_nonnegative CHECK (selling_price_amount >= 0),
  ADD CONSTRAINT listing_currency_format CHECK (selling_price_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT listing_publication_timestamp CHECK (NOT published OR published_at IS NOT NULL);

CREATE FUNCTION reject_inventory_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Inventory history is immutable; append a compensating movement instead.' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER immutable_inventory_movement
BEFORE UPDATE OR DELETE ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION reject_inventory_history_mutation();

CREATE TRIGGER immutable_inventory_movement_truncate
BEFORE TRUNCATE ON inventory_movements
FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_history_mutation();

-- Serialize tree edits before acquiring row locks; cycle checks use the current tree.
CREATE FUNCTION lock_hierarchy_edit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ':hierarchy', 0));
  RETURN NULL;
END;
$$;

CREATE FUNCTION reject_hierarchy_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE creates_cycle boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  EXECUTE format(
    'WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM %I.%I WHERE id = $1
       UNION
       SELECT parent.id, parent.parent_id FROM %I.%I parent JOIN ancestors ON parent.id = ancestors.parent_id
     ) SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME
  ) INTO creates_cycle USING NEW.parent_id, NEW.id;
  IF creates_cycle THEN
    RAISE EXCEPTION 'Hierarchy cannot contain a cycle.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lock_location_hierarchy BEFORE INSERT OR UPDATE OR DELETE ON storage_locations
FOR EACH STATEMENT EXECUTE FUNCTION lock_hierarchy_edit();
CREATE TRIGGER location_hierarchy_acyclic BEFORE INSERT OR UPDATE OF parent_id ON storage_locations
FOR EACH ROW EXECUTE FUNCTION reject_hierarchy_cycle();
CREATE TRIGGER lock_category_hierarchy BEFORE INSERT OR UPDATE OR DELETE ON categories
FOR EACH STATEMENT EXECUTE FUNCTION lock_hierarchy_edit();
CREATE TRIGGER category_hierarchy_acyclic BEFORE INSERT OR UPDATE OF parent_id ON categories
FOR EACH ROW EXECUTE FUNCTION reject_hierarchy_cycle();
