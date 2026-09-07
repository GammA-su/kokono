import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";

// An explicit allowlist. Never return a full item, image, source, watch, or movement record.
function publicSelection(fulfillableLocations: string[]) {
  return {
    slug: true, publicTitle: true, publicDescription: true,
    sellingPriceAmount: true, sellingPriceCurrency: true, featured: true,
    merchandiseItem: { select: {
      name: true, japaneseName: true,
      category: { select: { name: true, slug: true } },
      lineup: { select: { name: true, slug: true, franchise: { select: { name: true, slug: true } } } },
      characters: { select: { character: { select: { name: true, japaneseName: true } } } },
      images: {
        where: { approvedForPublicUse: true }, orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
        select: { storageKey: true, caption: true, imageRole: true },
      },
      inventoryBalances: {
        where: { storageLocationId: { in: fulfillableLocations }, quantity: { gt: 0 } }, select: { quantity: true },
      },
    } },
  } satisfies Prisma.SaleListingSelect;
}

const visibleListing = {
  published: true,
  merchandiseItem: { archivedAt: null, lineup: { archivedAt: null, franchise: { archivedAt: null } } },
} satisfies Prisma.SaleListingWhereInput;

async function fulfillableLocations(database: PrismaClient) {
  const locations = await database.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE eligible AS (
      SELECT id, fulfillment_enabled FROM storage_locations WHERE parent_id IS NULL AND active AND type <> 'IN_TRANSIT'
      UNION ALL
      SELECT child.id, child.fulfillment_enabled FROM storage_locations child JOIN eligible parent ON child.parent_id = parent.id
      WHERE child.active AND child.type <> 'IN_TRANSIT'
    ) SELECT id FROM eligible WHERE fulfillment_enabled
  `;
  return locations.map((location) => location.id);
}

type SelectedListing = Prisma.SaleListingGetPayload<{ select: ReturnType<typeof publicSelection> }>;

function toPublicListing(listing: SelectedListing) {
  const { merchandiseItem: item } = listing;
  return {
    slug: listing.slug,
    title: listing.publicTitle || item.name,
    description: listing.publicDescription,
    price: { amount: listing.sellingPriceAmount, currency: listing.sellingPriceCurrency },
    featured: listing.featured,
    availability: item.inventoryBalances.some((balance) => balance.quantity > 0) ? "IN_STOCK" as const : "OUT_OF_STOCK" as const,
    item: { name: item.name, japaneseName: item.japaneseName, category: item.category, lineup: item.lineup },
    characters: item.characters.map(({ character }) => character),
    images: item.images,
  };
}

export async function getPublicListing(database: PrismaClient, slug: string) {
  const locations = await fulfillableLocations(database);
  const listing = await database.saleListing.findFirst({ where: { ...visibleListing, slug }, select: publicSelection(locations) });
  return listing ? toPublicListing(listing) : null;
}

export async function listPublicListings(database: PrismaClient, input: unknown = {}) {
  const { take, skip } = z.object({ take: z.number().int().min(1).max(100).default(24), skip: z.number().int().nonnegative().default(0) }).strict().parse(input);
  const locations = await fulfillableLocations(database);
  const listings = await database.saleListing.findMany({
    where: visibleListing, select: publicSelection(locations), take, skip,
    orderBy: [{ featured: "desc" }, { publishedAt: "desc" }, { id: "asc" }],
  });
  return listings.map(toPublicListing);
}
