import type { Prisma } from "../../generated/prisma/client";
import { DomainError } from "../shared/errors";
import { isDeliverableImage } from "./media";
import { storefrontCurrency } from "./validation";
import { slug } from "../shared/validation";

export const publicationItemInclude = {
  lineup: { include: { franchise: true } },
  category: { include: { publicCategory: true } },
  images: { orderBy: [{ displayOrder: "asc" }, { id: "asc" }] },
  saleListing: {
    include: {
      publicCategory: true,
      images: { orderBy: { displayOrder: "asc" } },
    },
  },
} satisfies Prisma.MerchandiseItemInclude;
export type PublicationItem = Prisma.MerchandiseItemGetPayload<{
  include: typeof publicationItemInclude;
}>;
export async function listingPolicyIssues(
  tx: Prisma.TransactionClient,
  item: PublicationItem,
  listing: {
    publicTitle?: string | null;
    slug: string;
    sellingPriceAmount: number;
    sellingPriceCurrency: string;
    publicCategoryId?: string | null;
  },
  imageIds: string[],
) {
  const issues: string[] = [];
  if (
    item.archivedAt ||
    item.lineup.archivedAt ||
    item.lineup.franchise.archivedAt
  )
    issues.push("The merchandise, lineup or franchise is archived.");
  if (!(listing.publicTitle ?? item.name).trim())
    issues.push("A public title is required.");
  if (!slug.safeParse(listing.slug).success)
    issues.push("A valid URL slug is required.");
  if (
    !Number.isInteger(listing.sellingPriceAmount) ||
    listing.sellingPriceAmount < 0
  )
    issues.push("A nonnegative selling price is required.");
  if (!storefrontCurrency.safeParse(listing.sellingPriceCurrency).success)
    issues.push("Choose a supported storefront currency.");
  const categoryId = listing.publicCategoryId ?? item.category.publicCategoryId;
  const category = categoryId
    ? await tx.publicCategory.findUnique({ where: { id: categoryId } })
    : null;
  if (!category?.active)
    issues.push(
      "Map an active public category, using a listing override or an internal category default.",
    );
  if (!imageIds.length)
    issues.push("Select at least one approved, deliverable managed image.");
  for (const id of imageIds) {
    const image = item.images.find((image) => image.id === id);
    if (!image)
      issues.push("A selected image does not belong to this merchandise item.");
    else if (!image.approvedForPublicUse)
      issues.push("A selected image is not approved for public use.");
    else if (!(await isDeliverableImage(image.storageKey)))
      issues.push(
        "A selected image has no deliverable managed file. Upload it through the existing image workflow.",
      );
  }
  return issues;
}
export function assertPublicationIssues(issues: string[]) {
  if (issues.length)
    throw new DomainError(
      "PUBLICATION_INVALID",
      [...new Set(issues)].join(" "),
    );
}
