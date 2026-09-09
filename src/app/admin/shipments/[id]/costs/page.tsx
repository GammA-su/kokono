import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { landedCostQueries } from "@/lib/admin";
import { shipmentNumber } from "@/modules/shipments/validation";
import { formatMoney } from "@/modules/shared/money";
import { ActionForm, Field } from "@/components/admin/action-form";
import { LandedCostEditor } from "@/components/admin/landed-cost-editor";
import { saveCostPolicy } from "./actions";
export const metadata = { title: "Landed-cost allocation" };
export default async function ShipmentCosts({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await landedCostQueries.inputs(id);
  if (!data) notFound();
  const { shipment, settings } = data;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LANDED COSTS</p>
          <h1>{shipmentNumber(shipment.number)} · Allocation</h1>
        </div>
        <div className="detail-actions">
          <Link className="button" href={`/admin/shipments/${id}`}>
            Shipment
          </Link>
          <Link className="button" href={`/admin/shipments/${id}/edit`}>
            Edit shipment charges
          </Link>
        </div>
      </div>
      <details className="panel form-section" open={!settings}>
        <summary>
          Accounting configuration{" "}
          {settings
            ? `· ${settings.currency} · VAT ${settings.importVatAsCost ? "included" : "excluded"}`
            : "required"}
        </summary>
        <ActionForm
          action={saveCostPolicy}
          submitLabel="Save costing configuration"
        >
          <input type="hidden" name="shipmentId" value={id} />
          <input
            type="hidden"
            name="version"
            value={settings?.updatedAt.toISOString() || ""}
          />
          <Field name="currency" label="Costing currency">
            <input
              aria-label="Costing currency"
              name="currency"
              required
              pattern="[A-Za-z]{3}"
              maxLength={3}
              defaultValue={settings?.currency || "EUR"}
            />
          </Field>
          <Field name="vat" label="Import VAT treatment">
            <select
              aria-label="Import VAT treatment"
              name="vat"
              required
              defaultValue={
                settings
                  ? settings.importVatAsCost
                    ? "include"
                    : "exclude"
                  : ""
              }
            >
              <option value="">Choose your accounting treatment</option>
              <option value="include">Include import VAT as cost</option>
              <option value="exclude">Exclude import VAT from cost</option>
            </select>
          </Field>
          <p className="muted">
            This configuration applies to future reviews. Finalized history
            retains its original policy. Choose the treatment used by your
            business; the application does not infer deductibility.
          </p>
        </ActionForm>
      </details>
      {!shipment.shipmentDate ? (
        <p className="alert">
          Dispatch the shipment before allocating its locked contents.
        </p>
      ) : settings ? (
        <LandedCostEditor
          id={randomUUID()}
          shipmentId={id}
          items={shipment.items}
          batches={data.batches}
          currency={settings.currency}
          previous={data.previous}
          usedRanges={data.usedRanges}
          sourceCurrencies={[
            ...data.batches.map((batch) => batch.purchase.currency),
            shipment.shippingCurrency,
            shipment.importCurrency,
          ].filter((value): value is string => !!value)}
        />
      ) : (
        <p className="alert">Save the accounting configuration to begin.</p>
      )}
      <section className="panel form-section">
        <h2>Finalized history</h2>
        {!data.history.length ? (
          <p>No finalized allocations yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Method</th>
                  <th>Total landed cost</th>
                  <th>Finalized</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/admin/shipments/${id}/costs/${row.id}`}>
                        Version {row.revision}
                      </Link>
                    </td>
                    <td>{row.method}</td>
                    <td>
                      {formatMoney(BigInt(row.totalAmount), row.currency)}
                    </td>
                    <td>{row.createdAt.toISOString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
