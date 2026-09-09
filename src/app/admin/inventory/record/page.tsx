import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MovementType } from "@/generated/prisma/enums";
import { catalogQueries, locationQueries } from "@/lib/admin";
import { InventoryCommandForm } from "@/components/admin/inventory-command-form";
import { Pagination } from "@/components/admin/pagination";

export const metadata = { title: "Record inventory movement" };
export default async function RecordInventory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialType = z.enum(MovementType).catch("PURCHASE").parse(params.type);
  if (!params.item) {
    const result = await catalogQueries.list({
      q: params.q,
      page: params.page,
      archived: "true",
      sort: "alphabetical",
    });
    return (
      <>
        <div className="page-heading">
          <div>
            <p className="eyebrow">INVENTORY</p>
            <h1>Select merchandise</h1>
            <p className="muted">
              Search all catalogued items, including unowned and archived
              merchandise.
            </p>
          </div>
          <Link className="button" href="/admin/inventory">
            Back to inventory
          </Link>
        </div>
        <form className="panel form-section inventory-filters" method="get">
          <input type="hidden" name="type" value={initialType} />
          <label className="field">
            <span>Merchandise, Japanese name, SKU or JAN</span>
            <input name="q" defaultValue={result.filters.q} maxLength={200} />
          </label>
          <button className="button primary">Search</button>
        </form>
        <section className="panel">
          <div className="table-scroll">
            <table className="data-table read-table">
              <thead>
                <tr>
                  <th>Merchandise</th>
                  <th>SKU / lineup</th>
                  <th>Owned</th>
                  <th>Select</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.name}
                      <span className="japanese" lang="ja">
                        {item.japaneseName}
                      </span>
                      {item.archived && <span className="badge">Archived</span>}
                    </td>
                    <td>
                      {item.internalSku}
                      <span className="japanese">{item.lineup.name}</span>
                    </td>
                    <td>{item.stock.total}</td>
                    <td>
                      <Link
                        className="button small"
                        href={`/admin/inventory/record?item=${item.id}&type=${initialType}`}
                      >
                        Select item
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.items.length && (
            <p className="empty-state">
              No catalogued items match your search.
            </p>
          )}
          <Pagination
            base="/admin/inventory/record"
            params={{ q: result.filters.q, type: initialType }}
            page={result.filters.page}
            pageCount={result.pageCount}
            size={result.filters.size}
            total={result.total}
          />
        </section>
      </>
    );
  }
  if (!z.uuid().safeParse(params.item).success) notFound();
  const item = await catalogQueries.detail(z.uuid().parse(params.item));
  if (!item) notFound();
  const tree = await locationQueries.tree();
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/inventory">Inventory</Link>
        <span>/</span>
        <Link href={`/admin/merchandise/catalog/${item.id}`}>{item.name}</Link>
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{item.internalSku}</p>
          <h1>Record inventory movement</h1>
          <p>{item.name}</p>
          <p className="muted">
            {item.stock.total} owned · {item.stock.fulfillable} fulfillable
          </p>
        </div>
        <Link
          className="button"
          href={`/admin/inventory/record?type=${initialType}`}
        >
          Change item
        </Link>
      </div>
      <section className="panel form-section">
        <h2 className="section-title">Current physical locations</h2>
        <ul className="inventory-location-list">
          {item.stock.locations.map((row) => (
            <li key={row.locationId}>
              <span>{row.path ?? row.code}</span>
              <strong>{row.quantity} units</strong>
              <small>
                {row.fulfillable ? "Fulfillable" : "Not fulfillable"}
              </small>
            </li>
          ))}
        </ul>
        {!item.stock.locations.length && (
          <p className="muted">No owned stock yet.</p>
        )}
      </section>
      {!tree.some((row) => row.effectiveActive) && (
        <p className="alert">
          No active destination exists.{" "}
          <Link className="source-link" href="/admin/inventory/locations/new">
            Create a storage location
          </Link>{" "}
          before receiving stock.
        </p>
      )}
      <InventoryCommandForm
        itemId={item.id}
        operationKey={randomUUID()}
        initialType={initialType}
        locations={tree.map((row) => ({
          id: row.id,
          path: row.path,
          effectiveActive: row.effectiveActive,
          quantity:
            item.stock.locations.find((stock) => stock.locationId === row.id)
              ?.quantity ?? 0,
        }))}
      />
    </>
  );
}
