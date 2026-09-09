import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { managedImagePattern } from "../src/modules/publication/media";
import { publicListingIdsSql } from "../src/modules/publication/queries";

/**
 * `item_images_public_managed_idx` is a partial index whose predicate repeats this regex.
 * PostgreSQL only skips the per-row regex when it can prove the query predicate implies the
 * index predicate, which requires the two literals to be identical. If they drift apart the
 * index is silently ignored and the public listing page returns to a full regex scan
 * (measured ~1.5 s per page at 50k listings), with no test or error to signal it.
 */
describe("managed media partial index", () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      "../prisma/migrations/20260914120000_public_listing_media_index/migration.sql",
    ),
    "utf8",
  );

  it("indexes the exact pattern the public queries filter on", () => {
    expect(migration).toContain(`storage_key ~ '${managedImagePattern.source}'`);
  });

  it("keeps the approval flag in the predicate", () => {
    expect(migration).toContain("WHERE approved_for_public_use");
  });

  /**
   * PostgreSQL cannot prove a partial-index predicate is implied by a bind parameter, so the
   * pattern has to reach the planner as a literal. Bound as a parameter the page silently
   * degrades to a sequential regex scan (measured 1,431 ms at 50k listings) with no failure.
   */
  it("passes the pattern to the planner as a literal, not a bind parameter", () => {
    const query = publicListingIdsSql();
    expect(query.sql).toContain(`storage_key ~ '${managedImagePattern.source}'`);
    expect(query.values).not.toContain(managedImagePattern.source);
  });
});
