-- GACHA now records both acquisitions (+) and issued physical prizes (-).
-- Existing positive records and immutable history remain unchanged.
ALTER TABLE inventory_movements DROP CONSTRAINT movement_type_direction;
ALTER TABLE inventory_movements ADD CONSTRAINT movement_type_direction CHECK (
  (movement_type <> 'PURCHASE' OR quantity_delta > 0) AND
  (movement_type NOT IN ('SALE', 'DAMAGED', 'LOST') OR quantity_delta < 0)
);

CREATE INDEX inventory_latest_acquisition_idx
ON inventory_movements (merchandise_item_id, created_at DESC, id DESC)
WHERE quantity_delta > 0 AND movement_type <> 'TRANSFER'
  AND acquisition_unit_cost_amount IS NOT NULL;
