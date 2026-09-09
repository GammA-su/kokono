import Link from "next/link";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createGachaQueries } from "@/modules/gacha/queries";
import { Pagination } from "@/components/admin/pagination";
export const metadata = { title: "Gacha" };
export default async function GachaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await createGachaQueries(db, requireInternalUser).list(
    await searchParams,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>
            Gacha <span className="heading-count">{result.total}</span>
          </h1>
          <p className="muted">
            Versioned prize pools, physical reservations and auditable grants.
            Paid draws are disabled.
          </p>
        </div>
        <Link className="button primary" href="/admin/gacha/new">
          Create banner
        </Link>
      </div>
      <form method="get" className="panel form-section field-grid">
        <label className="field">
          <span>Search banners</span>
          <input name="q" defaultValue={result.filters.q} maxLength={100} />
        </label>
        <button className="button">Search</button>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Banner</th>
                <th>Active</th>
                <th>Configuration</th>
                <th>Grants</th>
                <th>Window (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/admin/gacha/${b.id}`}>{b.name}</Link>
                    <div className="muted">{b.slug}</div>
                  </td>
                  <td>{b.active ? "Yes" : "Paused"}</td>
                  <td>v{b.currentConfiguration?.version ?? 0}</td>
                  <td>{b._count.pulls}</td>
                  <td>
                    {b.startsAt?.toISOString() ?? "No start limit"} /{" "}
                    {b.endsAt?.toISOString() ?? "No end limit"}
                  </td>
                </tr>
              ))}
              {!result.items.length && (
                <tr>
                  <td colSpan={5}>
                    No banners. Create a banner to configure a physical prize
                    pool.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/gacha"
          params={{ q: result.filters.q }}
          page={result.filters.page}
          {...{
            pageCount: result.pageCount,
            total: result.total,
            size: result.size,
          }}
        />
      </section>
    </>
  );
}
