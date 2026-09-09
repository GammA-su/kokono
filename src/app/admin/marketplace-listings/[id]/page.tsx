import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogQueries, marketplaceListingQueries } from "@/lib/admin";
import { ActionForm, Field } from "@/components/admin/action-form";
import { MediaImage } from "@/components/ui/media-image";
import { formatMoney } from "@/modules/shared/money";
import { editableStatuses } from "@/modules/marketplace-listings/validation";
import { priceComparisonLabel } from "@/modules/marketplace-listings/presentation";
import { changeCandidateStatus, markCandidateChecked } from "../actions";

export const metadata = { title: "Marketplace candidate" };
export default async function CandidateDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const row = await marketplaceListingQueries.detail((await params).id);
  if (!row) notFound();
  const item = await catalogQueries.detail(row.merchandiseItemId);
  if (!item) notFound();
  const query = await searchParams;
  return (
    <>
      <div className="breadcrumb">
        <Link href={`/admin/marketplace-listings?item=${item.id}`}>
          Marketplace candidates
        </Link>
        <span>/</span>
        {row.marketplace}
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRIVATE SOURCING</p>
          <h1>{item.name}</h1>
          <p lang="ja">{item.japaneseName}</p>
          <p>
            {row.marketplace} · {row.status}
          </p>
        </div>
        <div className="detail-actions">
          <a
            className="button"
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Open marketplace offer ↗
          </a>
          {!row.purchaseItem && !item.archived && (
            <Link
              className="button"
              href={`/admin/marketplace-listings/${row.id}/edit`}
            >
              Edit candidate
            </Link>
          )}
          {row.status === "AVAILABLE" && !item.archived && (
            <Link
              className="button primary"
              href={`/admin/marketplace-listings/${row.id}/convert`}
            >
              Convert to purchase
            </Link>
          )}
          {row.purchaseItem && (
            <Link
              className="button primary"
              href={`/admin/purchases/${row.purchaseItem.purchaseId}`}
            >
              Open purchase
            </Link>
          )}
        </div>
      </div>
      {(query.saved === "1" || query.checked === "1") && (
        <p className="alert" role="status">
          {query.checked === "1"
            ? "Candidate marked checked."
            : "Candidate saved."}
        </p>
      )}
      <section className="panel form-section">
        <MediaImage reference={item.images[0]?.storageKey} alt={item.name} />
        <h2>
          {formatMoney(row.itemPriceAmount, row.currency)} {row.currency}
        </h2>
        <p>
          Domestic shipping:{" "}
          {row.domesticShippingAmount === null
            ? "Unknown"
            : formatMoney(row.domesticShippingAmount, row.currency)}
        </p>
        <p>
          {priceComparisonLabel(
            row.itemPriceAmount,
            row.currency,
            item.purchaseWatch?.maxUnitPriceAmount ?? null,
            item.purchaseWatch?.maxUnitPriceCurrency ?? null,
            "Target max",
          )}
        </p>
        <p>
          {priceComparisonLabel(
            row.itemPriceAmount,
            row.currency,
            item.officialMsrpAmount,
            item.officialMsrpCurrency,
            "MSRP",
          )}
        </p>
        <p className="muted">
          Comparisons exclude shipping and fees. Confirm whether the offer price
          represents one item or a bundle.
          {item.purchaseWatch && !item.purchaseWatch.enabled
            ? " This purchase watch is disabled."
            : ""}
        </p>
        <dl className="fact-list">
          <div>
            <dt>Seller</dt>
            <dd>{row.sellerName ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>External listing ID</dt>
            <dd>{row.externalListingId ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Condition</dt>
            <dd>{row.condition ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Discovered</dt>
            <dd>{row.discoveredAt.toISOString()}</dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{row.lastCheckedAt?.toISOString() ?? "Never checked"}</dd>
          </div>
          <div>
            <dt>Recorded by</dt>
            <dd>{row.createdBy.name}</dd>
          </div>
        </dl>
        {row.notes && <p style={{ whiteSpace: "pre-wrap" }}>{row.notes}</p>}
        <div className="detail-actions">
          <Link className="button" href={`/admin/watchlist/${item.id}`}>
            Purchase watch
          </Link>
          <Link
            className="button"
            href={`/admin/merchandise/catalog/${item.id}`}
          >
            Catalog item
          </Link>
        </div>
        {row.purchaseItem && (
          <p className="alert">
            Linked purchase: {row.purchaseItem.purchase.status}. Stock changes
            only through purchase receipt. This source record stays linked even
            if the purchase is cancelled or refunded.
          </p>
        )}
      </section>
      <section className="panel form-section">
        <h2>Review offer</h2>
        <p className="muted">
          Open the marketplace and check the offer manually, then record the
          result here.
        </p>
        <ActionForm action={markCandidateChecked} submitLabel="Mark checked">
          <input type="hidden" name="id" value={row.id} />
        </ActionForm>
        {!row.purchaseItem && (
          <ActionForm
            action={changeCandidateStatus}
            submitLabel="Update status"
          >
            <input type="hidden" name="id" value={row.id} />
            <input
              type="hidden"
              name="version"
              value={row.updatedAt.toISOString()}
            />
            <Field name="status" label="New status">
              <select
                name="status"
                aria-label="New status"
                defaultValue={row.status}
              >
                {editableStatuses.map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </Field>
          </ActionForm>
        )}
      </section>
    </>
  );
}
