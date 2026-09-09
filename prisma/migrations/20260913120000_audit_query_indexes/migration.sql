-- Global recent activity cannot use the existing item-prefixed history index.
CREATE INDEX inventory_movements_created_at_id_idx
  ON inventory_movements(created_at DESC, id DESC);

-- Approved receipt image lookup and the merchandise FK must not scan all rewards.
CREATE INDEX gacha_rewards_merchandise_item_id_idx
  ON gacha_rewards(merchandise_item_id);
