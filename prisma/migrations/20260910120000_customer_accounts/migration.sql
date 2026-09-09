-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'DISABLED', 'PENDING_VERIFICATION');

-- Customer identities are never inferred from existing guest order contact snapshots.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_id" UUID;

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT '',
    "last_name" TEXT NOT NULL DEFAULT '',
    "email_verified_at" TIMESTAMPTZ(3),
    "status" "CustomerStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "commerce_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_login_at" TIMESTAMPTZ(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_sessions" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tokens" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "purpose" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT NOT NULL DEFAULT '',
    "postal_code" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "default_shipping" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_events" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_rate_limits" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_commerce_key_key" ON "customers"("commerce_key");

-- CreateIndex
CREATE UNIQUE INDEX "customer_sessions_token_hash_key" ON "customer_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "customer_sessions_customer_id_idx" ON "customer_sessions"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tokens_token_hash_key" ON "customer_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "customer_tokens_customer_id_purpose_idx" ON "customer_tokens"("customer_id", "purpose");

-- CreateIndex
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses"("customer_id");

-- CreateIndex
CREATE INDEX "customer_events_customer_id_created_at_idx" ON "customer_events"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_rate_limits_expires_at_idx" ON "customer_rate_limits"("expires_at");

-- CreateIndex
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tokens" ADD CONSTRAINT "customer_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_events" ADD CONSTRAINT "customer_events_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE customers ADD CONSTRAINT customer_email_normalized CHECK (email = lower(btrim(email)));
CREATE UNIQUE INDEX customer_address_one_default ON customer_addresses(customer_id) WHERE default_shipping;
ALTER TABLE customer_events ADD CONSTRAINT customer_events_actor_fk FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
CREATE FUNCTION protect_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='orders' THEN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN RAISE EXCEPTION 'Order customer ownership is immutable'; END IF;
 END IF;
 IF TG_TABLE_NAME='customers' THEN
  IF (NEW.id,NEW.email,NEW.commerce_key) IS DISTINCT FROM (OLD.id,OLD.email,OLD.commerce_key) THEN RAISE EXCEPTION 'Customer identity is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_identity_guard BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION protect_customer_identity();
CREATE TRIGGER order_customer_guard BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_customer_identity();
CREATE TRIGGER customer_event_history_guard BEFORE UPDATE OR DELETE ON customer_events FOR EACH ROW EXECUTE FUNCTION protect_order_history();
