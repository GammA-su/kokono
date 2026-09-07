import Link from "next/link";
import { requireAdminPage } from "@/lib/admin";
import { db } from "@/lib/db";
import { lineupFilterSchema } from "@/modules/lineups/queries";
import { Pagination } from "@/components/admin/pagination";
export const metadata = { title: "Inventory" };
export default async function Inventory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminPage();
  const filters = lineupFilterSchema.parse(await searchParams);
  const where = {
    quantity: { gt: 0 },
    ...(filters.q
      ? {
          OR: [
            {
              merchandiseItem: {
                name: { contains: filters.q, mode: "insensitive" as const },
              },
            },
            {
              storageLocation: {
                code: { contains: filters.q, mode: "insensitive" as const },
              },
            },
          ],
        }
      : {}),
  };
  const [total, stock] = await Promise.all([
    db.inventoryBalance.count({ where }),
    db.inventoryBalance.aggregate({ where, _sum: { quantity: true } }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.inventoryBalance.findMany({
    where,
    include: {
      merchandiseItem: { include: { lineup: true } },
      storageLocation: true,
    },
    orderBy: [
      { merchandiseItem: { name: "asc" } },
      { merchandiseItemId: "asc" },
      { storageLocationId: "asc" },
    ],
    take: 25,
    skip: (page - 1) * 25,
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>Inventory</h1>
          <p className="muted">
            {(stock._sum.quantity ?? 0).toLocaleString()} owned units across
            matching locations, including transit.
          </p>
        </div>
      </div>
      <section className="panel">
        <form className="filter-form">
          <div className="filter-top">
            <label className="search-field">
              <input
                name="q"
                defaultValue={filters.q}
                placeholder="Search items or location codes…"
                aria-label="Search inventory"
              />
            </label>
            <button className="button">Search</button>
          </div>
        </form>
        <div className="table-scroll">
          <table className="data-table read-table">
            <thead>
              <tr>
                <th>Merchandise item</th>
                <th>Lineup</th>
                <th>Storage location</th>
                <th>Location type</th>
                <th className="numeric">Units</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.merchandiseItemId}-${row.storageLocationId}`}>
                  <td>
                    <strong>{row.merchandiseItem.name}</strong>
                    {row.merchandiseItem.archivedAt && (
                      <span className="badge">Archived</span>
                    )}
                  </td>
                  <td>
                    <Link
                      className="source-link"
                      href={`/admin/merchandise/lineups/${row.merchandiseItem.lineupId}`}
                    >
                      {row.merchandiseItem.lineup.name}
                    </Link>
                  </td>
                  <td>
                    {row.storageLocation.name}
                    <span className="japanese">
                      {row.storageLocation.code}
                      {!row.storageLocation.active && " · inactive"}
                    </span>
                  </td>
                  <td>
                    {row.storageLocation.type
                      .toLowerCase()
                      .replaceAll("_", " ")}
                  </td>
                  <td className="numeric count">{row.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <p className="empty-state">No owned stock matches this view.</p>
        )}
        <Pagination
          base="/admin/merchandise/inventory"
          params={{ q: filters.q }}
          page={page}
          pageCount={pageCount}
          total={total}
          size={25}
        />
      </section>
    </>
  );
}
