import Link from "next/link";
import { notFound } from "next/navigation";
import { lineupQueries } from "@/lib/admin";
import { LineupForm } from "@/components/admin/lineup-form";
import { partialDateInput } from "@/modules/lineups/presentation";
export const metadata = { title: "Edit lineup" };
export default async function EditLineup({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const [lineup, facets, query] = await Promise.all([
    lineupQueries.detail(id),
    lineupQueries.facets(),
    searchParams,
  ]);
  if (!lineup) notFound();
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/lineups">Lineups</Link>
        <span>/</span>
        <Link href={`/admin/merchandise/lineups/${id}`}>{lineup.name}</Link>
        <span>/</span>Edit
      </div>
      <div className="page-heading">
        <div>
          <h1>Edit lineup</h1>
          <p className="muted">
            Update release details and verification sources.
          </p>
        </div>
      </div>
      {query.notice === "duplicated" && (
        <p className="alert success" role="status">
          Copy created. Update the name, dates, and sources for the new release.
          No merchandise or stock was copied.
        </p>
      )}
      <LineupForm
        franchises={facets.franchises.filter(
          (f) => !f.archivedAt || f.id === lineup.franchiseId,
        )}
        initial={{
          ...lineup,
          updatedAt: lineup.updatedAt.toISOString(),
          announcedDate: partialDateInput(
            lineup.announcedDate,
            lineup.announcedDatePrecision,
          ),
          releaseDate: partialDateInput(
            lineup.releaseDate,
            lineup.releaseDatePrecision,
          ),
          sources: lineup.sources.map((source) => ({
            provider: source.provider,
            sourceType: source.sourceType,
            url: source.url,
            notes: source.notes,
            checkedDate: source.checkedAt?.toISOString().slice(0, 10) ?? "",
          })),
        }}
      />
    </>
  );
}
