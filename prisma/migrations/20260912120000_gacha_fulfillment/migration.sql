ALTER TYPE "GachaRewardStatus" ADD VALUE 'CLAIMED';
ALTER TYPE "GachaRewardStatus" ADD VALUE 'PREPARING';
ALTER TYPE "GachaRewardStatus" ADD VALUE 'SHIPPED';
ALTER TYPE "GachaRewardStatus" ADD VALUE 'DELIVERED';
ALTER TABLE gacha_rewards ADD COLUMN fulfillment_id uuid REFERENCES fulfillment_requests(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 ADD COLUMN claim_key uuid, ADD COLUMN claim_fingerprint varchar(64), ADD COLUMN claimed_at timestamptz(3);
CREATE UNIQUE INDEX gacha_rewards_customer_id_claim_key_key ON gacha_rewards(customer_id,claim_key);
CREATE INDEX gacha_rewards_fulfillment_id_idx ON gacha_rewards(fulfillment_id);
CREATE INDEX gacha_rewards_status_created_at_idx ON gacha_rewards(status,created_at);
ALTER TABLE gacha_rewards ADD CONSTRAINT gacha_claim_identity CHECK (
 (fulfillment_id IS NULL AND claim_key IS NULL AND claim_fingerprint IS NULL AND claimed_at IS NULL) OR
 (fulfillment_id IS NOT NULL AND claim_key IS NOT NULL AND claim_fingerprint IS NOT NULL AND claimed_at IS NOT NULL));
CREATE OR REPLACE FUNCTION protect_gacha_reward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reward ownership cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'status'-'updated_at'-'fulfillment_id'-'claim_key'-'claim_fingerprint'-'claimed_at') IS DISTINCT FROM
    (to_jsonb(OLD)-'status'-'updated_at'-'fulfillment_id'-'claim_key'-'claim_fingerprint'-'claimed_at') THEN RAISE EXCEPTION 'Reward ownership and receipt are immutable'; END IF;
 IF (NEW.fulfillment_id,NEW.claim_key,NEW.claim_fingerprint,NEW.claimed_at) IS DISTINCT FROM (OLD.fulfillment_id,OLD.claim_key,OLD.claim_fingerprint,OLD.claimed_at)
 AND NOT (OLD.status::text='AWARDED' AND NEW.status::text='CLAIMED' AND OLD.fulfillment_id IS NULL AND NEW.fulfillment_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Claim identity is immutable'; END IF;
 IF NEW.status<>OLD.status AND NOT (
 (OLD.status::text='AWARDED' AND NEW.status::text IN ('CLAIMED','CANCELLED')) OR
 (OLD.status::text='CLAIMED' AND NEW.status::text IN ('PREPARING','CANCELLED')) OR
 (OLD.status::text='PREPARING' AND NEW.status::text IN ('SHIPPED','CANCELLED')) OR
 (OLD.status::text='SHIPPED' AND NEW.status::text='DELIVERED'))
 THEN RAISE EXCEPTION 'Invalid reward fulfillment transition'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_customer_gacha_award() RETURNS trigger LANGUAGE plpgsql AS $$
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
 OR (p.status='RESERVED' AND r.status::text NOT IN ('AWARDED','CLAIMED','PREPARING')) OR (p.status='CONSUMED' AND r.status::text NOT IN ('CONSUMED','SHIPPED','DELIVERED')) OR (p.status='CANCELLED' AND r.status<>'CANCELLED')
 OR r.receipt->>'pullId' IS DISTINCT FROM p.id::text OR r.receipt->>'bannerId' IS DISTINCT FROM p.banner_id::text
 OR r.receipt->>'configurationId' IS DISTINCT FROM p.configuration_id::text
 OR jsonb_array_length(r.receipt->'prizes') IS DISTINCT FROM 1
 OR r.receipt->'prizes'->0->>'rewardId' IS DISTINCT FROM r.id::text
 OR r.receipt->'prizes'->0->>'id' IS DISTINCT FROM p.prize_id::text
 THEN RAISE EXCEPTION 'Invalid customer reward, entitlement or receipt backing'; END IF;
 RETURN NULL;
END $$;

-- Delivery identity and address are historical snapshots for both orders and rewards.
CREATE FUNCTION protect_fulfillment_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Fulfillment identity and address are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_request_history BEFORE UPDATE OR DELETE ON fulfillment_requests FOR EACH ROW EXECUTE FUNCTION protect_fulfillment_request();
CREATE FUNCTION protect_fulfillment_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'delivered_at') IS DISTINCT FROM (to_jsonb(OLD)-'delivered_at') OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
 THEN RAISE EXCEPTION 'Dispatch history is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_shipment_history BEFORE UPDATE OR DELETE ON fulfillment_shipments FOR EACH ROW EXECUTE FUNCTION protect_fulfillment_shipment();
CREATE FUNCTION assert_reward_fulfillment(reward_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r gacha_rewards; f fulfillment_requests; shipped fulfillment_shipments;
BEGIN
 SELECT * INTO r FROM gacha_rewards WHERE id=reward_id;
 IF r.status::text IN ('CLAIMED','PREPARING','SHIPPED','DELIVERED') AND r.fulfillment_id IS NULL THEN RAISE EXCEPTION 'Claimed reward requires delivery request'; END IF;
 IF r.fulfillment_id IS NULL THEN RETURN; END IF;
 SELECT * INTO f FROM fulfillment_requests WHERE id=r.fulfillment_id;
 SELECT * INTO shipped FROM fulfillment_shipments WHERE request_id=f.id;
 IF f.origin<>'GACHA' OR f.order_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM gacha_rewards other WHERE other.fulfillment_id=f.id AND other.customer_id<>r.customer_id)
 OR (r.status::text IN ('CLAIMED','PREPARING') AND (f.status<>'READY' OR shipped.id IS NOT NULL))
 OR (r.status::text='SHIPPED' AND (f.status<>'SHIPPED' OR shipped.id IS NULL OR shipped.delivered_at IS NOT NULL))
 OR (r.status::text='DELIVERED' AND (f.status<>'DELIVERED' OR shipped.delivered_at IS NULL))
 OR (r.status::text='CANCELLED' AND (f.status<>'CANCELLED' OR shipped.id IS NOT NULL))
 OR r.status::text IN ('AWARDED','CONSUMED') THEN RAISE EXCEPTION 'Reward and delivery states differ'; END IF;
 RETURN;
END $$;
CREATE FUNCTION validate_reward_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reward_id uuid;
BEGIN
 IF TG_TABLE_NAME='gacha_rewards' THEN PERFORM assert_reward_fulfillment(NEW.id);
 ELSIF TG_TABLE_NAME='fulfillment_requests' THEN
  FOR reward_id IN SELECT id FROM gacha_rewards WHERE fulfillment_id=NEW.id LOOP PERFORM assert_reward_fulfillment(reward_id); END LOOP;
 ELSE
  FOR reward_id IN SELECT id FROM gacha_rewards WHERE fulfillment_id=NEW.request_id LOOP PERFORM assert_reward_fulfillment(reward_id); END LOOP;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER delivery_reward_backing AFTER INSERT OR UPDATE ON fulfillment_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reward_fulfillment();
CREATE CONSTRAINT TRIGGER shipment_reward_backing AFTER INSERT OR UPDATE ON fulfillment_shipments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reward_fulfillment();
CREATE CONSTRAINT TRIGGER reward_delivery_backing AFTER INSERT OR UPDATE ON gacha_rewards DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reward_fulfillment();
