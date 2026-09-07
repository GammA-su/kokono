-- CreateEnum
CREATE TYPE "LineupStatus" AS ENUM ('ANNOUNCED', 'PREORDER', 'RELEASED', 'DISCONTINUED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DatePrecision" AS ENUM ('YEAR', 'MONTH', 'DAY');

-- CreateEnum
CREATE TYPE "TaxInclusion" AS ENUM ('INCLUDED', 'EXCLUDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('OFFICIAL_STORE', 'MANUFACTURER', 'OFFICIAL_ANNOUNCEMENT', 'RETAILER', 'EVENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ImageRole" AS ENUM ('PRIMARY', 'PRODUCT', 'PACKAGE', 'PROMOTIONAL', 'CHARACTER_ART', 'OTHER');

-- CreateEnum
CREATE TYPE "WatchPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "StorageLocationType" AS ENUM ('JAPAN_WAREHOUSE', 'FRANCE_HOME', 'WAREHOUSE', 'IN_TRANSIT', 'SHELF', 'BOX', 'BIN', 'OTHER');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('PURCHASE', 'SALE', 'TRANSFER', 'RETURN', 'ADJUSTMENT', 'DAMAGED', 'LOST', 'GIFT', 'GACHA', 'OTHER');

-- CreateTable
CREATE TABLE "franchises" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "japanese_name" TEXT,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "image_storage_key" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "franchises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" UUID NOT NULL,
    "franchise_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "japanese_name" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image_storage_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineups" (
    "id" UUID NOT NULL,
    "franchise_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "japanese_name" TEXT,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "manufacturer" TEXT,
    "announced_date" DATE,
    "announced_date_precision" "DatePrecision",
    "release_date" DATE,
    "release_date_precision" "DatePrecision",
    "status" "LineupStatus" NOT NULL DEFAULT 'UNKNOWN',
    "main_image_storage_key" TEXT,
    "notes" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lineups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parent_id" UUID,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchandise_items" (
    "id" UUID NOT NULL,
    "lineup_id" UUID NOT NULL,
    "internal_sku" TEXT NOT NULL,
    "jan_code" TEXT,
    "name" TEXT NOT NULL,
    "japanese_name" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slug" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "description" TEXT,
    "manufacturer" TEXT,
    "official_msrp_amount" INTEGER,
    "official_msrp_currency" VARCHAR(3),
    "official_msrp_tax_inclusion" "TaxInclusion" NOT NULL DEFAULT 'UNKNOWN',
    "private_notes" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchandise_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_characters" (
    "merchandise_item_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,

    CONSTRAINT "item_characters_pkey" PRIMARY KEY ("merchandise_item_id","character_id")
);

-- CreateTable
CREATE TABLE "item_sources" (
    "id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "source_type" "SourceType" NOT NULL DEFAULT 'OTHER',
    "url" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_images" (
    "id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_url" TEXT,
    "source_url" TEXT,
    "source_provider" TEXT,
    "image_role" "ImageRole" NOT NULL DEFAULT 'PRODUCT',
    "caption" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "approved_for_public_use" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_watches" (
    "id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "target_quantity" INTEGER,
    "max_unit_price_amount" INTEGER,
    "max_unit_price_currency" VARCHAR(3) NOT NULL DEFAULT 'JPY',
    "priority" "WatchPriority" NOT NULL DEFAULT 'NORMAL',
    "condition_preference" TEXT,
    "marketplace_search_query" TEXT,
    "notes" TEXT,
    "last_checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StorageLocationType" NOT NULL DEFAULT 'OTHER',
    "parent_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "fulfillment_enabled" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "merchandise_item_id" UUID NOT NULL,
    "storage_location_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("merchandise_item_id","storage_location_id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "movement_type" "MovementType" NOT NULL,
    "quantity_delta" INTEGER NOT NULL,
    "source_location_id" UUID,
    "destination_location_id" UUID,
    "operation_key" VARCHAR(200) NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "actor_user_id" TEXT,
    "acquisition_unit_cost_amount" INTEGER,
    "acquisition_unit_cost_currency" VARCHAR(3),
    "notes" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_listings" (
    "id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "public_title" TEXT,
    "slug" TEXT NOT NULL,
    "public_description" TEXT,
    "selling_price_amount" INTEGER NOT NULL,
    "selling_price_currency" VARCHAR(3) NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sale_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "franchises_slug_key" ON "franchises"("slug");

-- CreateIndex
CREATE INDEX "characters_franchise_id_idx" ON "characters"("franchise_id");

-- CreateIndex
CREATE INDEX "lineups_release_date_idx" ON "lineups"("release_date");

-- CreateIndex
CREATE UNIQUE INDEX "lineups_franchise_id_slug_key" ON "lineups"("franchise_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchandise_items_internal_sku_key" ON "merchandise_items"("internal_sku");

-- CreateIndex
CREATE UNIQUE INDEX "merchandise_items_slug_key" ON "merchandise_items"("slug");

-- CreateIndex
CREATE INDEX "merchandise_items_lineup_id_idx" ON "merchandise_items"("lineup_id");

-- CreateIndex
CREATE INDEX "merchandise_items_category_id_idx" ON "merchandise_items"("category_id");

-- CreateIndex
CREATE INDEX "merchandise_items_name_idx" ON "merchandise_items"("name");

-- CreateIndex
CREATE INDEX "merchandise_items_japanese_name_idx" ON "merchandise_items"("japanese_name");

-- CreateIndex
CREATE INDEX "merchandise_items_jan_code_idx" ON "merchandise_items"("jan_code");

-- CreateIndex
CREATE INDEX "item_characters_character_id_idx" ON "item_characters"("character_id");

-- CreateIndex
CREATE INDEX "item_sources_merchandise_item_id_idx" ON "item_sources"("merchandise_item_id");

-- CreateIndex
CREATE INDEX "item_images_merchandise_item_id_display_order_idx" ON "item_images"("merchandise_item_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_watches_merchandise_item_id_key" ON "purchase_watches"("merchandise_item_id");

-- CreateIndex
CREATE INDEX "purchase_watches_enabled_priority_idx" ON "purchase_watches"("enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_code_key" ON "storage_locations"("code");

-- CreateIndex
CREATE INDEX "storage_locations_parent_id_idx" ON "storage_locations"("parent_id");

-- CreateIndex
CREATE INDEX "inventory_balances_storage_location_id_idx" ON "inventory_balances"("storage_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_operation_key_key" ON "inventory_movements"("operation_key");

-- CreateIndex
CREATE INDEX "inventory_movements_merchandise_item_id_created_at_idx" ON "inventory_movements"("merchandise_item_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_source_location_id_idx" ON "inventory_movements"("source_location_id");

-- CreateIndex
CREATE INDEX "inventory_movements_destination_location_id_idx" ON "inventory_movements"("destination_location_id");

-- CreateIndex
CREATE INDEX "inventory_movements_actor_user_id_idx" ON "inventory_movements"("actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_listings_merchandise_item_id_key" ON "sale_listings"("merchandise_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_listings_slug_key" ON "sale_listings"("slug");

-- CreateIndex
CREATE INDEX "sale_listings_published_featured_idx" ON "sale_listings"("published", "featured");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_franchise_id_fkey" FOREIGN KEY ("franchise_id") REFERENCES "franchises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_franchise_id_fkey" FOREIGN KEY ("franchise_id") REFERENCES "franchises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchandise_items" ADD CONSTRAINT "merchandise_items_lineup_id_fkey" FOREIGN KEY ("lineup_id") REFERENCES "lineups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchandise_items" ADD CONSTRAINT "merchandise_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_characters" ADD CONSTRAINT "item_characters_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_characters" ADD CONSTRAINT "item_characters_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_sources" ADD CONSTRAINT "item_sources_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_images" ADD CONSTRAINT "item_images_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_watches" ADD CONSTRAINT "purchase_watches_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_source_location_id_fkey" FOREIGN KEY ("source_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_listings" ADD CONSTRAINT "sale_listings_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
