import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { withInternalTransaction } from "../auth/transaction";
import type { Authorize } from "../auth/authorization";
import { listingPolicyIssues, publicationItemInclude } from "./policy";
import { isDeliverableImage } from "./media";
import { fulfillableLocationIds } from "./queries";

export function createPublicationQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    review: (input: unknown) =>
      withInternalTransaction(
        database,
        authorize,
        async (tx) => {
          const ids = z.array(z.uuid()).max(1000).parse(input);
          const items = await tx.merchandiseItem.findMany({
            where: { id: { in: ids } },
            include: publicationItemInclude,
          });
          const categories = await tx.publicCategory.findMany({
            where: { active: true },
            orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
          });
          const franceLocations = await fulfillableLocationIds(tx, "FRANCE");
          const result = [];
          for (const item of items) {
            const images = [];
            for (const image of item.images)
              images.push({
                id: image.id,
                storageKey: image.storageKey,
                caption: image.caption,
                approved: image.approvedForPublicUse,
                deliverable: await isDeliverableImage(image.storageKey),
              });
            const selectedImageIds = item.saleListing
              ? item.saleListing.images.map((image) => image.itemImageId)
              : images
                  .filter((image) => image.approved && image.deliverable)
                  .slice(0, 20)
                  .map((image) => image.id);
            const issues = item.saleListing
              ? await listingPolicyIssues(
                  tx,
                  item,
                  item.saleListing,
                  selectedImageIds,
                )
              : [
                  "Configure a selling price and review the public fields before publication.",
                ];
            result.push({
              itemId: item.id,
              slug: item.slug,
              listing: item.saleListing,
              images,
              selectedImageIds,
              defaultCategoryId: item.category.publicCategoryId,
              issues,
            });
          }
          return {
            items: result,
            categories: categories.map(({ id, name, slug }) => ({
              id,
              name,
              slug,
            })),
            franceLocations,
          };
        },
        { timeout: 30000 },
      ),
    configuration: () =>
      withInternalTransaction(database, authorize, async (tx) => {
        const categories = await tx.category.findMany({
          orderBy: { name: "asc" },
          select: { id: true, name: true, publicCategoryId: true },
        });
        const publicCategories = await tx.publicCategory.findMany({
          where: { active: true },
          orderBy: { displayOrder: "asc" },
        });
        return { categories, publicCategories };
      }),
    report: (input: unknown) =>
      withInternalTransaction(
        database,
        authorize,
        async (tx) => {
          const parsed = z
              .object({ page: z.coerce.number().int().positive().catch(1) })
              .parse(input),
            size = 24;
          const total = await tx.saleListing.count(),
            pageCount = Math.max(1, Math.ceil(total / size)),
            page = Math.min(parsed.page, pageCount);
          const rows = await tx.merchandiseItem.findMany({
            where: { saleListing: { isNot: null } },
            include: publicationItemInclude,
            orderBy: { id: "asc" },
            skip: (page - 1) * size,
            take: size,
          });
          const items = [];
          for (const item of rows)
            items.push({
              id: item.id,
              name: item.name,
              published: item.saleListing!.published,
              issues: await listingPolicyIssues(
                tx,
                item,
                item.saleListing!,
                item.saleListing!.images.map((image) => image.itemImageId),
              ),
            });
          return { items, total, page, pageCount, size };
        },
        { timeout: 30000 },
      ),
  };
}
