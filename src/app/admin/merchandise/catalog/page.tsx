import Link from "next/link";
import { requireAdminPage } from "@/lib/admin";
import { db } from "@/lib/db";
import { lineupFilterSchema } from "@/modules/lineups/queries";
import { Pagination } from "@/components/admin/pagination";
import { ItemTable } from "@/components/admin/item-table";
export const metadata = { title: "Catalog" };
export default async function Catalog({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminPage();
  const filters = lineupFilterSchema.parse(await searchParams);
  const where = filters.q
    ? {
        OR: [
          { name: { contains: filters.q, mode: "insensitive" as const } },
          {
            japaneseName: { contains: filters.q, mode: "insensitive" as const },
          },
        ],
      }
    : {};
  const total = await db.merchandiseItem.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.merchandiseItem.findMany({
    where,
    take: 25,
    skip: (page - 1) * 25,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: {
      lineup: { include: { franchise: true } },
      category: true,
      characters: { include: { character: true } },
      images: {
        orderBy: [{ imageRole: "asc" }, { displayOrder: "asc" }],
        take: 1,
      },
      inventoryBalances: {
        where: { quantity: { gt: 0 } },
        select: { quantity: true },
      },
      purchaseWatch: true,
      saleListing: true,
      sources: true,
    },
  });
  const items = rows.map(({ inventoryBalances, ...item }) => ({
    ...item,
    stock: inventoryBalances.reduce((n, b) => n + b.quantity, 0),
    locationCount: inventoryBalances.length,
    parentArchived: Boolean(
      item.lineup.archivedAt || item.lineup.franchise.archivedAt,
    ),
  }));
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>
            Catalog <span className="heading-count">{total}</span>
          </h1>
          <p className="muted">Known merchandise, whether owned or not.</p>
        </div>
        <Link className="button" href="/admin/merchandise/lineups">
          Add items through a lineup
        </Link>
      </div>
      <section className="panel">
        <form className="filter-form">
          <div className="filter-top">
            <label className="search-field">
              <input
                name="q"
                defaultValue={filters.q}
                placeholder="Search English or Japanese item names…"
                aria-label="Search catalog"
              />
            </label>
            <button className="button">Search</button>
          </div>
        </form>
        <ItemTable items={items} />
        {!items.length && (
          <p className="empty-state">No catalog items found.</p>
        )}
        <Pagination
          base="/admin/merchandise/catalog"
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
