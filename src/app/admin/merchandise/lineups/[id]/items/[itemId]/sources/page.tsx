import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdminPage } from "@/lib/admin";
import { db } from "@/lib/db";
import { ItemSourcesForm } from "@/components/admin/item-form";
export const metadata = { title: "Item source links" };
export default async function ItemSources({
  params,
}: {
  params: Promise<{ id: string; itemId: string }>;
}) {
  await requireAdminPage();
  const { id, itemId } = await params;
  if (![id, itemId].every((value) => z.uuid().safeParse(value).success))
    notFound();
  const item = await db.merchandiseItem.findFirst({
    where: { id: itemId, lineupId: id },
    include: { lineup: true, sources: { orderBy: { createdAt: "asc" } } },
  });
  if (!item) notFound();
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/lineups">Lineups</Link>
        <span>/</span>
        <Link href={`/admin/merchandise/lineups/${id}`}>
          {item.lineup.name}
        </Link>
        <span>/</span>Item sources
      </div>
      <div className="page-heading">
        <div>
          <h1>Sources & verification</h1>
          <p className="muted">{item.name}</p>
        </div>
      </div>
      <ItemSourcesForm
        item={{
          id: item.id,
          lineupId: id,
          updatedAt: item.updatedAt.toISOString(),
        }}
        sources={item.sources.map((source) => ({
          provider: source.provider,
          sourceType: source.sourceType,
          url: source.url,
          notes: source.notes,
          checkedDate: source.checkedAt?.toISOString().slice(0, 10) ?? "",
        }))}
      />
    </>
  );
}
