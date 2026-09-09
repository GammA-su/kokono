-- CreateTable
CREATE TABLE "landed_cost_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "currency" VARCHAR(3) NOT NULL,
    "import_vat_as_cost" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "landed_cost_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landed_cost_calculations" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "creation_transaction" BIGINT NOT NULL DEFAULT txid_current(),
    "currency" VARCHAR(3) NOT NULL,
    "import_vat_as_cost" BOOLEAN NOT NULL,
    "review_hash" VARCHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landed_cost_calculations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landed_cost_lines" (
    "id" UUID NOT NULL,
    "calculation_id" UUID NOT NULL,
    "shipment_item_id" UUID NOT NULL,
    "purchase_item_id" UUID NOT NULL,
    "unit_offset" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "components" JSONB NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "unit_weight_grams" DECIMAL(12,3),

    CONSTRAINT "landed_cost_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "landed_cost_calculations_shipment_id_created_at_id_idx" ON "landed_cost_calculations"("shipment_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "landed_cost_lines_purchase_item_id_idx" ON "landed_cost_lines"("purchase_item_id");

-- CreateIndex
CREATE INDEX "landed_cost_lines_shipment_item_id_calculation_id_idx" ON "landed_cost_lines"("shipment_item_id", "calculation_id");

-- AddForeignKey
ALTER TABLE "landed_cost_calculations" ADD CONSTRAINT "landed_cost_calculations_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_calculations" ADD CONSTRAINT "landed_cost_calculations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_calculation_id_fkey" FOREIGN KEY ("calculation_id") REFERENCES "landed_cost_calculations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_shipment_item_id_fkey" FOREIGN KEY ("shipment_item_id") REFERENCES "shipment_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "purchase_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX landed_cost_calculations_shipment_id_revision_key ON landed_cost_calculations(shipment_id,revision);
ALTER TABLE landed_cost_settings ADD CHECK (id='global' AND currency ~ '^[A-Z]{3}$');
ALTER TABLE landed_cost_calculations ADD CHECK (revision>0 AND total_amount>=0 AND currency ~ '^[A-Z]{3}$' AND method IN ('BY_QUANTITY','BY_WEIGHT','BY_ITEM_VALUE','MANUAL'));
ALTER TABLE landed_cost_lines ADD CHECK (quantity>0 AND unit_offset>=0 AND total_amount>=0 AND (unit_weight_grams IS NULL OR unit_weight_grams>0));
CREATE FUNCTION reject_landed_cost_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Finalized landed costs are immutable; create another reviewed version'; END $$;
CREATE TRIGGER landed_cost_calculations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON landed_cost_calculations FOR EACH STATEMENT EXECUTE FUNCTION reject_landed_cost_mutation();
CREATE TRIGGER landed_cost_lines_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON landed_cost_lines FOR EACH STATEMENT EXECUTE FUNCTION reject_landed_cost_mutation();
CREATE FUNCTION validate_landed_cost_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM landed_cost_calculations c JOIN shipment_items s ON s.shipment_id=c.shipment_id
   JOIN purchase_items p ON p.id=NEW.purchase_item_id AND p.merchandise_item_id=s.merchandise_item_id
   WHERE c.id=NEW.calculation_id AND s.id=NEW.shipment_item_id AND c.creation_transaction=txid_current()
     AND NEW.unit_offset::bigint+NEW.quantity <= p.quantity AND p.received_movement_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Cost batch must match received merchandise and be inserted with its calculation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER landed_cost_batch_integrity BEFORE INSERT ON landed_cost_lines FOR EACH ROW EXECUTE FUNCTION validate_landed_cost_line();
