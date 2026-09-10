/**
 * Drives the merchandise item edit and delete controls in a real browser, against the running
 * admin application. This exists because the gap being fixed was a *UI* gap: the domain layer
 * could already archive an item, but no page or button reached it, so only a browser check
 * proves the controls are actually there and actually work.
 *
 * Development database only. It creates its own temporary operator, franchise, lineup and items
 * and removes them afterwards.
 *
 *   npx tsx --env-file=.env scripts/verify-item-editing-browser.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "../src/db/client";
import { provisionInternalUser } from "../src/modules/auth/provision";
import { createCatalogService } from "../src/modules/catalog/service";
import { assertInternalAccount } from "../src/modules/auth/authorization";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { createLocationService } from "../src/modules/locations/service";
// @ts-expect-error -- Playwright lives in the storefront project and has no types reachable here
import { chromium } from "../../kokoniv2/node_modules/playwright/index.mjs";

const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const url = new URL(process.env.DATABASE_URL ?? "");
if (!url.pathname.endsWith("_dev"))
  throw new Error("Refusing to run against a non-development database.");

const db = createDatabaseClient(process.env.DATABASE_URL!);
const checks: { check: string; ok: boolean; detail: string }[] = [];
const assert = (check: string, ok: boolean, detail = "") => {
  checks.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}${detail ? ` — ${detail}` : ""}`);
};

// Fixed so repeated runs reuse the same records. The archive case requires an item with
// inventory history, and inventory history is immutable by design — a fresh fixture per run
// would leave a permanently undeletable item behind every time.
const suffix = "verify";
let actorId: string | undefined;
let franchiseId: string | undefined;
try {
  const password = randomUUID() + randomUUID();
  const actor = await provisionInternalUser(db, {
    name: "Item editing verifier",
    email: `edit-${randomUUID()}@example.test`,
    password,
  });
  actorId = actor.id;
  const catalog = createCatalogService(db, async () =>
    assertInternalAccount(db, actor.id),
  );
  const locations = createLocationService(db, async () =>
    assertInternalAccount(db, actor.id),
  );

  const franchise =
    (await db.franchise.findFirst({ where: { slug: `edit-check-${suffix}` } })) ??
    (await catalog.createFranchise({
      name: `Edit check ${suffix}`,
      slug: `edit-check-${suffix}`,
    }));
  // A previous run may have archived it; the edit flow needs it active.
  await db.franchise.update({
    where: { id: franchise.id },
    data: { archivedAt: null, name: `Edit check ${suffix}` },
  });
  franchiseId = franchise.id;
  const lineup =
    (await db.lineup.findFirst({ where: { slug: `edit-lineup-${suffix}` } })) ??
    (await catalog.createLineup({
      franchiseId: franchise.id,
      name: `Edit lineup ${suffix}`,
      slug: `edit-lineup-${suffix}`,
    }));
  await db.lineup.update({
    where: { id: lineup.id },
    data: { archivedAt: null },
  });
  const category = await db.category.findFirstOrThrow();
  const make = async (label: string) => {
    const slug = `edit-target-${label}-${suffix}`;
    const existing = await db.merchandiseItem.findFirst({ where: { slug } });
    if (existing) {
      await db.merchandiseItem.update({
        where: { id: existing.id },
        data: { archivedAt: null, name: `Edit target ${label} ${suffix}` },
      });
      return db.merchandiseItem.findUniqueOrThrow({ where: { id: existing.id } });
    }
    return catalog.createItem({
      name: `Edit target ${label} ${suffix}`,
      lineupId: lineup.id,
      categoryId: category.id,
      internalSku: `${label}-${suffix}`,
      slug,
    });
  };
  // One item stays clean so it can be genuinely deleted and recreated each run; one keeps
  // inventory history across runs so the archive path is exercised against a real dependency.
  const editable = await make("a");
  const stocked = await make("b");
  const warehouse =
    (await db.storageLocation.findFirst({ where: { code: `JP-${suffix}` } })) ??
    (await locations.create({
      code: `JP-${suffix}`,
      name: "Japan",
      type: "JAPAN_WAREHOUSE",
    }));
  if (
    !(await db.inventoryMovement.count({
      where: { merchandiseItemId: stocked.id },
    }))
  )
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: stocked.id,
        movementType: "PURCHASE",
        quantityDelta: 2,
        destinationLocationId: warehouse.id,
        operationKey: randomUUID(),
      },
      actor.id,
    );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  try {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(actor.email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: /Sign in/ }).click();
    await page.waitForURL((u: URL) => !u.pathname.startsWith("/login"), {
      timeout: 30000,
    });

    // ---------------------------------------------------------------- the missing Edit button
    await page.goto(`/admin/merchandise/catalog/${editable.id}`);
    const editLink = page.getByRole("link", { name: "Edit item" });
    assert(
      "edit_button_present_on_item_page",
      await editLink.isVisible(),
      "an 'Edit item' control is rendered on the item detail page",
    );

    await editLink.click();
    await page.waitForURL(/\/edit$/, { timeout: 30000 });
    const renamed = `Renamed via UI ${suffix}`;
    const nameField = page.locator('input[name="name"]');
    assert(
      "edit_form_is_prefilled",
      (await nameField.inputValue()).startsWith("Edit target a"),
      "the form opens populated with the existing values",
    );
    await nameField.fill(renamed);
    await page.locator('textarea[name="description"]').fill("Edited in browser");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(
      (u: URL) => u.pathname === `/admin/merchandise/catalog/${editable.id}`,
      { timeout: 30000 },
    );
    const saved = await db.merchandiseItem.findUniqueOrThrow({
      where: { id: editable.id },
    });
    assert(
      "edit_saves_through_the_ui",
      saved.name === renamed && saved.description === "Edited in browser",
      `name is now "${saved.name}"`,
    );

    // ---------------------------------------------------------------- create a character inline
    await page.goto(`/admin/merchandise/catalog/${editable.id}/edit`);
    const newCharacter = `Inline character ${Date.now()}`;
    const picker = page.locator("input.character-input");
    assert(
      "character_picker_replaces_checkboxes",
      await picker.isVisible(),
      "characters use a searchable picker, not a fixed checkbox list",
    );
    await picker.fill(newCharacter);
    await page.getByRole("option", { name: /^Create/ }).click();
    await page
      .locator(".character-chips .chip", { hasText: newCharacter })
      .waitFor({ timeout: 30000 });
    const created = await db.character.findFirst({
      where: { name: newCharacter },
    });
    assert(
      "new_character_created_from_the_item_form",
      !!created && created.franchiseId === franchise.id,
      "created in the item's franchise without leaving the form",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(
      (u: URL) => u.pathname === `/admin/merchandise/catalog/${editable.id}`,
      { timeout: 30000 },
    );
    assert(
      "new_character_is_linked_on_save",
      await db.itemCharacter
        .count({
          where: { merchandiseItemId: editable.id, characterId: created!.id },
        })
        .then((n) => n === 1),
      "the character selected in the picker is attached to the item",
    );

    // ---------------------------------------------------------------- add and manage an image
    await page.goto(`/admin/merchandise/catalog/${editable.id}/edit`);
    await page.getByRole("button", { name: "Add image" }).click();
    const openUpload = page.locator("dialog[open]");
    await openUpload.locator('input[name="file"]').setInputFiles({
      name: "verify.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await openUpload.locator('input[name="caption"]').fill("Verified upload");
    await openUpload.getByRole("button", { name: "Upload image" }).click();
    await page.waitForURL(/notice=image-added/, { timeout: 30000 });
    const image = await db.itemImage.findFirst({
      where: { merchandiseItemId: editable.id },
    });
    assert(
      "image_uploaded_from_the_edit_page",
      !!image && image.caption === "Verified upload",
      "the image is stored and attached to the item",
    );
    assert(
      "uploaded_image_starts_private",
      image?.approvedForPublicUse === false,
      "approval is a deliberate separate step, not implied by uploading",
    );

    await page.getByRole("button", { name: "Approve public" }).click();
    await page.waitForURL(/notice=image-approval/, { timeout: 30000 });
    assert(
      "image_can_be_approved_for_the_storefront",
      await db.itemImage
        .findUniqueOrThrow({ where: { id: image!.id } })
        .then((row) => row.approvedForPublicUse),
      "approval is reachable from the admin at last",
    );

    await page.getByRole("button", { name: "Delete" }).first().click();
    await page.waitForURL(/notice=image-removed/, { timeout: 30000 });
    assert(
      "image_can_be_deleted",
      !(await db.itemImage.findUnique({ where: { id: image!.id } })),
      "the image row is removed",
    );

    // ---------------------------------------------------------------- delete a clean item
    await page.goto(`/admin/merchandise/catalog/${editable.id}`);
    await page.getByRole("button", { name: "Delete item" }).click();
    await page
      .locator('dialog[open] input[name="confirmedName"]')
      .fill(
        (
          await db.merchandiseItem.findUniqueOrThrow({
            where: { id: editable.id },
          })
        ).name,
      );
    await page
      .locator("dialog[open]")
      .getByRole("button", { name: "Delete item" })
      .click();
    await page.waitForURL(
      (u: URL) => u.pathname === "/admin/merchandise/catalog",
      { timeout: 30000 },
    );
    assert(
      "delete_removes_an_item_without_history",
      !(await db.merchandiseItem.findUnique({ where: { id: editable.id } })),
      "the item is gone from the database",
    );

    // ---------------------------------------------------------------- archive a stocked item
    await page.goto(`/admin/merchandise/catalog/${stocked.id}`);
    const archiveButton = page.getByRole("button", { name: "Archive item" });
    assert(
      "stocked_item_offers_archive_not_delete",
      await archiveButton.isVisible(),
      "an item with stock offers archiving instead of deletion",
    );
    await archiveButton.click();
    await page
      .locator('dialog[open] input[name="confirmedName"]')
      .fill(stocked.name);
    await page
      .locator("dialog[open]")
      .getByRole("button", { name: "Archive item" })
      .click();
    await page.waitForURL(/notice=archived/, { timeout: 30000 });
    const archived = await db.merchandiseItem.findUniqueOrThrow({
      where: { id: stocked.id },
    });
    assert(
      "archive_preserves_the_item_and_its_ledger",
      !!archived.archivedAt &&
        (await db.inventoryMovement.count({
          where: { merchandiseItemId: stocked.id },
        })) === 1,
      "archived, with its movement history intact",
    );

    // ---------------------------------------------------------------- restore
    await page.getByRole("button", { name: "Restore item" }).click();
    await page.waitForURL(/notice=restored/, { timeout: 30000 });
    assert(
      "restore_brings_the_item_back",
      !(await db.merchandiseItem.findUniqueOrThrow({
        where: { id: stocked.id },
      }).then((row) => row.archivedAt)),
      "the item is active again",
    );
    // ---------------------------------------------------------------- franchise edit in list
    await page.goto("/admin/merchandise/franchises?q=Edit+check");
    const franchiseEdit = page.getByRole("button", { name: "Edit" }).first();
    assert(
      "franchise_edit_control_present",
      await franchiseEdit.isVisible(),
      "franchises can be edited from their list",
    );
    await franchiseEdit.click();
    const franchiseName = `Edit check renamed ${suffix}`;
    const openDialog = page.locator("dialog[open]");
    await openDialog.locator('input[name="name"]').fill(franchiseName);
    await openDialog.getByRole("button", { name: "Save franchise" }).click();
    await page.waitForURL(/notice=saved/, { timeout: 30000 });
    assert(
      "franchise_edit_saves",
      (
        await db.franchise.findUniqueOrThrow({ where: { id: franchise.id } })
      ).name === franchiseName,
      `renamed to "${franchiseName}"`,
    );
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
} finally {
  // The fixture is reused across runs, so it is archived rather than deleted: archived
  // records are hidden from the default admin views and the item that carries immutable
  // ledger history can never be removed anyway.
  if (franchiseId) {
    await db.merchandiseItem.updateMany({
      where: { lineup: { franchiseId } },
      data: { archivedAt: new Date() },
    });
    await db.lineup.updateMany({
      where: { franchiseId },
      data: { archivedAt: new Date() },
    });
    await db.franchise.update({
      where: { id: franchiseId },
      data: { archivedAt: new Date() },
    });
  }
  if (actorId) {
    await db.session.deleteMany({ where: { userId: actorId } });
    await db.account.deleteMany({ where: { userId: actorId } });
    // A ledger movement names its actor and the ledger is immutable, so an operator who
    // recorded stock cannot be deleted. Deactivating revokes access without rewriting history.
    const recorded = await db.inventoryMovement.count({
      where: { actorUserId: actorId },
    });
    if (recorded)
      await db.user.update({
        where: { id: actorId },
        data: { active: false, isInternal: false },
      });
    else await db.user.deleteMany({ where: { id: actorId } });
  }
  await db.$disconnect();
}
