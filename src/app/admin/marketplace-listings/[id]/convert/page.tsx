import { notFound } from "next/navigation";
import Link from "next/link";
import { catalogQueries, marketplaceListingQueries } from "@/lib/admin";
import { ActionForm, Field } from "@/components/admin/action-form";
import { formatMoney, moneyInputValue } from "@/modules/shared/money";
import { convertCandidate } from "../../actions";
export const metadata = { title: "Convert candidate to purchase" };
export default async function ConvertCandidate({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const row = await marketplaceListingQueries.detail((await params).id);
  if (!row) notFound();
  const item = await catalogQueries.detail(row.merchandiseItemId);
  if (!item) notFound();
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Convert candidate to purchase</h1>
          <p>
            {item.name} · {row.marketplace}
          </p>
        </div>
      </div>
      <section className="panel form-section">
        {row.purchaseItem ? (
          <p>
            Already converted.{" "}
            <Link href={`/admin/purchases/${row.purchaseItem.purchaseId}`}>
              Open purchase
            </Link>
            .
          </p>
        ) : row.status !== "AVAILABLE" || item.archived ? (
          <p>
            Only available offers for active merchandise can be converted.{" "}
            <Link href={`/admin/marketplace-listings/${row.id}`}>
              Review candidate
            </Link>
            .
          </p>
        ) : (
          <>
            <p>
              Record a purchase placed with the seller. Receiving it remains a
              separate action when the goods arrive.
            </p>
            <p>
              Recorded offer price:{" "}
              {formatMoney(row.itemPriceAmount, row.currency)}. All amounts
              below are in <strong>{row.currency}</strong>.
            </p>
            <ActionForm
              action={convertCandidate}
              submitLabel="Create purchase"
              cancelHref={`/admin/marketplace-listings/${row.id}`}
            >
              <input type="hidden" name="id" value={row.id} />
              <input
                type="hidden"
                name="version"
                value={row.updatedAt.toISOString()}
              />
              <div className="field-grid">
                <Field name="supplier" label="Supplier / seller">
                  <input
                    name="supplier"
                    required
                    maxLength={500}
                    defaultValue={row.sellerName ?? ""}
                  />
                </Field>
                <Field name="externalReference" label="Order reference">
                  <input name="externalReference" maxLength={20000} />
                </Field>
                <Field name="purchaseDate" label="Purchase date">
                  <input
                    name="purchaseDate"
                    type="date"
                    required
                    defaultValue={new Date().toISOString().slice(0, 10)}
                  />
                </Field>
                <Field name="status" label="Purchase status">
                  <select name="status" aria-label="Purchase status">
                    <option value="ORDERED">Ordered</option>
                    <option value="PAID">Paid</option>
                  </select>
                </Field>
                <Field name="quantity" label="Quantity">
                  <input
                    name="quantity"
                    type="number"
                    min={1}
                    max={1000000}
                    step={1}
                    defaultValue={1}
                    required
                  />
                </Field>
                <Field
                  name="unitPrice"
                  label="Actual unit purchase price"
                  hint="For a bundle, enter the per-unit price for the quantity above. Verify this before confirming."
                >
                  <input
                    aria-label="Actual unit purchase price"
                    name="unitPrice"
                    inputMode="decimal"
                    defaultValue={moneyInputValue(
                      row.itemPriceAmount,
                      row.currency,
                    )}
                    required
                  />
                </Field>
                <Field
                  name="domesticShipping"
                  label="Domestic shipping"
                  hint="Required, including when unknown on the offer. Enter 0 only for free or included shipping."
                >
                  <input
                    aria-label="Domestic shipping"
                    name="domesticShipping"
                    inputMode="decimal"
                    defaultValue={
                      row.domesticShippingAmount === null
                        ? ""
                        : moneyInputValue(
                            row.domesticShippingAmount,
                            row.currency,
                          )
                    }
                    required
                  />
                </Field>
                <Field name="fees" label="Marketplace / proxy fees">
                  <input
                    name="fees"
                    inputMode="decimal"
                    defaultValue="0"
                    required
                  />
                </Field>
                <Field name="taxes" label="Additional taxes">
                  <input
                    name="taxes"
                    inputMode="decimal"
                    defaultValue="0"
                    required
                  />
                </Field>
                <Field name="notes" label="Purchase notes" full>
                  <textarea name="notes" rows={3} maxLength={20000} />
                </Field>
              </div>
              <label>
                <input type="checkbox" name="confirm" required /> I placed this
                purchase and verified the quantity, unit price and charges.
              </label>
            </ActionForm>
          </>
        )}
      </section>
    </>
  );
}
