import { createHash } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client";

// Internal SKUs identify a catalog record, never a name. The lineup contributes a readable
// token plus a digest of its immutable ID, and the suffix is a per-lineup sequence, so the
// same lineup and sequence always produce the same SKU without depending on item text.
export function internalSkuPrefix(lineup: { id: string; slug: string }) {
  const token =
    lineup.slug
      .replace(/-[a-f0-9]{8}$/, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 12) || "ITEM";
  const digest = createHash("sha256")
    .update(lineup.id)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  return `${token}-${digest}`;
}
export function formatInternalSku(prefix: string, sequence: number) {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

/**
 * Allocates the next `count` SKUs for a lineup. Callers must already hold the lineup row
 * lock, which serializes allocation; the unique index remains the final guarantee.
 */
export async function allocateInternalSkus(
  tx: Prisma.TransactionClient,
  lineup: { id: string; slug: string },
  count: number,
  reserved: Iterable<string> = [],
) {
  const prefix = internalSkuPrefix(lineup);
  const taken = new Set(reserved);
  const existing = await tx.merchandiseItem.findMany({
    where: { internalSku: { startsWith: `${prefix}-` } },
    select: { internalSku: true },
  });
  for (const row of existing) taken.add(row.internalSku);
  const highest = existing.reduce((top, row) => {
    const suffix = row.internalSku.slice(prefix.length + 1);
    return /^\d+$/.test(suffix) ? Math.max(top, Number(suffix)) : top;
  }, 0);
  const allocated: string[] = [];
  let sequence = highest;
  while (allocated.length < count) {
    sequence += 1;
    const candidate = formatInternalSku(prefix, sequence);
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    allocated.push(candidate);
  }
  return allocated;
}
