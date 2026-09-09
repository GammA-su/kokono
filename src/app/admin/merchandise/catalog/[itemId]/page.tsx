import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogQueries, landedCostQueries } from "@/lib/admin";
import { LandedPrice } from "@/components/admin/landed-price";
import { formatPartialDate } from "@/modules/catalog/partial-date";
import { formatMoney, formatOptionalMoney } from "@/modules/shared/money";
import { CatalogBadges, StatusBadge } from "@/components/ui/badge";
import { MediaImage } from "@/components/ui/media-image";
import { Icon } from "@/components/ui/icon";
import { PublishItemButton } from "@/components/admin/publish-item-button";
import { getPublicListing } from "@/modules/publication/queries";
import { storefrontProductUrl } from "@/modules/publication/http";
import { db } from "@/lib/db";
import { sourceLabels } from "@/components/admin/source-editor";

export const metadata = { title: "Merchandise item" };

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="fact-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function MerchandiseItemDetail({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  const item = await catalogQueries.detail(itemId);
  if (!item) notFound();
  const release = formatPartialDate(item.release.date, item.release.precision);
  const msrp = formatOptionalMoney(
    item.officialMsrpAmount,
    item.officialMsrpCurrency,
  );
  const watch = item.purchaseWatch;
  const listing = item.saleListing;
  const storeUrl =
    listing?.published &&
    storefrontProductUrl(listing.slug) &&
    (await getPublicListing(db, listing.slug))
      ? storefrontProductUrl(listing.slug)
      : null;
  const estimate = (await landedCostQueries.estimates([item.id]))[0];
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/catalog">Catalog</Link>
        <span>/</span>
        {item.name}
      </div>
      {item.archived && (
        <p className="alert">
          This item, its lineup or its franchise is archived. Stock and history
          are retained internally; public listings are hidden.
        </p>
      )}
      <section className="detail-heading">
        <MediaImage
          reference={item.images[0]?.storageKey}
          alt={item.name}
          large
        />
        <div className="detail-info">
          <p className="eyebrow">{item.lineup.franchise.name}</p>
          <h1>{item.name}</h1>
          {item.japaneseName && (
            <p className="japanese" lang="ja">
              {item.japaneseName}
            </p>
          )}
          <div className="detail-meta">
            <CatalogBadges statuses={item.statuses} />
            <StatusBadge status={item.lineup.status} />
            <span className="code-cell">{item.internalSku}</span>
          </div>
          <div className="detail-actions">
            <PublishItemButton itemId={item.id} />
            {storeUrl && (
              <a
                className="button"
                href={storeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open on Store
              </a>
            )}
            <Link className="button" href="/admin/publication">
              Publication readiness
            </Link>
            <Link
              className="button"
              href={`/admin/marketplace-listings?item=${item.id}`}
            >
              Marketplace offers
            </Link>
            <Link
              className="button"
              href={`/admin/merchandise/lineups/${item.lineupId}`}
            >
              Open lineup
            </Link>
            <Link
              className="button"
              href={`/admin/merchandise/lineups/${item.lineupId}/items/${item.id}/sources`}
            >
              Manage sources
            </Link>
            <Link
              className="button"
              href={`/admin/merchandise/catalog/${item.id}/movements`}
            >
              Movement history
              <span className="heading-count">{item.movementCount}</span>
            </Link>
          </div>
        </div>
      </section>

      <div className="detail-columns">
        <section className="panel form-section">
          <h2 className="section-title">Catalog</h2>
          <Facts
            rows={[
              ["English / display name", item.name],
              [
                "Japanese name",
                item.japaneseName && <span lang="ja">{item.japaneseName}</span>,
              ],
              [
                "Aliases",
                item.aliases.length ? item.aliases.join(" · ") : null,
              ],
              [
                "Characters",
                item.characters.length ? (
                  <span className="character-list">
                    {item.characters.map((character) => (
                      <span className="chip" key={character.id}>
                        {character.name}
                      </span>
                    ))}
                  </span>
                ) : null,
              ],
              ["Category", item.category.name],
              [
                "Lineup",
                <Link
                  key="lineup"
                  className="source-link"
                  href={`/admin/merchandise/lineups/${item.lineupId}`}
                >
                  {item.lineup.name}
                </Link>,
              ],
              ["Franchise", item.lineup.franchise.name],
              ["Manufacturer", item.manufacturer],
              [
                "Release",
                release && (
                  <>
                    {release}
                    {item.release.inherited && (
                      <span className="muted">
                        {" "}
                        · inherited from the lineup
                      </span>
                    )}
                  </>
                ),
              ],
              [
                "Official MSRP",
                msrp && (
                  <>
                    {msrp}
                    <span className="muted">
                      {" "}
                      · tax {item.officialMsrpTaxInclusion.toLowerCase()}
                    </span>
                  </>
                ),
              ],
              [
                "JAN",
                item.janCode && (
                  <span className="code-cell">{item.janCode}</span>
                ),
              ],
              [
                "Internal SKU",
                <span className="code-cell" key="sku">
                  {item.internalSku}
                </span>,
              ],
              [
                "Public slug",
                <span className="code-cell" key="slug">
                  {item.slug}
                </span>,
              ],
              ["Description", item.description],
              ["Private notes", item.privateNotes],
              [
                "Catalogued",
                `${item.createdAt.toISOString().slice(0, 10)} · updated ${item.updatedAt.toISOString().slice(0, 10)}`,
              ],
            ]}
          />
          <h3 className="subsection-title">
            Sources <span className="heading-count">{item.sources.length}</span>
          </h3>
          <ul className="source-list">
            {item.sources.map((source) => (
              <li key={source.id}>
                <div>
                  <a
                    className="source-link"
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.provider}
                    <Icon name="link" size={13} />
                  </a>
                  <div className="source-meta">
                    {sourceLabels[source.sourceType]} ·{" "}
                    {new URL(source.url).hostname}
                  </div>
                  {source.notes && (
                    <p className="source-meta">{source.notes}</p>
                  )}
                </div>
                <span className="badge">
                  {source.checkedAt
                    ? `Checked ${source.checkedAt.toISOString().slice(0, 10)}`
                    : "Not checked"}
                </span>
              </li>
            ))}
          </ul>
          {!item.sources.length && (
            <p className="muted small-copy">
              No sources recorded. Evidence links are managed per item.
            </p>
          )}
          <h3 className="subsection-title">
            Images <span className="heading-count">{item.images.length}</span>
          </h3>
          <div className="image-strip">
            {item.images.map((image) => (
              <figure key={image.id}>
                <MediaImage
                  reference={image.storageKey}
                  alt={image.caption ?? item.name}
                />
                <figcaption>
                  {image.imageRole.toLowerCase().replaceAll("_", " ")}
                  {image.approvedForPublicUse && (
                    <span className="badge catalog-live">Public</span>
                  )}
                  {image.sourceProvider && (
                    <span className="muted"> · {image.sourceProvider}</span>
                  )}
                </figcaption>
              </figure>
            ))}
            {!item.images.length && (
              <p className="muted small-copy">No images recorded.</p>
            )}
          </div>
        </section>

        <div className="form-stack">
          <section className="panel form-section">
            <h2 className="section-title">Sourcing</h2>
            <Link
              className="button small inventory-actions"
              href={`/admin/watchlist/${item.id}`}
            >
              {watch ? "Manage purchase watch" : "Create purchase watch"}
            </Link>
            {watch ? (
              <Facts
                rows={[
                  [
                    "Purchase watch",
                    <span
                      key="state"
                      className={`badge ${watch.enabled ? "catalog-watch" : ""}`}
                    >
                      {watch.enabled ? "Watching" : "Disabled"}
                    </span>,
                  ],
                  ["Priority", watch.priority.toLowerCase()],
                  ["Target quantity", watch.targetQuantity],
                  [
                    "Maximum unit price",
                    watch.maxUnitPriceAmount === null
                      ? null
                      : formatMoney(
                          watch.maxUnitPriceAmount,
                          watch.maxUnitPriceCurrency,
                        ),
                  ],
                  ["Condition preference", watch.conditionPreference],
                  [
                    "Marketplace search query",
                    watch.marketplaceSearchQuery && (
                      <span lang="ja">{watch.marketplaceSearchQuery}</span>
                    ),
                  ],
                  ["Notes", watch.notes],
                  [
                    "Last checked",
                    watch.lastCheckedAt?.toISOString().slice(0, 10),
                  ],
                ]}
              />
            ) : (
              <p className="muted small-copy">
                No purchase watch. Cataloguing an item never creates one.
              </p>
            )}
          </section>

          <section className="panel form-section">
            <h2 className="section-title">Inventory</h2>
            <div className="detail-actions inventory-actions">
              <Link
                className="button small"
                href={`/admin/inventory/record?item=${item.id}`}
              >
                Receive stock
              </Link>
              <Link
                className="button small"
                href={`/admin/inventory/record?item=${item.id}&type=TRANSFER`}
              >
                Transfer stock
              </Link>
              <Link
                className="button small"
                href={`/admin/inventory/record?item=${item.id}&type=ADJUSTMENT`}
              >
                Record change
              </Link>
            </div>
            <div className="metric-strip compact">
              <div className="metric">
                <strong>{item.stock.total.toLocaleString()}</strong>
                <span>Owned units</span>
              </div>
              <div className="metric">
                <strong>{item.stock.fulfillable.toLocaleString()}</strong>
                <span>Fulfillable units</span>
              </div>
              <div className="metric">
                <strong>{item.stock.locations.length}</strong>
                <span>Locations</span>
              </div>
            </div>
            {item.stock.locations.length ? (
              <table className="data-table location-table">
                <thead>
                  <tr>
                    <th>Storage location</th>
                    <th className="numeric">Units</th>
                    <th>Fulfillable</th>
                  </tr>
                </thead>
                <tbody>
                  {item.stock.locations.map((location) => (
                    <tr key={location.locationId}>
                      <td>
                        <Link
                          className="source-link"
                          href={`/admin/inventory?location=${location.locationId}`}
                        >
                          {location.path ?? location.name}
                        </Link>
                        {location.effectiveActive === false && (
                          <span className="badge">Inactive hierarchy</span>
                        )}
                        <span className="japanese">
                          {location.code} ·{" "}
                          {location.type.toLowerCase().replaceAll("_", " ")}
                        </span>
                      </td>
                      <td className="numeric count">
                        {location.quantity.toLocaleString()}
                      </td>
                      <td>
                        {location.fulfillable ? (
                          <span className="badge catalog-live">Yes</span>
                        ) : (
                          <span className="badge">No</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small-copy">
                No owned units. A catalog record never implies stock.
              </p>
            )}
            <Link
              className="text-button"
              href={`/admin/merchandise/catalog/${item.id}/movements`}
            >
              Movement history ({item.movementCount})
            </Link>
          </section>

          <section className="panel form-section">
            <h2 className="section-title">Sale</h2>
            <LandedPrice
              estimate={estimate}
              price={listing?.sellingPriceAmount}
              currency={listing?.sellingPriceCurrency}
              taxBasis={listing?.sellingPriceTaxInclusion ?? "UNKNOWN"}
            />
            {listing ? (
              <Facts
                rows={[
                  [
                    "Publication",
                    <span
                      key="state"
                      className={`badge ${listing.published && !item.archived ? "catalog-live" : ""}`}
                    >
                      {listing.published
                        ? item.archived
                          ? "Published · hidden while archived"
                          : "Published"
                        : "Draft"}
                    </span>,
                  ],
                  [
                    "Selling price",
                    formatMoney(
                      listing.sellingPriceAmount,
                      listing.sellingPriceCurrency,
                    ),
                  ],
                  ["Public title", listing.publicTitle],
                  [
                    "Public slug",
                    <span className="code-cell" key="slug">
                      {listing.slug}
                    </span>,
                  ],
                  ["Featured", listing.featured ? "Yes" : "No"],
                  [
                    "Last published",
                    listing.publishedAt?.toISOString().slice(0, 10),
                  ],
                  [
                    "Availability",
                    item.stock.fulfillable > 0
                      ? `${item.stock.fulfillable.toLocaleString()} fulfillable units`
                      : "Out of stock for fulfillment",
                  ],
                ]}
              />
            ) : (
              <p className="muted small-copy">
                No sale listing. The selling price is independent of the
                official MSRP.
              </p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
