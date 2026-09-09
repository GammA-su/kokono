import { Prisma } from "../../generated/prisma/client";
import { reservedByLocationSql } from "./reservations";

/**
 * Shared per-item totals. The caller supplies the existing fulfillment allowlist.
 *
 * `items` optionally restricts the aggregate to a known set of merchandise items. It changes
 * only which rows are aggregated, never how a row is counted, so a caller that already knows
 * the items it will project gets the same totals without scanning every balance in the table.
 * Callers must stay inside one snapshot (the public readers use RepeatableRead) so a restricted
 * aggregate cannot observe stock that the selecting query did not.
 */
export function inventoryTotalsSql(
  fulfillable: Prisma.Sql,
  subtractReservations = false,
  items?: Prisma.Sql,
) {
  const available = subtractReservations
    ? Prisma.sql`GREATEST(b.quantity-COALESCE(r.reserved,0),0)`
    : Prisma.sql`b.quantity`;
  return Prisma.sql`
    SELECT b.merchandise_item_id AS item_id, SUM(b.quantity)::bigint AS total,
      COALESCE(SUM(${available}) FILTER (WHERE b.storage_location_id IN ${fulfillable}), 0)::bigint AS fulfillable
    FROM inventory_balances b ${subtractReservations ? Prisma.sql`LEFT JOIN (${reservedByLocationSql()}) r ON r.merchandise_item_id=b.merchandise_item_id AND r.storage_location_id=b.storage_location_id` : Prisma.empty} WHERE b.quantity > 0${items ? Prisma.sql` AND b.merchandise_item_id IN ${items}` : Prisma.empty} GROUP BY b.merchandise_item_id`;
}

/** Latest recorded positive acquisition cost, excluding transfers; not FIFO or landed cost. */
export function latestAcquisitionSql(ids?: string[]) {
  return Prisma.sql`
    SELECT DISTINCT ON (merchandise_item_id) merchandise_item_id::text AS "itemId",
      acquisition_unit_cost_amount AS amount, acquisition_unit_cost_currency AS currency,
      created_at AS date, id::text AS "movementId"
    FROM inventory_movements
    WHERE quantity_delta > 0 AND movement_type <> 'TRANSFER' AND acquisition_unit_cost_amount IS NOT NULL
      ${ids ? Prisma.sql`AND merchandise_item_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
    ORDER BY merchandise_item_id, created_at DESC, id DESC`;
}
