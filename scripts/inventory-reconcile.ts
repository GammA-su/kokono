import "dotenv/config";
import { createDatabaseClient } from "../src/db/client";
import { reconcileInventory } from "../src/modules/inventory/operations";
const db = createDatabaseClient(process.env.DATABASE_URL ?? "");
let checked = 0, mismatches = 0, cursor: string | undefined;
try {
  while (true) {
    const items = await db.merchandiseItem.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: 250,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!items.length) break;
    for (const item of items) {
      const differences = await reconcileInventory(db, item.id);
      checked++;
      if (differences.length) {
        mismatches += differences.length;
        console.error(JSON.stringify({ event: "inventory-reconciliation-mismatch", itemId: item.id, locations: differences.map((d) => d.storageLocationId) }));
      }
    }
    cursor = items.at(-1)!.id;
  }
  console.log(JSON.stringify({ event: "inventory-reconciliation-complete", checked, mismatches }));
  if (mismatches) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ event: "inventory-reconciliation-failed" }));
  process.exitCode = 1;
} finally { await db.$disconnect(); }
