"use server";

import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { catalog, locations, publication } from "@/lib/services";
import { applyInventoryOperation } from "@/modules/inventory/operations";

// Each service authorizes every invocation. Actor IDs are never accepted from request input.
export async function createFranchise(input: unknown) { return catalog.createFranchise(input); }
export async function createCharacter(input: unknown) { return catalog.createCharacter(input); }
export async function createCategory(input: unknown) { return catalog.createCategory(input); }
export async function createLineup(input: unknown) { return catalog.createLineup(input); }
export async function createMerchandiseItem(input: unknown) { return catalog.createItem(input); }
export async function savePurchaseWatch(input: unknown) { return catalog.savePurchaseWatch(input); }
export async function addItemSource(input: unknown) { return catalog.addSource(input); }
export async function addItemImage(input: unknown) { return catalog.addImage(input); }
export async function archiveMerchandiseItem(input: unknown) { return catalog.archiveItem(input); }
export async function createStorageLocation(input: unknown) { return locations.create(input); }
export async function reparentStorageLocation(input: unknown) { return locations.reparent(input); }
export async function saveSaleListing(input: unknown) { return publication.saveListing(input); }
export async function setListingPublished(input: unknown) { return publication.setPublished(input); }
export async function recordInventoryMovement(input: unknown) {
  const actor = await requireInternalUser();
  return applyInventoryOperation(db, input, actor.id);
}
