import Link from "next/link";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/admin";
import { createAssistedImportService } from "@/modules/assisted-import/service";
import { AssistedImporter } from "@/components/admin/assisted-importer";
export const metadata = { title: "Assisted lineup import" };
export default async function ImportSourcePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const options = await createAssistedImportService(
    db,
    requireAdminPage,
    process.env.BETTER_AUTH_SECRET ?? "",
  ).options();
  const params = await searchParams;
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/lineups">Lineups</Link>
        <span>/</span>Assisted import
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CATALOG ENTRY</p>
          <h1>Import from an official page</h1>
          <p className="muted">
            Extract candidates, correct the details, then import only the
            products you select.
          </p>
        </div>
      </div>
      <AssistedImporter
        initialOptions={options}
        initialLineup={typeof params.lineup === "string" ? params.lineup : ""}
      />
    </>
  );
}
