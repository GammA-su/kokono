import Link from "next/link";
import type { CatalogCard } from "@/modules/catalog/queries";
import { formatPartialDate } from "@/modules/catalog/partial-date";
import { formatOptionalMoney } from "@/modules/shared/money";
import { MediaImage } from "@/components/ui/media-image";
import { CatalogBadges } from "@/components/ui/badge";
import { ItemSelectionCheckbox } from "./bulk-selection";

/** Compact owned-stock summary: buckets by location family, with transit kept separate. */
function StockLine({ stock }: { stock: CatalogCard["stock"] }) {
  if (!stock.total) return <span className="muted">No owned stock</span>;
  return (
    <>
      <span className="stock-total">{stock.total.toLocaleString()} owned</span>
      {stock.buckets.map((bucket) => (
        <span
          key={bucket.label}
          className={`stock-chip ${bucket.transit ? "transit" : ""}`}
        >
          {bucket.label} {bucket.quantity.toLocaleString()}
        </span>
      ))}
      <span
        className={stock.fulfillable ? "stock-chip fulfillable" : "muted"}
        title="Units at locations explicitly enabled for fulfillment, excluding transit and inactive locations."
      >
        {stock.fulfillable.toLocaleString()} fulfillable
      </span>
    </>
  );
}

export function CatalogGrid({ items }: { items: CatalogCard[] }) {
  return (
    <div className="catalog-grid">
      {items.map((item) => {
        const href = `/admin/merchandise/catalog/${item.id}`;
        const msrp = formatOptionalMoney(
          item.officialMsrpAmount,
          item.officialMsrpCurrency,
        );
        const release = formatPartialDate(
          item.release.date,
          item.release.precision,
        );
        return (
          <article className="catalog-card" key={item.id}>
            <div className="catalog-selection">
              <ItemSelectionCheckbox id={item.id} name={item.name} />
            </div>
            <Link
              href={href}
              className="catalog-card-image"
              aria-label={`Open ${item.name}`}
              tabIndex={-1}
            >
              <MediaImage
                reference={item.images[0]?.storageKey}
                alt={item.name}
                large
              />
            </Link>
            <div className="catalog-card-body">
              <CatalogBadges statuses={item.statuses} />
              <h3>
                <Link href={href}>{item.name}</Link>
              </h3>
              {item.japaneseName && (
                <p className="japanese" lang="ja">
                  {item.japaneseName}
                </p>
              )}
              <p className="catalog-card-characters">
                {item.characters
                  .map((character) => character.name)
                  .join(" · ") || (
                  <span className="muted">No characters recorded</span>
                )}
              </p>
              <dl className="catalog-card-meta">
                <div>
                  <dt>Franchise</dt>
                  <dd>{item.lineup.franchise.name}</dd>
                </div>
                <div>
                  <dt>Lineup</dt>
                  <dd>{item.lineup.name}</dd>
                </div>
                <div>
                  <dt>Category</dt>
                  <dd>{item.category.name}</dd>
                </div>
                <div>
                  <dt>Release</dt>
                  <dd className="nowrap">
                    {release ?? <span className="muted">Not announced</span>}
                    {release && item.release.inherited && (
                      <span
                        className="muted"
                        title="Taken from the lineup; this item has no separate release date."
                      >
                        {" "}
                        · lineup
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>MSRP</dt>
                  <dd>
                    {msrp ?? <span className="muted">Not recorded</span>}
                    {msrp && item.officialMsrpTaxInclusion !== "UNKNOWN" && (
                      <span className="muted">
                        {" "}
                        · tax {item.officialMsrpTaxInclusion.toLowerCase()}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="catalog-card-stock">
                <StockLine stock={item.stock} />
              </p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
