import { Prisma } from "../../generated/prisma/client";
/** Confirmed order and gacha allocations do not expire. Unpaid checkout holds expire without a cleanup dependency. */
export function reservedByLocationSql() {
  return Prisma.sql`SELECT merchandise_item_id, storage_location_id, SUM(quantity)::bigint AS reserved
    FROM inventory_reservations WHERE status='CONFIRMED' OR (status='HELD' AND expires_at>clock_timestamp())
    GROUP BY merchandise_item_id,storage_location_id`;
}
export async function reservedAt(
  tx: Prisma.TransactionClient,
  itemId: string,
  locationId: string,
) {
  const [row] = await tx.$queryRaw<
    { quantity: bigint }[]
  >`SELECT COALESCE(SUM(quantity),0)::bigint AS quantity FROM inventory_reservations WHERE merchandise_item_id=${itemId}::uuid AND storage_location_id=${locationId}::uuid AND (status='CONFIRMED' OR (status='HELD' AND expires_at>clock_timestamp()))`;
  return Number(row.quantity);
}
/** One lock order for reservations and all ledger commands, including missing balance rows. */
export async function lockInventoryItems(
  tx: Prisma.TransactionClient,
  ids: string[],
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema() || '.storage_locations:hierarchy',0))::text`;
  if (!ids.length) return [];
  return tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM merchandise_items WHERE id IN (${Prisma.join([...new Set(ids)].sort().map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
}
