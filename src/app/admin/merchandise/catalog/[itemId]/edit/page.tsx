import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdminPage } from "@/lib/admin";
import { db } from "@/lib/db";
import { ItemForm } from "@/components/admin/item-form";
export const metadata = { title: "Edit merchandise item" };

export default async function EditItem({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  await requireAdminPage();
  const { itemId } = await params;
  if (!z.uuid().safeParse(itemId).success) notFound();
  const item = await db.merchandiseItem.findUnique({
    where: { id: itemId },
    include: {
      lineup: { select: { id: true, name: true, archivedAt: true, franchiseId: true } },
      characters: { select: { characterId: true } },
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
      select: { id: true, name: true },
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
    </>
  );
}
