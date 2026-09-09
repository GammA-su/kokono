ALTER TABLE gacha_banners ADD COLUMN customer_enabled boolean NOT NULL DEFAULT false;
CREATE TYPE "GachaRewardStatus" AS ENUM ('AWARDED','CONSUMED','CANCELLED');
CREATE TABLE gacha_authorizations (
 id uuid PRIMARY KEY, operation_key uuid NOT NULL UNIQUE,
 customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 banner_id uuid NOT NULL REFERENCES gacha_banners(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 max_pulls integer NOT NULL CHECK(max_pulls BETWEEN 1 AND 100),
 expires_at timestamptz(3) NOT NULL, reason text NOT NULL,
 actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gacha_authorizations_customer_id_banner_id_expires_at_idx ON gacha_authorizations(customer_id,banner_id,expires_at);
CREATE TRIGGER gacha_authorization_history BEFORE UPDATE OR DELETE ON gacha_authorizations FOR EACH ROW EXECUTE FUNCTION protect_order_history();
ALTER TABLE gacha_pulls ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE gacha_pulls ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 ADD COLUMN request_key uuid,
 ADD COLUMN authorization_id uuid REFERENCES gacha_authorizations(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE gacha_pulls ADD CONSTRAINT gacha_execution_identity CHECK (
 (actor_user_id IS NOT NULL AND customer_id IS NULL AND request_key IS NULL AND authorization_id IS NULL) OR
 (actor_user_id IS NULL AND customer_id IS NOT NULL AND request_key IS NOT NULL AND authorization_id IS NOT NULL));
CREATE UNIQUE INDEX gacha_pulls_customer_id_request_key_key ON gacha_pulls(customer_id,request_key);
CREATE INDEX gacha_pulls_customer_id_created_at_idx ON gacha_pulls(customer_id,created_at);
CREATE INDEX gacha_pulls_authorization_id_idx ON gacha_pulls(authorization_id);
ALTER TABLE gacha_events ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE gacha_events ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE gacha_events ADD CONSTRAINT gacha_event_actor CHECK ((actor_user_id IS NULL) <> (customer_id IS NULL));
CREATE TABLE gacha_rewards (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 pull_id uuid NOT NULL UNIQUE REFERENCES gacha_pulls(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 prize_id uuid NOT NULL REFERENCES gacha_prizes(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 merchandise_item_id uuid NOT NULL REFERENCES merchandise_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 reservation_id uuid NOT NULL UNIQUE REFERENCES inventory_reservations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 quantity integer NOT NULL DEFAULT 1 CHECK(quantity=1),
 status "GachaRewardStatus" NOT NULL DEFAULT 'AWARDED', receipt jsonb NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz(3) NOT NULL
);
CREATE INDEX gacha_rewards_customer_id_status_created_at_idx ON gacha_rewards(customer_id,status,created_at);
CREATE FUNCTION protect_gacha_reward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reward ownership cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'status'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'updated_at') THEN RAISE EXCEPTION 'Reward ownership and receipt are immutable'; END IF;
 IF NEW.status<>OLD.status AND OLD.status<>'AWARDED' THEN RAISE EXCEPTION 'Finalized reward cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gacha_reward_history BEFORE UPDATE OR DELETE ON gacha_rewards FOR EACH ROW EXECUTE FUNCTION protect_gacha_reward();
-- Keep customer ownership, entitlement and the existing physical allocation inseparable at commit.
CREATE FUNCTION validate_customer_gacha_award() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p gacha_pulls; r gacha_rewards; a gacha_authorizations; allocation inventory_reservations; uses bigint;
BEGIN
 IF TG_TABLE_NAME='gacha_rewards' THEN SELECT * INTO p FROM gacha_pulls WHERE id=NEW.pull_id;
 ELSE SELECT * INTO p FROM gacha_pulls WHERE id=NEW.id; END IF;
 IF p.customer_id IS NULL THEN
  IF TG_TABLE_NAME='gacha_rewards' THEN RAISE EXCEPTION 'A customer reward needs a customer execution'; END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO r FROM gacha_rewards WHERE pull_id=p.id;
 SELECT * INTO a FROM gacha_authorizations WHERE id=p.authorization_id FOR UPDATE;
 SELECT COUNT(*) INTO uses FROM gacha_pulls WHERE authorization_id=a.id;
 SELECT * INTO allocation FROM inventory_reservations WHERE id=r.reservation_id;
 IF r.id IS NULL OR r.customer_id IS DISTINCT FROM p.customer_id OR r.prize_id IS DISTINCT FROM p.prize_id
 OR allocation.gacha_pull_id IS DISTINCT FROM p.id OR allocation.merchandise_item_id IS DISTINCT FROM r.merchandise_item_id
 OR a.customer_id IS DISTINCT FROM p.customer_id OR a.banner_id IS DISTINCT FROM p.banner_id OR uses>a.max_pulls
 OR p.created_at>=a.expires_at OR p.created_at<a.created_at
 OR (p.status='RESERVED' AND r.status<>'AWARDED') OR (p.status='CONSUMED' AND r.status<>'CONSUMED') OR (p.status='CANCELLED' AND r.status<>'CANCELLED')
 OR r.receipt->>'pullId' IS DISTINCT FROM p.id::text OR r.receipt->>'bannerId' IS DISTINCT FROM p.banner_id::text
 OR r.receipt->>'configurationId' IS DISTINCT FROM p.configuration_id::text
 OR jsonb_array_length(r.receipt->'prizes') IS DISTINCT FROM 1
 OR r.receipt->'prizes'->0->>'rewardId' IS DISTINCT FROM r.id::text
 OR r.receipt->'prizes'->0->>'id' IS DISTINCT FROM p.prize_id::text
 THEN RAISE EXCEPTION 'Invalid customer reward, entitlement or receipt backing'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER customer_gacha_pull_backing AFTER INSERT OR UPDATE ON gacha_pulls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_customer_gacha_award();
CREATE CONSTRAINT TRIGGER customer_gacha_reward_backing AFTER INSERT OR UPDATE ON gacha_rewards DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_customer_gacha_award();
