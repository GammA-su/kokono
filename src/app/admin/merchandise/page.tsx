import Link from "next/link";
import { requireAdminPage, lineupQueries } from "@/lib/admin";
import { db } from "@/lib/db";
import { StatusBadge } from "@/components/ui/badge";
import { formatPartialDate } from "@/modules/catalog/partial-date";
export const metadata = { title: "Merchandise dashboard" };
export default async function Dashboard() {
  await requireAdminPage();
  const [franchises, lineups, items, stock, recent] = await Promise.all([
    db.franchise.count({ where: { archivedAt: null } }),
    db.lineup.count({
      where: { archivedAt: null, franchise: { archivedAt: null } },
    }),
    db.merchandiseItem.count(),
    db.inventoryBalance.aggregate({ _sum: { quantity: true } }),
    lineupQueries.list({ sort: "added" }),
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>Dashboard</h1>
          <p className="muted">A clear view of your catalog and stock.</p>
        </div>
        <Link className="button primary" href="/admin/merchandise/lineups/new">
          Create lineup
        </Link>
      </div>
      <div className="summary-grid">
        {[
          ["Franchises", franchises, "franchises"],
          ["Active lineups", lineups, "lineups"],
          ["Catalogued items", items, "catalog"],
          ["Owned units", stock._sum.quantity ?? 0, "inventory"],
        ].map(([label, value, path]) => (
          <Link
            href={`/admin/merchandise/${path}`}
            className="panel summary-card"
            key={label}
          >
            <span className="muted">{label}</span>
            <strong>{Number(value).toLocaleString()}</strong>
            <span className="source-link">View {path} →</span>
          </Link>
        ))}
      </div>
      <section className="panel sources-panel">
        <div className="panel-heading">
          <h2>Recently added lineups</h2>
          <Link
            className="source-link"
            href="/admin/merchandise/lineups?sort=added"
          >
            View all
          </Link>
        </div>
        <div className="table-scroll">
          <table className="data-table read-table">
            <thead>
              <tr>
                <th>Lineup</th>
                <th>Franchise</th>
                <th>Release</th>
                <th>Status</th>
                <th className="numeric">Items</th>
              </tr>
            </thead>
            <tbody>
              {recent.rows.slice(0, 8).map((lineup) => (
                <tr key={lineup.id}>
                  <td>
                    <Link
                      className="source-link"
                      href={`/admin/merchandise/lineups/${lineup.id}`}
                    >
                      {lineup.name}
                    </Link>
                  </td>
                  <td>{lineup.franchise.name}</td>
                  <td>
                    {formatPartialDate(
                      lineup.releaseDate,
                      lineup.releaseDatePrecision,
                    ) ?? "Not announced"}
                  </td>
                  <td>
                    <StatusBadge status={lineup.status} />
                  </td>
                  <td className="numeric">{lineup.counts.catalogued}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!lineups && (
          <p className="empty-state">
            Create your first lineup to begin cataloguing releases.
          </p>
        )}
      </section>
    </>
  );
}
