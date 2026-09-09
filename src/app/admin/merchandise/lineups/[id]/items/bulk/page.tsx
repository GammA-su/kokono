import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdminPage } from "@/lib/admin";
import { db } from "@/lib/db";
import { formatPartialDate } from "@/modules/catalog/partial-date";
import { partialDateInput } from "@/modules/lineups/presentation";
import { statusLabels } from "@/components/ui/badge";
import { BulkItemEditor } from "@/components/admin/bulk-item-editor";

export const metadata = { title: "Add merchandise items" };
export default async function BulkItemEntry({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminPage();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const lineup = await db.lineup.findFirst({
    where: { id, archivedAt: null, franchise: { archivedAt: null } },
    include: {
      franchise: { select: { id: true, name: true } },
      sources: { orderBy: { createdAt: "asc" }, take: 1 },
    },
  });
  if (!lineup) notFound();
  const [categories, characters] = await Promise.all([
    db.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.character.findMany({
      where: { franchiseId: lineup.franchiseId },
      select: { id: true, name: true, japaneseName: true, aliases: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/lineups">Lineups</Link>
        <span>/</span>
        <Link href={`/admin/merchandise/lineups/${id}`}>{lineup.name}</Link>
        <span>/</span>Add items
      </div>
      <div className="page-heading">
        <div>
          <h1>Add merchandise items</h1>
          <p className="muted">
            Enter each design in this release as its own row. Cataloguing adds
            no stock and publishes nothing.
          </p>
        </div>
      </div>
      <BulkItemEditor
        lineup={{
          id: lineup.id,
          name: lineup.name,
          japaneseName: lineup.japaneseName,
          franchiseName: lineup.franchise.name,
          manufacturer: lineup.manufacturer,
          releaseDate: partialDateInput(
            lineup.releaseDate,
            lineup.releaseDatePrecision,
          ),
          releaseDateLabel: formatPartialDate(
            lineup.releaseDate,
            lineup.releaseDatePrecision,
          ),
          statusLabel: statusLabels[lineup.status],
          mainImageStorageKey: lineup.mainImageStorageKey,
          source: lineup.sources[0]
            ? {
                provider: lineup.sources[0].provider,
                sourceType: lineup.sources[0].sourceType,
                url: lineup.sources[0].url,
              }
            : null,
        }}
        categories={categories}
        characters={characters}
      />
    </>
  );
}
