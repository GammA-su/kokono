import { afterAll } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client";
import { saveImage, discardNewImage } from "../src/modules/media/storage";
export const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=",
  "base64",
);
const files: string[] = [];
afterAll(async () => {
  for (const file of files) await discardNewImage(file);
});
/** Real managed bytes and explicit mapping for publication fixtures under the current policy. */
export async function makePublicationReady(db: PrismaClient, itemId: string) {
  const item = await db.merchandiseItem.findUniqueOrThrow({
    where: { id: itemId },
  });
  const category = await db.publicCategory.findUniqueOrThrow({
    where: { slug: "goods" },
  });
  await db.category.update({
    where: { id: item.categoryId },
    data: { publicCategoryId: category.id },
  });
  const storageKey = await saveImage(
    new File([pngBytes], "fixture.png", { type: "image/png" }),
  );
  files.push(storageKey);
  const image = await db.itemImage.create({
    data: {
      merchandiseItemId: itemId,
      storageKey,
      approvedForPublicUse: true,
      caption: "Approved product image",
      sourceProvider: "PRIVATE_SOURCE",
      originalUrl: "https://example.test/private-original",
    },
  });
  const listing = await db.saleListing.findUnique({
    where: { merchandiseItemId: itemId },
  });
  if (listing) {
    await db.saleListingImage.deleteMany({ where: { listingId: listing.id } });
    await db.saleListingImage.create({
      data: { listingId: listing.id, itemImageId: image.id, displayOrder: 0 },
    });
  }
  return image;
}
