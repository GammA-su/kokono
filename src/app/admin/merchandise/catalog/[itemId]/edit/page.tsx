import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdminPage } from "@/lib/admin";
import { db } from "@/lib/db";
import { ItemForm } from "@/components/admin/item-form";
import { ItemImages } from "@/components/admin/item-images";
export const metadata = { title: "Edit merchandise item" };

export default async function EditItem({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminPage();
  const { itemId } = await params;
  const query = await searchParams;
  const notices: Record<string, string> = {
    "image-added": "Image added.",
    "image-approval": "Image visibility updated.",
    "image-removed": "Image deleted.",
  };
  const notice =
    typeof query.notice === "string" ? notices[query.notice] : null;
  if (!z.uuid().safeParse(itemId).success) notFound();
  const item = await db.merchandiseItem.findUnique({
    where: { id: itemId },
    include: {
      lineup: { select: { id: true, name: true, archivedAt: true, franchiseId: true } },
      characters: { select: { characterId: true } },
      images: {
        orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
        include: { listingImages: { select: { listingId: true } } },
      },
    },
  });
  if (!item) notFound();
  const [categories, characters] = await Promise.all([
    db.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.character.findMany({
      where: { franchiseId: item.lineup.franchiseId },
      select: { id: true, name: true, japaneseName: true, aliases: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/catalog">Catalog</Link>
        <span>/</span>
        <Link href={`/admin/merchandise/catalog/${item.id}`}>{item.name}</Link>
        <span>/</span>Edit
      </div>
      <div className="page-heading">
        <div>
          <h1>Edit merchandise item</h1>
          <p className="muted">
            Update catalog details for {item.name}. Stock, source links, images
            and storefront publication are edited on their own screens and are
            not changed here.
          </p>
        </div>
      </div>
      {item.archivedAt && (
        <p className="alert" role="status">
          This item is archived. Saving keeps it archived; restore it from the
          item page to make it visible again.
        </p>
      )}
      {notice && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      {item.lineup.archivedAt && (
        <p className="alert" role="status">
          Its lineup “{item.lineup.name}” is archived, so saving will be
          refused. Restore the lineup first.
        </p>
      )}
      <ItemForm
        lineupId={item.lineupId}
        categories={categories}
        characters={characters}
        initial={{
          id: item.id,
          updatedAt: item.updatedAt.toISOString(),
          name: item.name,
          japaneseName: item.japaneseName,
          categoryId: item.categoryId,
          internalSku: item.internalSku,
          janCode: item.janCode,
          slug: item.slug,
          description: item.description,
          manufacturer: item.manufacturer,
          privateNotes: item.privateNotes,
          officialMsrpAmount: item.officialMsrpAmount,
          officialMsrpTaxInclusion: item.officialMsrpTaxInclusion,
          characterIds: item.characters.map((link) => link.characterId),
        }}
      />
      <ItemImages
        itemId={item.id}
        images={item.images.map((image) => ({
          id: image.id,
          storageKey: image.storageKey,
          caption: image.caption,
          imageRole: image.imageRole,
          approvedForPublicUse: image.approvedForPublicUse,
          sourceProvider: image.sourceProvider,
          usedByListing: image.listingImages.length > 0,
        }))}
      />
    </>
  );
}
