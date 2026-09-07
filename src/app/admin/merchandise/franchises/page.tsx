import Link from "next/link";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/admin";
import { lineupFilterSchema } from "@/modules/lineups/queries";
import { Pagination } from "@/components/admin/pagination";
import { ActionForm, Field } from "@/components/admin/action-form";
import { createFranchiseForm } from "@/modules/admin/actions";
export const metadata = { title: "Franchises" };
export default async function Franchises({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const filters = lineupFilterSchema.parse(params);
  const where = {
    archivedAt: null,
    ...(filters.q
      ? { name: { contains: filters.q, mode: "insensitive" as const } }
      : {}),
  };
  const total = await db.franchise.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.franchise.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: (page - 1) * 25,
    take: 25,
    include: {
      _count: {
        select: { lineups: { where: { archivedAt: null } }, characters: true },
      },
    },
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>Franchises</h1>
          <p className="muted">The worlds behind your merchandise.</p>
        </div>
      </div>
      {params.notice === "created" && (
        <p className="alert success">
          Franchise created. You can now add its lineups.
        </p>
      )}
      <details className="panel form-section" style={{ marginBottom: 20 }}>
        <summary>Add franchise</summary>
        <ActionForm action={createFranchiseForm} submitLabel="Create franchise">
          <div className="field-grid" style={{ marginTop: 20 }}>
            <Field name="name" label="Franchise name">
              <input name="name" required maxLength={500} />
            </Field>
            <Field name="japaneseName" label="Japanese name">
              <input name="japaneseName" lang="ja" />
            </Field>
          </div>
        </ActionForm>
      </details>
      <section className="panel">
        <form className="filter-form">
          <label className="search-field">
            <input
              name="q"
              defaultValue={filters.q}
              placeholder="Search franchises…"
              aria-label="Search franchises"
            />
          </label>
          <button className="button small" style={{ marginTop: 10 }}>
            Search
          </button>
        </form>
        <div className="table-scroll">
          <table className="data-table read-table">
            <thead>
              <tr>
                <th>Franchise</th>
                <th>Japanese name</th>
                <th className="numeric">Lineups</th>
                <th className="numeric">Characters</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.name}</strong>
                  </td>
                  <td lang="ja">{row.japaneseName ?? "—"}</td>
                  <td className="numeric">{row._count.lineups}</td>
                  <td className="numeric">{row._count.characters}</td>
                  <td>
                    <Link
                      className="source-link"
                      href={`/admin/merchandise/lineups?franchise=${row.id}`}
                    >
                      View lineups →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <p className="empty-state">No franchises found.</p>}
        <Pagination
          base="/admin/merchandise/franchises"
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
