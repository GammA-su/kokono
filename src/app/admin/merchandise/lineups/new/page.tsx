import Link from "next/link";
import { lineupQueries } from "@/lib/admin";
import { LineupForm } from "@/components/admin/lineup-form";
export const metadata = { title: "Create lineup" };
export default async function NewLineup() {
  const { franchises } = await lineupQueries.facets();
  const active = franchises.filter((f) => !f.archivedAt);
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/lineups">Lineups</Link>
        <span>/</span>Create lineup
      </div>
      <div className="page-heading">
        <div>
          <h1>Create lineup</h1>
          <p className="muted">
            Start a release, collection, or collaboration.
          </p>
        </div>
      </div>
      {!active.length ? (
        <section className="panel empty-state">
          <h2>Add a franchise first</h2>
          <p>A lineup belongs to a franchise.</p>
          <Link className="button primary" href="/admin/merchandise/franchises">
            Manage franchises
          </Link>
        </section>
      ) : (
        <LineupForm franchises={active} />
      )}
    </>
  );
}
