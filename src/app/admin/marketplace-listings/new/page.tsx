import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogQueries } from "@/lib/admin";
import { MarketplaceCandidateForm } from "@/components/admin/marketplace-candidate-form";
import { Pagination } from "@/components/admin/pagination";

export const metadata = { title: "Add marketplace candidate" };
export default async function NewCandidate({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (typeof params.item === "string") {
    const item = await catalogQueries.detail(params.item);
    if (!item) notFound();
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Add marketplace candidate</h1>
            <p>{item.name}</p>
            <p lang="ja">{item.japaneseName}</p>
          </div>
          <Link
            className="button"
            href={`/admin/marketplace-listings?item=${item.id}`}
          >
            All offers for this item
          </Link>
        </div>
        <section className="panel form-section">
          {item.archived ? (
            <p>
              This merchandise is archived. Existing offers remain available in
              its history.
            </p>
          ) : (
            <MarketplaceCandidateForm id={randomUUID()} itemId={item.id} />
          )}
        </section>
      </>
    );
  }
  const result = await catalogQueries.list({
    q: params.q,
    page: params.page,
    size: 24,
    sort: "alphabetical",
    archived: "false",
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Add marketplace candidate</h1>
          <p>Choose the catalog item represented by this offer.</p>
        </div>
      </div>
      <form className="panel form-section field-grid" method="get">
        <label className="field">
          <span>Search merchandise</span>
          <input
            name="q"
            maxLength={200}
            defaultValue={result.filters.q}
            placeholder="English, Japanese, SKU or JAN"
          />
        </label>
        <div className="form-actions">
          <button className="button">Search</button>
        </div>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Merchandise</th>
                <th>SKU</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.name}
                    <div lang="ja">{item.japaneseName}</div>
                  </td>
                  <td>{item.internalSku}</td>
                  <td>
                    <Link
                      className="button small"
                      href={`/admin/marketplace-listings/new?item=${item.id}`}
                    >
                      Select item
                    </Link>
                  </td>
                </tr>
              ))}
              {!result.items.length && (
                <tr>
                  <td colSpan={3}>No merchandise found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/marketplace-listings/new"
          params={{ q: result.filters.q }}
          page={result.filters.page}
          pageCount={result.pageCount}
          total={result.total}
          size={24}
        />
      </section>
    </>
  );
}
