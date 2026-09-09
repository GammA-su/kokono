-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'PAID', 'FAILED', 'REVIEW', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'CONFIRMED', 'RELEASED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'OPEN', 'SUCCEEDED', 'FAILED', 'REVIEW');

-- CreateEnum
CREATE TYPE "FulfillmentOrigin" AS ENUM ('ORDER', 'GACHA');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('READY', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "checkout_quotes" (
    "id" UUID NOT NULL,
    "guest_hash" VARCHAR(64) NOT NULL,
    "request" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "guest_hash" VARCHAR(64) NOT NULL,
    "checkout_key" VARCHAR(64) NOT NULL,
    "quote_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "payment_status" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "currency" VARCHAR(3) NOT NULL,
    "contact" JSONB NOT NULL,
    "shipping_address" JSONB NOT NULL,
    "billing_address" JSONB NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "subtotal_amount" INTEGER NOT NULL,
    "shipping_amount" INTEGER NOT NULL,
    "shipping_tax_amount" INTEGER NOT NULL,
    "shipping_tax_rate_bps" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL,
    "total_amount" INTEGER NOT NULL,
    "refunded_amount" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "review_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sale_listing_id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "tax_inclusion" "TaxInclusion" NOT NULL DEFAULT 'INCLUDED',
    "tax_rate_bps" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL,
    "total_amount" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "storage_location_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "expires_at" TIMESTAMPTZ(3),
    "movement_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'STRIPE',
    "provider_session_id" TEXT,
    "payment_intent_id" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "checkout_url" TEXT,
    "refund_id" TEXT,
    "refund_requested_at" TIMESTAMPTZ(3),
    "last_reconciled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "attempt_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_requests" (
    "id" UUID NOT NULL,
    "origin" "FulfillmentOrigin" NOT NULL,
    "origin_reference" TEXT NOT NULL,
    "order_id" UUID,
    "address" JSONB NOT NULL,
    "status" "FulfillmentStatus" NOT NULL DEFAULT 'READY',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfillment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_shipments" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "carrier" TEXT NOT NULL,
    "tracking_number" TEXT NOT NULL,
    "shipped_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "fulfillment_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_quotes_guest_hash_created_at_idx" ON "checkout_quotes"("guest_hash", "created_at");

-- CreateIndex
CREATE INDEX "checkout_quotes_expires_at_idx" ON "checkout_quotes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_number_key" ON "orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_checkout_key_key" ON "orders"("checkout_key");

-- CreateIndex
CREATE UNIQUE INDEX "orders_quote_id_key" ON "orders"("quote_id");

-- CreateIndex
CREATE INDEX "orders_guest_hash_created_at_idx" ON "orders"("guest_hash", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_expires_at_idx" ON "orders"("status", "expires_at");

-- CreateIndex
CREATE INDEX "orders_payment_status_updated_at_idx" ON "orders"("payment_status", "updated_at");

-- CreateIndex
CREATE INDEX "order_items_sale_listing_id_idx" ON "order_items"("sale_listing_id");

-- CreateIndex
CREATE INDEX "order_items_merchandise_item_id_idx" ON "order_items"("merchandise_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_sale_listing_id_key" ON "order_items"("order_id", "sale_listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_movement_id_key" ON "inventory_reservations"("movement_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_merchandise_item_id_storage_location_idx" ON "inventory_reservations"("merchandise_item_id", "storage_location_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "inventory_reservations_status_expires_at_idx" ON "inventory_reservations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "inventory_reservations_storage_location_id_idx" ON "inventory_reservations"("storage_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_order_item_id_storage_location_id_key" ON "inventory_reservations"("order_item_id", "storage_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_order_id_key" ON "payment_attempts"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_provider_session_id_key" ON "payment_attempts"("provider_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_payment_intent_id_key" ON "payment_attempts"("payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_refund_id_key" ON "payment_attempts"("refund_id");

-- CreateIndex
CREATE INDEX "payment_attempts_status_updated_at_idx" ON "payment_attempts"("status", "updated_at");

-- CreateIndex
CREATE INDEX "payment_events_attempt_id_idx" ON "payment_events"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_event_id_key" ON "payment_events"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_requests_order_id_key" ON "fulfillment_requests"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_requests_origin_origin_reference_key" ON "fulfillment_requests"("origin", "origin_reference");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_shipments_request_id_key" ON "fulfillment_shipments"("request_id");

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "checkout_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sale_listing_id_fkey" FOREIGN KEY ("sale_listing_id") REFERENCES "sale_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_requests" ADD CONSTRAINT "fulfillment_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_shipments" ADD CONSTRAINT "fulfillment_shipments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "fulfillment_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Monetary snapshots use TTC. Included VAT is informational, never added twice.
ALTER TABLE orders ADD CONSTRAINT order_amounts CHECK (currency='EUR' AND subtotal_amount>=0 AND shipping_amount>=0 AND tax_amount>=0 AND shipping_tax_amount>=0 AND shipping_tax_amount<=shipping_amount AND total_amount=subtotal_amount+shipping_amount AND tax_amount<=total_amount AND refunded_amount BETWEEN 0 AND total_amount AND shipping_tax_rate_bps BETWEEN 0 AND 10000);
ALTER TABLE order_items ADD CONSTRAINT order_line_amounts CHECK (quantity BETWEEN 1 AND 99 AND unit_price_amount>=0 AND total_amount=unit_price_amount::bigint*quantity AND tax_amount BETWEEN 0 AND total_amount AND tax_rate_bps BETWEEN 0 AND 10000 AND tax_inclusion='INCLUDED' AND currency='EUR');
ALTER TABLE inventory_reservations ADD CONSTRAINT reservation_quantity CHECK (quantity>0 AND (status<>'HELD' OR expires_at IS NOT NULL) AND (status<>'CONFIRMED' OR expires_at IS NULL));
ALTER TABLE payment_attempts ADD CONSTRAINT payment_amounts CHECK (amount>=50 AND currency='EUR');
ALTER TABLE fulfillment_requests ADD CONSTRAINT fulfillment_origin CHECK ((origin='ORDER' AND order_id IS NOT NULL AND origin_reference=order_id::text) OR (origin='GACHA' AND order_id IS NULL));
ALTER TABLE order_events ADD CONSTRAINT order_events_actor_user_id_fkey FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX order_events_actor_user_id_idx ON order_events(actor_user_id);

CREATE FUNCTION protect_order_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Order history cannot be deleted'; END IF;
 IF TG_TABLE_NAME<>'orders' OR
  (to_jsonb(NEW)-ARRAY['status','payment_status','refunded_amount','paid_at','cancelled_at','review_reason','updated_at']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['status','payment_status','refunded_amount','paid_at','cancelled_at','review_reason','updated_at'])
 THEN RAISE EXCEPTION 'Historical order snapshots are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_history_guard BEFORE UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_history();
CREATE TRIGGER order_item_history_guard BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION protect_order_history();
CREATE TRIGGER order_event_history_guard BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION protect_order_history();
CREATE TRIGGER payment_event_history_guard BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION protect_order_history();

CREATE FUNCTION protect_reservation_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other_reserved bigint; physical bigint; identity uuid;
BEGIN
 PERFORM id FROM merchandise_items WHERE id=NEW.merchandise_item_id FOR UPDATE;
 SELECT merchandise_item_id INTO identity FROM order_items WHERE id=NEW.order_item_id;
 IF identity IS DISTINCT FROM NEW.merchandise_item_id THEN RAISE EXCEPTION 'Reservation item identity mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.order_item_id,NEW.merchandise_item_id,NEW.storage_location_id,NEW.quantity) IS DISTINCT FROM (OLD.order_item_id,OLD.merchandise_item_id,OLD.storage_location_id,OLD.quantity) THEN RAISE EXCEPTION 'Allocation identity and quantity are immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='CONSUMED' AND NEW.status<>'CONSUMED' THEN RAISE EXCEPTION 'Consumed stock cannot be restored by changing an allocation'; END IF;
 IF NEW.status='CONFIRMED' OR (NEW.status='HELD' AND NEW.expires_at>clock_timestamp()) THEN
  SELECT COALESCE(SUM(quantity),0) INTO other_reserved FROM inventory_reservations WHERE merchandise_item_id=NEW.merchandise_item_id AND storage_location_id=NEW.storage_location_id AND id<>NEW.id AND (status='CONFIRMED' OR (status='HELD' AND expires_at>clock_timestamp()));
  SELECT quantity INTO physical FROM inventory_balances WHERE merchandise_item_id=NEW.merchandise_item_id AND storage_location_id=NEW.storage_location_id;
  IF COALESCE(physical,0)<other_reserved+NEW.quantity THEN RAISE EXCEPTION 'Insufficient unreserved physical stock'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reservation_stock_guard BEFORE INSERT OR UPDATE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION protect_reservation_stock();

CREATE FUNCTION protect_reserved_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reserved bigint;
BEGIN
 IF NEW.quantity<OLD.quantity THEN
  SELECT COALESCE(SUM(quantity),0) INTO reserved FROM inventory_reservations WHERE merchandise_item_id=NEW.merchandise_item_id AND storage_location_id=NEW.storage_location_id AND (status='CONFIRMED' OR (status='HELD' AND expires_at>clock_timestamp()));
  IF NEW.quantity<reserved THEN RAISE EXCEPTION 'Reserved inventory cannot be consumed by another operation'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reserved_balance_guard BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION protect_reserved_balance();

CREATE FUNCTION validate_consumed_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_row inventory_reservations; valid boolean;
BEGIN
 SELECT * INTO current_row FROM inventory_reservations WHERE id=NEW.id;
 IF current_row.status='CONSUMED' THEN
  SELECT EXISTS(SELECT 1 FROM inventory_movements m JOIN order_items oi ON oi.id=current_row.order_item_id WHERE m.id=current_row.movement_id AND m.movement_type='SALE' AND m.merchandise_item_id=current_row.merchandise_item_id AND m.source_location_id=current_row.storage_location_id AND m.quantity_delta=-current_row.quantity AND m.reference_type='ORDER' AND m.reference_id=oi.order_id::text) INTO valid;
  IF NOT valid THEN RAISE EXCEPTION 'A consumed allocation needs its matching SALE movement'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER consumed_reservation_ledger_guard AFTER INSERT OR UPDATE ON inventory_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_consumed_reservation();

CREATE TRIGGER reservation_history_guard BEFORE DELETE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION protect_order_history();

ALTER TABLE payment_events ADD COLUMN amount integer NOT NULL CHECK(amount >= 0), ADD COLUMN currency varchar(3) NOT NULL;
