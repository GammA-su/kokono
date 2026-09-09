-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'ORDERED', 'PAID', 'RECEIVED_JAPAN', 'CANCELLED', 'REFUNDED', 'OTHER');

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "supplier" TEXT NOT NULL,
    "marketplace" TEXT,
    "external_reference" TEXT,
    "purchase_date" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "subtotal_amount" INTEGER NOT NULL,
    "domestic_shipping_amount" INTEGER NOT NULL DEFAULT 0,
    "fees_amount" INTEGER NOT NULL DEFAULT 0,
    "taxes_amount" INTEGER NOT NULL DEFAULT 0,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "creation_fingerprint" VARCHAR(64) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_amount" INTEGER NOT NULL,
    "condition" TEXT,
    "seller_listing_url" TEXT,
    "notes" TEXT,
    "received_movement_id" UUID,
    "received_at" TIMESTAMPTZ(3),
    "received_country_code" VARCHAR(2),

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchases_purchase_date_id_idx" ON "purchases"("purchase_date", "id");

-- CreateIndex
CREATE INDEX "purchases_status_created_at_idx" ON "purchases"("status", "created_at");

-- CreateIndex
CREATE INDEX "purchases_external_reference_idx" ON "purchases"("external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_items_received_movement_id_key" ON "purchase_items"("received_movement_id");

-- CreateIndex
CREATE INDEX "purchase_items_merchandise_item_id_idx" ON "purchase_items"("merchandise_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_items_purchase_id_position_key" ON "purchase_items"("purchase_id", "position");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_received_movement_id_fkey" FOREIGN KEY ("received_movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE purchases ADD CONSTRAINT purchase_amounts_valid CHECK (
 subtotal_amount >= 0 AND domestic_shipping_amount >= 0 AND fees_amount >= 0 AND taxes_amount >= 0
 AND currency ~ '^[A-Z]{3}$' AND length(trim(supplier)) > 0
);
ALTER TABLE purchase_items ADD CONSTRAINT purchase_item_valid CHECK (
 quantity > 0 AND unit_price_amount >= 0 AND position >= 0
 AND (received_movement_id IS NULL) = (received_at IS NULL)
 AND (received_country_code IS NULL OR (received_movement_id IS NOT NULL AND received_country_code ~ '^[A-Z]{2}$'))
);

CREATE FUNCTION protect_purchase_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' AND OLD.received_movement_id IS NOT NULL THEN
   RAISE EXCEPTION 'Received purchase lines are immutable';
 END IF;
 IF TG_OP <> 'DELETE' AND NEW.received_movement_id IS NOT NULL THEN
   IF NOT EXISTS (
     SELECT 1 FROM inventory_movements m JOIN purchases p ON p.id = NEW.purchase_id
     WHERE m.id = NEW.received_movement_id AND m.merchandise_item_id = NEW.merchandise_item_id
       AND m.movement_type = 'PURCHASE' AND m.quantity_delta = NEW.quantity
       AND m.acquisition_unit_cost_amount = NEW.unit_price_amount AND m.acquisition_unit_cost_currency = p.currency
       AND m.reference_type = 'PURCHASE_ITEM' AND m.reference_id = NEW.id::text
       AND m.operation_key = 'purchase-item:' || NEW.id::text || ':receive'
   ) THEN RAISE EXCEPTION 'Purchase receipt must match its inventory movement'; END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_receipt_integrity BEFORE INSERT OR UPDATE OR DELETE ON purchase_items
 FOR EACH ROW EXECUTE FUNCTION protect_purchase_receipt();
