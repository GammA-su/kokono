-- CreateEnum
CREATE TYPE "GachaPullStatus" AS ENUM ('RESERVED', 'CONSUMED', 'CANCELLED');


-- AlterTable
ALTER TABLE "inventory_reservations" ADD COLUMN     "gacha_prize_id" UUID,
ADD COLUMN     "gacha_pull_id" UUID,
ALTER COLUMN "order_item_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "gacha_banners" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT false,
    "paid_enabled" BOOLEAN NOT NULL DEFAULT false,
    "pull_price_amount" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "terms" TEXT NOT NULL,
    "terms_version" TEXT NOT NULL,
    "current_configuration_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gacha_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gacha_configurations" (
    "id" UUID NOT NULL,
    "banner_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "total_weight" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gacha_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gacha_prizes" (
    "id" UUID NOT NULL,
    "banner_id" UUID NOT NULL,
    "configuration_id" UUID NOT NULL,
    "merchandise_item_id" UUID NOT NULL,
    "tier" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "allocation" INTEGER NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "gacha_prizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gacha_pulls" (
    "id" UUID NOT NULL,
    "banner_id" UUID NOT NULL,
    "configuration_id" UUID NOT NULL,
    "prize_id" UUID NOT NULL,
    "customer_reference" TEXT NOT NULL,
    "operation_key" UUID NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "random_ticket" INTEGER NOT NULL,
    "random_algorithm" TEXT NOT NULL,
    "status" "GachaPullStatus" NOT NULL DEFAULT 'RESERVED',
    "audit" JSONB NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gacha_pulls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gacha_events" (
    "id" UUID NOT NULL,
    "banner_id" UUID NOT NULL,
    "pull_id" UUID,
    "type" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gacha_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gacha_banners_slug_key" ON "gacha_banners"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "gacha_banners_current_configuration_id_key" ON "gacha_banners"("current_configuration_id");

-- CreateIndex
CREATE INDEX "gacha_banners_active_starts_at_ends_at_idx" ON "gacha_banners"("active", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "gacha_configurations_banner_id_version_key" ON "gacha_configurations"("banner_id", "version");

-- CreateIndex
CREATE INDEX "gacha_prizes_banner_id_idx" ON "gacha_prizes"("banner_id");

-- CreateIndex
CREATE INDEX "gacha_prizes_merchandise_item_id_idx" ON "gacha_prizes"("merchandise_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "gacha_prizes_configuration_id_merchandise_item_id_key" ON "gacha_prizes"("configuration_id", "merchandise_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "gacha_prizes_configuration_id_display_order_key" ON "gacha_prizes"("configuration_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "gacha_pulls_operation_key_key" ON "gacha_pulls"("operation_key");

-- CreateIndex
CREATE INDEX "gacha_pulls_banner_id_created_at_idx" ON "gacha_pulls"("banner_id", "created_at");

-- CreateIndex
CREATE INDEX "gacha_pulls_configuration_id_idx" ON "gacha_pulls"("configuration_id");

-- CreateIndex
CREATE INDEX "gacha_pulls_prize_id_idx" ON "gacha_pulls"("prize_id");

-- CreateIndex
CREATE INDEX "gacha_pulls_customer_reference_idx" ON "gacha_pulls"("customer_reference");

-- CreateIndex
CREATE INDEX "gacha_events_banner_id_created_at_idx" ON "gacha_events"("banner_id", "created_at");

-- CreateIndex
CREATE INDEX "gacha_events_pull_id_idx" ON "gacha_events"("pull_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_gacha_pull_id_key" ON "inventory_reservations"("gacha_pull_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_gacha_prize_id_status_gacha_pull_id_idx" ON "inventory_reservations"("gacha_prize_id", "status", "gacha_pull_id");

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_gacha_prize_id_fkey" FOREIGN KEY ("gacha_prize_id") REFERENCES "gacha_prizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_gacha_pull_id_fkey" FOREIGN KEY ("gacha_pull_id") REFERENCES "gacha_pulls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_banners" ADD CONSTRAINT "gacha_banners_current_configuration_id_fkey" FOREIGN KEY ("current_configuration_id") REFERENCES "gacha_configurations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_configurations" ADD CONSTRAINT "gacha_configurations_banner_id_fkey" FOREIGN KEY ("banner_id") REFERENCES "gacha_banners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_configurations" ADD CONSTRAINT "gacha_configurations_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_prizes" ADD CONSTRAINT "gacha_prizes_banner_id_fkey" FOREIGN KEY ("banner_id") REFERENCES "gacha_banners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_prizes" ADD CONSTRAINT "gacha_prizes_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "gacha_configurations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_prizes" ADD CONSTRAINT "gacha_prizes_merchandise_item_id_fkey" FOREIGN KEY ("merchandise_item_id") REFERENCES "merchandise_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_pulls" ADD CONSTRAINT "gacha_pulls_banner_id_fkey" FOREIGN KEY ("banner_id") REFERENCES "gacha_banners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_pulls" ADD CONSTRAINT "gacha_pulls_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "gacha_configurations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_pulls" ADD CONSTRAINT "gacha_pulls_prize_id_fkey" FOREIGN KEY ("prize_id") REFERENCES "gacha_prizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_pulls" ADD CONSTRAINT "gacha_pulls_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_events" ADD CONSTRAINT "gacha_events_banner_id_fkey" FOREIGN KEY ("banner_id") REFERENCES "gacha_banners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_events" ADD CONSTRAINT "gacha_events_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "gacha_pulls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gacha_events" ADD CONSTRAINT "gacha_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shared reservations have exactly one inventory owner. Each gacha unit is individually claimable.
ALTER TABLE inventory_reservations ADD CONSTRAINT reservation_owner CHECK
 ((order_item_id IS NOT NULL AND gacha_prize_id IS NULL AND gacha_pull_id IS NULL) OR
  (order_item_id IS NULL AND gacha_prize_id IS NOT NULL AND quantity=1 AND status<>'HELD' AND expires_at IS NULL));
ALTER TABLE gacha_banners ADD CONSTRAINT gacha_banner_policy CHECK (paid_enabled=false AND (pull_price_amount IS NULL OR pull_price_amount>=0) AND (starts_at IS NULL OR ends_at IS NULL OR starts_at<ends_at));
ALTER TABLE gacha_configurations ADD CONSTRAINT gacha_configuration_weight CHECK (version>0 AND total_weight BETWEEN 1 AND 100000000);
ALTER TABLE gacha_prizes ADD CONSTRAINT gacha_prize_values CHECK (weight BETWEEN 1 AND 1000000 AND allocation BETWEEN 1 AND 2000 AND display_order>=0);
ALTER TABLE gacha_pulls ADD CONSTRAINT gacha_random_algorithm CHECK (random_algorithm='node:crypto.randomInt/v1' AND random_ticket>=0);
CREATE TRIGGER gacha_config_history BEFORE UPDATE OR DELETE ON gacha_configurations FOR EACH ROW EXECUTE FUNCTION protect_order_history();
CREATE TRIGGER gacha_prize_history BEFORE UPDATE OR DELETE ON gacha_prizes FOR EACH ROW EXECUTE FUNCTION protect_order_history();
CREATE TRIGGER gacha_event_history BEFORE UPDATE OR DELETE ON gacha_events FOR EACH ROW EXECUTE FUNCTION protect_order_history();

CREATE FUNCTION protect_gacha_pull() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected gacha_prizes; cfg gacha_configurations; interval_start bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Gacha pull history cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Gacha pull audit is immutable'; END IF;
  IF OLD.status<>NEW.status AND OLD.status<>'RESERVED' THEN RAISE EXCEPTION 'Finalized gacha awards cannot change status'; END IF;
 ELSE
  SELECT * INTO selected FROM gacha_prizes WHERE id=NEW.prize_id;
  SELECT * INTO cfg FROM gacha_configurations WHERE id=NEW.configuration_id;
  IF selected.configuration_id IS DISTINCT FROM NEW.configuration_id OR selected.banner_id IS DISTINCT FROM NEW.banner_id OR cfg.banner_id IS DISTINCT FROM NEW.banner_id THEN RAISE EXCEPTION 'Gacha pool identity mismatch'; END IF;
  SELECT COALESCE(SUM(weight),0) INTO interval_start FROM gacha_prizes WHERE configuration_id=cfg.id AND display_order<selected.display_order;
  IF NEW.random_ticket<interval_start OR NEW.random_ticket>=interval_start+selected.weight OR NEW.random_ticket>=cfg.total_weight THEN RAISE EXCEPTION 'Award does not match the recorded random ticket'; END IF;
  IF NEW.status<>'RESERVED' THEN RAISE EXCEPTION 'A new award must reserve its prize'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gacha_pull_history BEFORE INSERT OR UPDATE OR DELETE ON gacha_pulls FOR EACH ROW EXECUTE FUNCTION protect_gacha_pull();

CREATE OR REPLACE FUNCTION protect_reservation_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other_reserved bigint; physical bigint; identity uuid; prize_allocation integer; reserved_units bigint; pull_prize uuid;
BEGIN
 PERFORM id FROM merchandise_items WHERE id=NEW.merchandise_item_id FOR UPDATE;
 IF NEW.order_item_id IS NOT NULL THEN SELECT merchandise_item_id INTO identity FROM order_items WHERE id=NEW.order_item_id;
 ELSE
  SELECT merchandise_item_id,allocation INTO identity,prize_allocation FROM gacha_prizes WHERE id=NEW.gacha_prize_id;
  IF TG_OP='INSERT' THEN
   SELECT COUNT(*) INTO reserved_units FROM inventory_reservations WHERE gacha_prize_id=NEW.gacha_prize_id;
   IF reserved_units>=prize_allocation THEN RAISE EXCEPTION 'Configured gacha allocation cannot be exceeded'; END IF;
  END IF;
  IF NEW.gacha_pull_id IS NOT NULL THEN
   SELECT prize_id INTO pull_prize FROM gacha_pulls WHERE id=NEW.gacha_pull_id;
   IF pull_prize IS DISTINCT FROM NEW.gacha_prize_id THEN RAISE EXCEPTION 'Award and reserved prize differ'; END IF;
  END IF;
 END IF;
 IF identity IS DISTINCT FROM NEW.merchandise_item_id THEN RAISE EXCEPTION 'Reservation item identity mismatch'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.order_item_id,NEW.gacha_prize_id,NEW.merchandise_item_id,NEW.storage_location_id,NEW.quantity) IS DISTINCT FROM (OLD.order_item_id,OLD.gacha_prize_id,OLD.merchandise_item_id,OLD.storage_location_id,OLD.quantity) THEN RAISE EXCEPTION 'Allocation identity and quantity are immutable'; END IF;
  IF OLD.gacha_pull_id IS NOT NULL AND NEW.gacha_pull_id IS DISTINCT FROM OLD.gacha_pull_id THEN RAISE EXCEPTION 'A prize unit cannot be reassigned'; END IF;
  IF OLD.status IN ('CONSUMED','RELEASED') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'Finalized reservations cannot be restored'; END IF;
  IF NEW.gacha_pull_id IS DISTINCT FROM OLD.gacha_pull_id AND (OLD.status<>'CONFIRMED' OR NEW.status<>'CONFIRMED') THEN RAISE EXCEPTION 'Only a reserved pool unit can be awarded'; END IF;
 END IF;
 IF NEW.status='CONFIRMED' OR (NEW.status='HELD' AND NEW.expires_at>clock_timestamp()) THEN
  SELECT COALESCE(SUM(quantity),0) INTO other_reserved FROM inventory_reservations WHERE merchandise_item_id=NEW.merchandise_item_id AND storage_location_id=NEW.storage_location_id AND id<>NEW.id AND (status='CONFIRMED' OR (status='HELD' AND expires_at>clock_timestamp()));
  SELECT quantity INTO physical FROM inventory_balances WHERE merchandise_item_id=NEW.merchandise_item_id AND storage_location_id=NEW.storage_location_id;
  IF COALESCE(physical,0)<other_reserved+NEW.quantity THEN RAISE EXCEPTION 'Insufficient unreserved physical stock'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_consumed_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_row inventory_reservations; valid boolean;
BEGIN
 SELECT * INTO current_row FROM inventory_reservations WHERE id=NEW.id;
 IF current_row.status='CONSUMED' THEN
  IF current_row.order_item_id IS NOT NULL THEN
   SELECT EXISTS(SELECT 1 FROM inventory_movements m JOIN order_items oi ON oi.id=current_row.order_item_id WHERE m.id=current_row.movement_id AND m.movement_type='SALE' AND m.merchandise_item_id=current_row.merchandise_item_id AND m.source_location_id=current_row.storage_location_id AND m.quantity_delta=-current_row.quantity AND m.reference_type='ORDER' AND m.reference_id=oi.order_id::text) INTO valid;
  ELSE
   SELECT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.id=current_row.movement_id AND current_row.gacha_pull_id IS NOT NULL AND m.movement_type='GACHA' AND m.merchandise_item_id=current_row.merchandise_item_id AND m.source_location_id=current_row.storage_location_id AND m.quantity_delta=-1 AND m.reference_type='GACHA_PULL' AND m.reference_id=current_row.gacha_pull_id::text) INTO valid;
  END IF;
  IF NOT valid THEN RAISE EXCEPTION 'A consumed allocation needs its matching inventory movement'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION validate_gacha_award() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p gacha_pulls; r inventory_reservations;
BEGIN
 IF TG_TABLE_NAME='inventory_reservations' THEN
  IF NEW.gacha_pull_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO p FROM gacha_pulls WHERE id=NEW.gacha_pull_id;
 ELSE SELECT * INTO p FROM gacha_pulls WHERE id=NEW.id; END IF;
 SELECT * INTO r FROM inventory_reservations WHERE gacha_pull_id=p.id;
 IF r.id IS NULL OR r.gacha_prize_id<>p.prize_id OR
  (p.status='RESERVED' AND r.status<>'CONFIRMED') OR
  (p.status='CONSUMED' AND r.status<>'CONSUMED') OR
  (p.status='CANCELLED' AND r.status<>'RELEASED') THEN RAISE EXCEPTION 'Gacha award must retain its matching reservation state'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gacha_award_backing AFTER INSERT OR UPDATE ON gacha_pulls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_gacha_award();

CREATE CONSTRAINT TRIGGER gacha_reservation_backing AFTER INSERT OR UPDATE ON inventory_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_gacha_award();

CREATE FUNCTION validate_gacha_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg gacha_configurations; weights bigint; units bigint; rows integer;
BEGIN
 IF NEW.current_configuration_id IS NOT NULL THEN
  SELECT * INTO cfg FROM gacha_configurations WHERE id=NEW.current_configuration_id;
  SELECT SUM(weight),SUM(allocation),COUNT(*) INTO weights,units,rows FROM gacha_prizes WHERE configuration_id=cfg.id;
  IF cfg.banner_id IS DISTINCT FROM NEW.id OR cfg.total_weight IS DISTINCT FROM weights OR rows NOT BETWEEN 1 AND 100 OR units>2000 THEN RAISE EXCEPTION 'Invalid current gacha configuration'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gacha_current_configuration BEFORE INSERT OR UPDATE ON gacha_banners FOR EACH ROW EXECUTE FUNCTION validate_gacha_configuration();
CREATE FUNCTION prevent_gacha_pool_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg gacha_configurations; expected jsonb;
BEGIN
 SELECT * INTO cfg FROM gacha_configurations WHERE id=NEW.configuration_id;
 SELECT value INTO expected FROM jsonb_array_elements(cfg.snapshot->'prizes') WHERE value->>'id'=NEW.id::text;
 IF cfg.banner_id IS DISTINCT FROM NEW.banner_id OR expected IS DISTINCT FROM jsonb_build_object('id',NEW.id,'merchandiseItemId',NEW.merchandise_item_id,'displayName',NEW.display_name,'description',NEW.description,'tier',NEW.tier,'weight',NEW.weight,'allocation',NEW.allocation,'displayOrder',NEW.display_order) THEN RAISE EXCEPTION 'Prize must exactly match the immutable configuration snapshot'; END IF;
 IF EXISTS(SELECT 1 FROM gacha_banners WHERE current_configuration_id=NEW.configuration_id) OR EXISTS(SELECT 1 FROM gacha_pulls WHERE configuration_id=NEW.configuration_id) THEN RAISE EXCEPTION 'Published gacha prize pools cannot be extended in place'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gacha_pool_append_guard BEFORE INSERT ON gacha_prizes FOR EACH ROW EXECUTE FUNCTION prevent_gacha_pool_append();
