-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "public_category_id" UUID;

-- AlterTable
ALTER TABLE "sale_listings" ADD COLUMN     "public_category_id" UUID,
ADD COLUMN     "public_subtitle" TEXT,
ADD COLUMN     "selling_price_tax_inclusion" "TaxInclusion" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "seo_description" TEXT,
ADD COLUMN     "seo_title" TEXT;

-- CreateTable
CREATE TABLE "public_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "public_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_listing_images" (
    "listing_id" UUID NOT NULL,
    "item_image_id" UUID NOT NULL,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "sale_listing_images_pkey" PRIMARY KEY ("listing_id","item_image_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_categories_slug_key" ON "public_categories"("slug");

-- CreateIndex
CREATE INDEX "sale_listing_images_item_image_id_idx" ON "sale_listing_images"("item_image_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_listing_images_listing_id_display_order_key" ON "sale_listing_images"("listing_id", "display_order");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_public_category_id_fkey" FOREIGN KEY ("public_category_id") REFERENCES "public_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_listing_images" ADD CONSTRAINT "sale_listing_images_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "sale_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_listing_images" ADD CONSTRAINT "sale_listing_images_item_image_id_fkey" FOREIGN KEY ("item_image_id") REFERENCES "item_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_listings" ADD CONSTRAINT "sale_listings_public_category_id_fkey" FOREIGN KEY ("public_category_id") REFERENCES "public_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deliberate defaults: seed navigation labels, never guess internal mappings.
INSERT INTO public_categories(id,slug,name,display_order,active,updated_at) VALUES
 ('af100000-0000-4000-8000-000000000001','figures','Figures',0,true,now()),
 ('af100000-0000-4000-8000-000000000002','apparel','Apparel',1,true,now()),
 ('af100000-0000-4000-8000-000000000003','prints','Prints',2,true,now()),
 ('af100000-0000-4000-8000-000000000004','goods','Goods',3,true,now());

-- Preserve listing IDs, prices and publication state. Only already-approved managed image references are selected.
INSERT INTO sale_listing_images(listing_id,item_image_id,display_order)
 SELECT listing_id,image_id,position::int FROM (
   SELECT s.id AS listing_id,im.id AS image_id,ROW_NUMBER() OVER(PARTITION BY s.id ORDER BY im.display_order,im.id)-1 AS position
   FROM sale_listings s JOIN item_images im ON im.merchandise_item_id=s.merchandise_item_id
   WHERE im.approved_for_public_use AND im.storage_key ~ '^admin-media/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$'
 ) candidates WHERE position<20;
ALTER TABLE sale_listing_images ADD CONSTRAINT listing_image_order_check CHECK(display_order BETWEEN 0 AND 19);

CREATE FUNCTION check_listing_image_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sale_listings s JOIN item_images im ON im.merchandise_item_id=s.merchandise_item_id WHERE s.id=NEW.listing_id AND im.id=NEW.item_image_id) THEN
   RAISE EXCEPTION 'Selected image must belong to the listing merchandise';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER check_listing_image_identity BEFORE INSERT OR UPDATE ON sale_listing_images FOR EACH ROW EXECUTE FUNCTION check_listing_image_identity();

CREATE FUNCTION protect_listing_public_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.published_at IS NOT NULL AND (NEW.slug IS DISTINCT FROM OLD.slug OR NEW.published_at IS NULL) THEN RAISE EXCEPTION 'Previously published slugs and publication history are preserved'; END IF;
 IF NEW.merchandise_item_id IS DISTINCT FROM OLD.merchandise_item_id THEN RAISE EXCEPTION 'Listing merchandise identity is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_listing_public_identity BEFORE UPDATE ON sale_listings FOR EACH ROW EXECUTE FUNCTION protect_listing_public_identity();

CREATE FUNCTION protect_selected_image_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.merchandise_item_id IS DISTINCT FROM OLD.merchandise_item_id AND EXISTS(SELECT 1 FROM sale_listing_images WHERE item_image_id=OLD.id) THEN RAISE EXCEPTION 'Selected image merchandise identity is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_selected_image_identity BEFORE UPDATE ON item_images FOR EACH ROW EXECUTE FUNCTION protect_selected_image_identity();

CREATE INDEX categories_public_category_id_idx ON categories(public_category_id);
CREATE INDEX sale_listings_public_category_id_idx ON sale_listings(public_category_id);
