import Link from "next/link";
import { notFound } from "next/navigation";
import { lineupQueries } from "@/lib/admin";
import { CsvImport } from "@/components/admin/csv-import";
export const metadata = { title: "Import catalog CSV" };
export default async function ImportCsv({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lineup = await lineupQueries.detail(id);
  if (!lineup) notFound();
  return (
    <>
      <div className="breadcrumb">
        <Link href={`/admin/merchandise/lineups/${id}`}>{lineup.name}</Link>
        <span>/</span>Import CSV
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CATALOG MANAGEMENT</p>
          <h1>Import CSV</h1>
          <p className="muted">Add or update merchandise in {lineup.name}.</p>
        </div>
      </div>
      {lineup.archivedAt || lineup.franchise.archivedAt ? (
        <p className="alert">
          This lineup or franchise is archived. Restore it before importing.
        </p>
      ) : (
        <CsvImport lineupId={id} />
      )}
      <p className="table-note">
        Characters use |, for example Rem|Ram. Escape a literal pipe as \| and a
        literal backslash as \\. Categories use existing slugs or unambiguous
        names. Amounts are whole currency minor units (JPY 1650 = ¥1,650; EUR
        1250 = €12.50). Dates use YYYY / YEAR, YYYY-MM / MONTH, or YYYY-MM-DD /
        DAY. image_url accepts an HTTP(S) URL or an existing admin-media
        reference. Images are referenced, never fetched or approved
        automatically.
      </p>
    </>
  );
}
