-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DRAFT', 'PACKING', 'READY', 'SHIPPED', 'IN_TRANSIT', 'CUSTOMS', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "transit_parent_id" UUID NOT NULL,
    "transit_location_id" UUID,
    "carrier" TEXT,
    "carrier_service" TEXT,
    "tracking_number" TEXT,
    "shipment_date" DATE,
    "arrival_date" DATE,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "package_count" INTEGER NOT NULL DEFAULT 1,
    "total_weight" DECIMAL(12,3),
    "weight_unit" VARCHAR(2),
    "shipping_cost_amount" INTEGER,
    "shipping_currency" VARCHAR(3),
    "insurance_cost_amount" INTEGER,
    "other_shipping_fees_amount" INTEGER,
    "customs_duty_amount" INTEGER,
    "import_vat_amount" INTEGER,
    "carrier_customs_fee_amount" INTEGER,
    "other_import_fees_amount" INTEGER,
    "import_currency" VARCHAR(3),
    "notes" TEXT,
    "creation_fingerprint" VARCHAR(64) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_items" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "dispatch_movement_id" UUID,
    "delivery_movement_id" UUID,

    CONSTRAINT "shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_number_key" ON "shipments"("number");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_transit_location_id_key" ON "shipments"("transit_location_id");

-- CreateIndex
CREATE INDEX "shipments_status_created_at_idx" ON "shipments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_items_dispatch_movement_id_key" ON "shipment_items"("dispatch_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_items_delivery_movement_id_key" ON "shipment_items"("delivery_movement_id");

-- CreateIndex
CREATE INDEX "shipment_items_merchandise_item_id_idx" ON "shipment_items"("merchandise_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_items_shipment_id_merchandise_item_id_key" ON "shipment_items"("shipment_id", "merchandise_item_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_transit_parent_id_fkey" FOREIGN KEY ("transit_parent_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_transit_location_id_fkey" FOREIGN KEY ("transit_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_dispatch_movement_id_fkey" FOREIGN KEY ("dispatch_movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_delivery_movement_id_fkey" FOREIGN KEY ("delivery_movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE shipments ADD CONSTRAINT shipment_values_valid CHECK (
 package_count > 0 AND (total_weight IS NULL OR total_weight > 0)
 AND (total_weight IS NULL) = (weight_unit IS NULL) AND (weight_unit IS NULL OR weight_unit IN ('G','KG','LB'))
 AND origin_location_id <> destination_location_id AND origin_location_id <> transit_parent_id AND destination_location_id <> transit_parent_id
 AND (arrival_date IS NULL OR (shipment_date IS NOT NULL AND arrival_date >= shipment_date))
 AND (shipping_currency IS NULL OR shipping_currency ~ '^[A-Z]{3}$')
 AND (import_currency IS NULL OR import_currency ~ '^[A-Z]{3}$')
 AND (shipping_cost_amount IS NULL OR (shipping_cost_amount >= 0 AND shipping_currency IS NOT NULL))
 AND (insurance_cost_amount IS NULL OR (insurance_cost_amount >= 0 AND shipping_currency IS NOT NULL))
 AND (other_shipping_fees_amount IS NULL OR (other_shipping_fees_amount >= 0 AND shipping_currency IS NOT NULL))
 AND (customs_duty_amount IS NULL OR (customs_duty_amount >= 0 AND import_currency IS NOT NULL))
 AND (import_vat_amount IS NULL OR (import_vat_amount >= 0 AND import_currency IS NOT NULL))
 AND (carrier_customs_fee_amount IS NULL OR (carrier_customs_fee_amount >= 0 AND import_currency IS NOT NULL))
 AND (other_import_fees_amount IS NULL OR (other_import_fees_amount >= 0 AND import_currency IS NOT NULL))
);
ALTER TABLE shipment_items ADD CONSTRAINT shipment_item_values_valid CHECK (
 quantity > 0 AND (delivery_movement_id IS NULL OR dispatch_movement_id IS NOT NULL)
);

CREATE FUNCTION protect_shipment_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE leg text; movement_id uuid;
BEGIN
 IF TG_OP <> 'INSERT' AND OLD.dispatch_movement_id IS NOT NULL THEN
   IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Dispatched shipment lines cannot be deleted'; END IF;
   IF NEW.id <> OLD.id OR NEW.shipment_id <> OLD.shipment_id OR NEW.merchandise_item_id <> OLD.merchandise_item_id
      OR NEW.quantity <> OLD.quantity OR NEW.dispatch_movement_id IS DISTINCT FROM OLD.dispatch_movement_id
      OR (OLD.delivery_movement_id IS NOT NULL AND NEW.delivery_movement_id IS DISTINCT FROM OLD.delivery_movement_id)
   THEN RAISE EXCEPTION 'Dispatched shipment contents and movement links are immutable'; END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM shipments WHERE id=NEW.shipment_id AND shipment_date IS NOT NULL)
 THEN RAISE EXCEPTION 'Cannot add items after shipment dispatch'; END IF;
 FOREACH leg IN ARRAY ARRAY['ship','deliver'] LOOP
   movement_id := CASE WHEN leg='ship' THEN NEW.dispatch_movement_id ELSE NEW.delivery_movement_id END;
   IF movement_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM inventory_movements m JOIN shipments s ON s.id=NEW.shipment_id
     WHERE m.id=movement_id AND m.movement_type='TRANSFER' AND m.merchandise_item_id=NEW.merchandise_item_id
       AND m.quantity_delta=NEW.quantity AND m.reference_type='SHIPMENT_ITEM' AND m.reference_id=NEW.id::text
       AND m.operation_key='shipment-item:' || NEW.id::text || ':' || leg
       AND m.source_location_id=CASE WHEN leg='ship' THEN s.origin_location_id ELSE s.transit_location_id END
       AND m.destination_location_id=CASE WHEN leg='ship' THEN s.transit_location_id ELSE s.destination_location_id END
   ) THEN RAISE EXCEPTION 'Shipment movement does not match its merchandise, quantity and route'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER shipment_item_integrity BEFORE INSERT OR UPDATE OR DELETE ON shipment_items
 FOR EACH ROW EXECUTE FUNCTION protect_shipment_item();
