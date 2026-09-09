import Link from "next/link";
import { catalogQueries, marketplaceListingQueries } from "@/lib/admin";
import { Pagination } from "@/components/admin/pagination";
import { MediaImage } from "@/components/ui/media-image";
import { formatMoney } from "@/modules/shared/money";
import { candidateStatuses } from "@/modules/marketplace-listings/validation";
import { priceComparisonLabel } from "@/modules/marketplace-listings/presentation";

export const metadata = { title: "Marketplace candidates" };
export default async function MarketplaceCandidates({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await marketplaceListingQueries.list(await searchParams);
  const ids = [...new Set(result.items.map((row) => row.merchandiseItemId))];
  const cards = ids.length ? await catalogQueries.selected(ids) : [];
  const byId = new Map(cards.map((card) => [card.id, card]));
  const selectedItem = result.filters.item
    ? await catalogQueries.detail(result.filters.item)
    : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRIVATE SOURCING</p>
          <h1>
            Marketplace candidates{" "}
            <span className="heading-count">{result.total}</span>
          </h1>
          <p className="muted">
            {selectedItem?.name ??
              "Manually discovered offers across the catalog"}
          </p>
        </div>
        <Link
          className="button primary"
          href={`/admin/marketplace-listings/new${selectedItem ? `?item=${selectedItem.id}` : ""}`}
        >
          Add marketplace candidate
        </Link>
      </div>
      <form method="get" className="panel form-section field-grid">
        {result.filters.item && (
          <input type="hidden" name="item" value={result.filters.item} />
        )}
        <label className="field">
          <span>Search offers</span>
          <input
            name="q"
            defaultValue={result.filters.q}
            maxLength={200}
            placeholder="Marketplace, seller or listing ID"
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select
            aria-label="Status"
            name="status"
            defaultValue={result.filters.status ?? ""}
          >
            <option value="">All statuses</option>
            {candidateStatuses.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button className="button" type="submit">
            Filter
          </button>
          <Link className="button" href="/admin/marketplace-listings">
            Reset
          </Link>
        </div>
      </form>
      <p className="muted small-copy">
        Comparisons use offer item prices, excluding shipping and fees, and
        require matching currencies. Verify whether an offer is for one item or
        a bundle.
      </p>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Merchandise</th>
                <th>Offer / seller</th>
                <th>Price / shipping</th>
                <th>Price comparison</th>
                <th>Condition / status</th>
                <th>Discovered / checked</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((row) => {
                const card = byId.get(row.merchandiseItemId),
                  watch = card?.purchaseWatch;
                return (
                  <tr key={row.id}>
                    <td>
                      <MediaImage
                        reference={card?.images[0]?.storageKey}
                        alt={card?.name ?? "Merchandise"}
                      />
                      <Link
                        href={`/admin/merchandise/catalog/${row.merchandiseItemId}`}
                      >
                        {card?.name ?? "Merchandise"}
                      </Link>
                      <div lang="ja" className="muted">
                        {card?.japaneseName}
                      </div>
                    </td>
                    <td>
                      <Link href={`/admin/marketplace-listings/${row.id}`}>
                        {row.marketplace}
                      </Link>
                      <div>{row.sellerName ?? "Seller unknown"}</div>
                      <small>{row.externalListingId}</small>
                      <div>
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          referrerPolicy="no-referrer"
                        >
                          Open offer ↗
                        </a>
                      </div>
                    </td>
                    <td>
                      <strong>
                        {formatMoney(row.itemPriceAmount, row.currency)}{" "}
                        {row.currency}
                      </strong>
                      <div className="muted">
                        Shipping:{" "}
                        {row.domesticShippingAmount === null
                          ? "Unknown"
                          : formatMoney(
                              row.domesticShippingAmount,
                              row.currency,
                            )}
                      </div>
                    </td>
                    <td>
                      <div>
                        {priceComparisonLabel(
                          row.itemPriceAmount,
                          row.currency,
                          watch?.maxUnitPriceAmount ?? null,
                          watch?.maxUnitPriceCurrency ?? null,
                          "Target max",
                        )}
                      </div>
                      <div className="muted">
                        {priceComparisonLabel(
                          row.itemPriceAmount,
                          row.currency,
                          card?.officialMsrpAmount ?? null,
                          card?.officialMsrpCurrency ?? null,
                          "MSRP",
                        )}
                      </div>
                      {watch && !watch.enabled && <small>Watch disabled</small>}
                    </td>
                    <td>
                      {row.status}
                      <div>{row.condition ?? "Not recorded"}</div>
                      {row.purchaseItem && (
                        <Link
                          href={`/admin/purchases/${row.purchaseItem.purchaseId}`}
                        >
                          Purchase · {row.purchaseItem.purchase.status}
                        </Link>
                      )}
                    </td>
                    <td>
                      {row.discoveredAt.toISOString().slice(0, 10)}
                      <div className="muted">
                        {row.lastCheckedAt?.toISOString().slice(0, 10) ??
                          "Never checked"}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!result.items.length && (
                <tr>
                  <td colSpan={6}>No marketplace candidates found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/marketplace-listings"
          params={result.filters}
          page={result.filters.page}
          pageCount={result.pageCount}
          total={result.total}
          size={result.size}
        />
      </section>
    </>
  );
}
