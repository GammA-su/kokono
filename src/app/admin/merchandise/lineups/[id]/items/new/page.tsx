import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdminPage } from "@/lib/admin";
import { db } from "@/lib/db";
import { ItemForm } from "@/components/admin/item-form";
export const metadata = { title: "Add merchandise item" };
export default async function NewItem({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminPage();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const lineup = await db.lineup.findFirst({
    where: { id, archivedAt: null, franchise: { archivedAt: null } },
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
        <span>/</span>Add item
      </div>
      <div className="page-heading">
        <div>
          <h1>Add merchandise item</h1>
          <p className="muted">
            Add a known design to {lineup.name}. Owning it is optional.
          </p>
        </div>
      </div>
      <ItemForm lineupId={id} categories={categories} characters={characters} />
    </>
  );
}
