/**
 * Reviews every managed image referenced by the database against the strict decoder.
 *
 * This is read-only by design. It never approves an image, never rewrites a stored file and
 * never deletes anything: approval is a catalog decision made by a person, and a file that
 * fails to decode is evidence to act on, not something to silently repair.
 *
 *   npm run media:review          summary only
 *   npm run media:review -- --all list every row, not just problems
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabaseClient } from "../src/db/client";
import { inspectImage } from "../src/modules/media/storage";
import { managedImagePattern } from "../src/modules/publication/media";

const verbose = process.argv.includes("--all");
type Verdict =
  | "approved_and_deliverable"
  | "valid_not_approved"
  | "unreadable"
  | "unmanaged_reference";
type Row = {
  imageId: string;
  merchandiseItemId: string;
  approved: boolean;
  verdict: Verdict;
  detail: string;
};

const db = createDatabaseClient(process.env.DATABASE_URL ?? "");
const rows: Row[] = [];
try {
  const images = await db.itemImage.findMany({
    select: {
      id: true,
      merchandiseItemId: true,
      storageKey: true,
      approvedForPublicUse: true,
    },
    orderBy: { id: "asc" },
  });
  for (const image of images) {
    const approved = image.approvedForPublicUse;
    // A key that does not match the managed pattern can never be delivered publicly, so it is
    // reported separately from a file that is merely missing or corrupt.
    if (!managedImagePattern.test(image.storageKey)) {
      rows.push({
        imageId: image.id,
        merchandiseItemId: image.merchandiseItemId,
        approved,
        verdict: "unmanaged_reference",
        detail: "storage key is not a managed admin-media object",
      });
      continue;
    }
    try {
      const info = await inspectImage(
        image.storageKey.slice("admin-media/".length),
      );
      rows.push({
        imageId: image.id,
        merchandiseItemId: image.merchandiseItemId,
        approved,
        verdict: approved ? "approved_and_deliverable" : "valid_not_approved",
        detail: `${info.extension} (${info.mime})`,
      });
    } catch (error) {
      // Missing and corrupt both mean "cannot be served"; the message distinguishes them
      // without echoing a filesystem path.
      const message = error instanceof Error ? error.message : "failed";
      rows.push({
        imageId: image.id,
        merchandiseItemId: image.merchandiseItemId,
        approved,
        verdict: "unreadable",
        detail: /ENOENT|no such file/i.test(message)
          ? "file missing from the media directory"
          : "file present but failed strict decoding",
      });
    }
  }

  const counts = rows.reduce<Record<string, number>>((totals, row) => {
    totals[row.verdict] = (totals[row.verdict] ?? 0) + 1;
    return totals;
  }, {});
  const broken = rows.filter(
    (row) => row.verdict === "unreadable" || row.verdict === "unmanaged_reference",
  );

  console.log(`Managed images reviewed: ${rows.length}`);
  for (const verdict of [
    "approved_and_deliverable",
    "valid_not_approved",
    "unreadable",
    "unmanaged_reference",
  ] as const)
    console.log(`  ${verdict.padEnd(26)} ${counts[verdict] ?? 0}`);
  // An unreadable file that is also approved is the urgent case: the storefront believes it
  // is publishable.
  const approvedBroken = broken.filter((row) => row.approved);
  if (approvedBroken.length)
    console.log(
      `\n${approvedBroken.length} APPROVED image(s) cannot be delivered — these are publicly referenced.`,
    );
  for (const row of verbose ? rows : broken)
    console.log(
      `  ${row.verdict.padEnd(26)} ${row.imageId}  item=${row.merchandiseItemId}  ${row.approved ? "approved" : "unapproved"}  ${row.detail}`,
    );
  if (!broken.length) console.log("\nNo invalid, missing or unmanaged images found.");
  else
    console.log(
      "\nNothing was repaired or approved. Re-ingest the listed files through the normal upload path, which applies the same strict validation.",
    );

  await mkdir(resolve(".local/audit"), { recursive: true });
  await writeFile(
    resolve(".local/audit/media-review.json"),
    JSON.stringify(
      { at: new Date().toISOString(), reviewed: rows.length, counts, problems: broken },
      null,
      2,
    ),
  );
  console.log("Saved .local/audit/media-review.json");
  if (approvedBroken.length) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
