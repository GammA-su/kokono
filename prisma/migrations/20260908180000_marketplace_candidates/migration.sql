-- CreateEnum
CREATE TYPE "MarketplaceListingStatus" AS ENUM ('AVAILABLE', 'SOLD', 'EXPIRED', 'PURCHASED', 'REJECTED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "marketplace" TEXT NOT NULL,
    "external_listing_id" TEXT,
    "url" TEXT NOT NULL,
    "seller_name" TEXT,
    "item_price_amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "domestic_shipping_amount" INTEGER,
    "condition" TEXT,
    "status" "MarketplaceListingStatus" NOT NULL DEFAULT 'UNKNOWN',
    "discovered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "purchase_item_id" UUID,
    "conversion_fingerprint" VARCHAR(64),
    "creation_fingerprint" VARCHAR(64) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_purchase_item_id_key" ON "marketplace_listings"("purchase_item_id");

-- CreateIndex
CREATE INDEX "marketplace_listings_status_discovered_at_id_idx" ON "marketplace_listings"("status", "discovered_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_merchandise_item_id_url_key" ON "marketplace_listings"("merchandise_item_id", "url");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_merchandise_item_id_marketplace_extern_key" ON "marketplace_listings"("merchandise_item_id", "marketplace", "external_listing_id");

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "purchase_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Offers contain prices, never stock. PURCHASED can only coexist with a conversion link.
ALTER TABLE marketplace_listings
  ADD CONSTRAINT marketplace_listing_money_check CHECK (item_price_amount >= 0 AND (domestic_shipping_amount IS NULL OR domestic_shipping_amount >= 0) AND currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT marketplace_listing_conversion_check CHECK (
    (status = 'PURCHASED' AND purchase_item_id IS NOT NULL AND conversion_fingerprint IS NOT NULL)
    OR (status <> 'PURCHASED' AND purchase_item_id IS NULL AND conversion_fingerprint IS NULL)
  );

CREATE FUNCTION protect_converted_marketplace_listing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purchase_item_id IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Converted marketplace candidates retain their purchase provenance';
    END IF;
    IF (to_jsonb(NEW) - 'last_checked_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'last_checked_at' - 'updated_at') THEN
      RAISE EXCEPTION 'Converted marketplace candidate source records are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_converted_marketplace_listing
BEFORE UPDATE OR DELETE ON marketplace_listings
FOR EACH ROW EXECUTE FUNCTION protect_converted_marketplace_listing();
