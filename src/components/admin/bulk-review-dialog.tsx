"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BulkReview, BulkResult } from "@/modules/bulk-management/service";
import { actionLabels } from "@/modules/bulk-management/selection";
import { executeMerchandiseBatch } from "@/modules/bulk-management/actions";
import { formatMoney, moneyInputValue } from "@/modules/shared/money";
import { PublicationFields } from "./publication-fields";
import { MediaImage } from "@/components/ui/media-image";
import { LandedPrice } from "./landed-price";

type Values = Record<string, unknown>;
function Currency({
  value,
  onChange,
  label = "Currency",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={value}
        maxLength={3}
        pattern="[A-Z]{3}"
        required
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
    </label>
  );
}
export function BulkReviewDialog({
  review,
  onClose,
}: {
  review: BulkReview;
  onClose: (completed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<BulkResult>();
  const [confirmed, setConfirmed] = useState(false);
  const [defaults, setDefaults] = useState<Values>({
    enabled: true,
    priority: "NORMAL",
    watchCurrency: "JPY",
    sellingCurrency: "EUR",
    costCurrency: "JPY",
  });
  const [rows, setRows] = useState<Record<string, Values>>(() =>
    Object.fromEntries(
      review.items.map((item) => [
        item.id,
        review.action === "publish"
          ? {
              slug: item.saleListing?.slug ?? item.publication?.slug ?? "",
              publicDescription:
                item.publication?.listing?.publicDescription ?? "",
              publicSubtitle: item.publication?.listing?.publicSubtitle ?? "",
              seoTitle: item.publication?.listing?.seoTitle ?? "",
              seoDescription: item.publication?.listing?.seoDescription ?? "",
              publicCategoryId:
                item.publication?.listing?.publicCategoryId ?? null,
              imageIds: item.publication?.selectedImageIds ?? [],
              featured: item.saleListing?.featured ?? false,
              published: true,
              sellingPriceTaxInclusion:
                item.publication?.listing?.sellingPriceTaxInclusion ??
                "UNKNOWN",
              publicTitle: item.saleListing?.publicTitle ?? item.name,
              sellingCurrency: item.saleListing?.sellingPriceCurrency ?? "EUR",
              sellingPrice: item.saleListing
                ? moneyInputValue(
                    item.saleListing.sellingPriceAmount,
                    item.saleListing.sellingPriceCurrency,
                  )
                : "",
              skip: item.archived,
            }
          : {},
      ]),
    ),
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const change = (key: string, value: unknown) =>
    setDefaults((old) => ({ ...old, [key]: value }));
  const rowChange = (id: string, key: string, value: unknown) =>
    setRows((old) => ({ ...old, [id]: { ...old[id], [key]: value } }));
  const override = (id: string, key: string, value: unknown) =>
    setRows((old) => {
      const next = { ...old[id] };
      if (value === "") delete next[key];
      else next[key] = value;
      return { ...old, [id]: next };
    });
  const action = review.action;
  const stockAction = ["receive", "transfer", "adjust"].includes(action);
  const requiresConfirmation = action === "archive" || action === "publish";
  const textField = (key: string, label: string, required = false) => (
    <label className="field">
      <span>{label}</span>
      <input
        required={required}
        value={String(defaults[key] ?? "")}
        onChange={(e) => change(key, e.target.value)}
      />
    </label>
  );
  const locationField = (key: string, label: string) => (
    <label className="field">
      <span>{label}</span>
      <select
        required
        value={String(defaults[key] ?? "")}
        onChange={(e) => change(key, e.target.value)}
      >
        <option value="">Choose location</option>
        {review.locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.code} · {location.name}
          </option>
        ))}
      </select>
    </label>
  );
  const close = () => {
    if (!pending) {
      if (result) router.refresh();
      onClose(Boolean(result));
    }
  };
  function download(csv: string) {
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "merchandise-selection.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <dialog
      ref={dialog}
      className={`bulk-review-dialog ${action === "publish" ? "publication-review-dialog" : ""}`}
      aria-labelledby="bulk-review-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="panel-heading">
        <h2 id="bulk-review-title">
          {action === "publish" ? "Publication review" : actionLabels[action]}
        </h2>
        <button
          type="button"
          className="button small"
          disabled={pending}
          onClick={close}
        >
          Close
        </button>
      </div>
      <div className="bulk-review-body">
        <p>
          <strong>
            {review.items.length} items in this fixed server selection.
          </strong>{" "}
          {review.selectionMode === "lineup"
            ? "Includes all pages of the lineup at the time review opened."
            : "Resolved using your catalog view and selection."}{" "}
          Items added later are not included. Review expires after 20 minutes.
        </p>
        {review.omitted > 0 && (
          <p className="alert">
            {review.omitted} selected items no longer match the current view and
            were omitted.
          </p>
        )}
        <p className="muted small-copy">
          Each item is processed separately; valid items can succeed when
          another fails. Every transfer and its movement record are saved
          atomically. Maximum 1,000 items per batch.
        </p>
        {error && (
          <p role="alert" className="alert error">
            {error}
          </p>
        )}
        {result && (
          <section className="bulk-results" aria-live="polite">
            <h3>
              {result.updated} {action === "export" ? "exported" : "updated"} ·{" "}
              {result.skipped} skipped · {result.failed} failed
            </h3>
            {result.csv && (
              <button className="button" onClick={() => download(result.csv!)}>
                Download CSV
              </button>
            )}
            <details open={result.failed > 0 || result.skipped > 0}>
              <summary>Per-item results</summary>
              <ul>
                {result.results.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.name}</strong> — {entry.status}
                    {entry.reason ? `: ${entry.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
            {result.failed > 0 && (
              <p>
                Correct failed rows below and retry. Successful and skipped rows
                will not be resubmitted. If review is stale, close and start a
                new review.
              </p>
            )}
          </section>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              setError(undefined);
              try {
                const response = await executeMerchandiseBatch({
                  token: review.token,
                  defaults,
                  confirmed,
                  rows: review.items.map((item) => ({
                    id: item.id,
                    values: {
                      ...rows[item.id],
                      ...(result &&
                      result.results.find((r) => r.id === item.id)?.status !==
                        "failed"
                        ? { skip: true }
                        : {}),
                    },
                  })),
                });
                if (response.result) {
                  const next = response.result;
                  // Keep original success outcomes when retrying only the failed subset.
                  if (result) {
                    next.results = next.results.map(
                      (row) =>
                        result.results.find(
                          (prior) =>
                            prior.id === row.id && prior.status !== "failed",
                        ) ?? row,
                    );
                    next.updated = next.results.filter(
                      (row) => row.status === "updated",
                    ).length;
                    next.skipped = next.results.filter(
                      (row) => row.status === "skipped",
                    ).length;
                    next.failed = next.results.filter(
                      (row) => row.status === "failed",
                    ).length;
                  }
                  setResult(next);
                } else setError(response.error);
              } catch {
                setError(
                  "Connection interrupted. Retry this review; stock operation keys prevent duplicate movements.",
                );
              }
            });
          }}
        >
          <fieldset
            className="form-fieldset"
            disabled={pending || Boolean(result && !result.failed)}
          >
            <div className="bulk-defaults">
              {action === "receive" && (
                <>
                  {locationField(
                    "destinationLocationId",
                    "Destination storage location",
                  )}
                  {textField("cost", "Default purchase unit cost (optional)")}
                  <Currency
                    label="Purchase currency"
                    value={String(defaults.costCurrency)}
                    onChange={(v) => change("costCurrency", v)}
                  />
                  {textField("reference", "Purchase reference (optional)")}
                  {textField("note", "Note (optional)")}
                </>
              )}
              {action === "transfer" && (
                <>
                  {locationField("sourceLocationId", "Source location")}
                  {locationField(
                    "destinationLocationId",
                    "Destination location",
                  )}
                  {textField("note", "Note (optional)")}
                </>
              )}
              {action === "adjust" && (
                <>
                  {locationField("locationId", "Storage location")}
                  {textField("note", "Required adjustment reason", true)}
                </>
              )}
              {action === "watch" && (
                <>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={Boolean(defaults.enabled)}
                      onChange={(e) => change("enabled", e.target.checked)}
                    />{" "}
                    Enable watch
                  </label>
                  <label className="field">
                    <span>Default priority</span>
                    <select
                      value={String(defaults.priority)}
                      onChange={(e) => change("priority", e.target.value)}
                    >
                      {["LOW", "NORMAL", "HIGH", "URGENT"].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Default target quantity (optional)</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={String(defaults.targetQuantity ?? "")}
                      onChange={(e) =>
                        change(
                          "targetQuantity",
                          e.target.value ? Number(e.target.value) : null,
                        )
                      }
                    />
                  </label>
                  {textField(
                    "maximumPrice",
                    "Maximum unit purchase price (optional)",
                  )}
                  <Currency
                    label="Watch currency"
                    value={String(defaults.watchCurrency)}
                    onChange={(v) => change("watchCurrency", v)}
                  />
                  {textField(
                    "conditionPreference",
                    "Condition preference (optional)",
                  )}
                </>
              )}
              {action === "price" && (
                <>
                  {textField("sellingPrice", "Selling price", true)}
                  <Currency
                    value={String(defaults.sellingCurrency)}
                    onChange={(v) => change("sellingCurrency", v)}
                  />
                </>
              )}
              {action === "category" && (
                <label className="field">
                  <span>Category</span>
                  <select
                    required
                    value={String(defaults.categoryId ?? "")}
                    onChange={(e) => change("categoryId", e.target.value)}
                  >
                    <option value="">Choose category</option>
                    {review.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {stockAction && (
              <p className="small-copy">
                Enter a quantity for every included item.{" "}
                {action === "adjust"
                  ? "Use a signed change, such as +2 or -1; this is not a replacement stock total."
                  : "Quantities are intentionally blank so each item can receive or transfer a different amount."}
              </p>
            )}
            {action === "watch" && (
              <p className="small-copy">
                Blank overrides inherit shared defaults. Blank default
                quantity/price removes those limits; sourcing notes and search
                queries are preserved.
              </p>
            )}
            {action === "publish" && (
              <p className="alert">
                Review each public title, unique URL slug and selling price.
                Missing data must be completed or the item excluded. Archived
                records cannot be published. Zero stock is allowed; this does
                not create stock.
              </p>
            )}
            {action === "archive" && (
              <p className="alert">
                Archive removes items from active catalog views and hides their
                public listings. Owned stock, purchase watches and movement
                history are retained.
              </p>
            )}
            {action === "price" && (
              <p className="small-copy">
                Prices update existing listings only. Items without a listing
                are skipped; use publication review to create a listing.
              </p>
            )}
            <div className="table-scroll bulk-review-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Include</th>
                    <th>Merchandise item</th>
                    <th>Stock by location</th>
                    {stockAction && (
                      <th>
                        {action === "adjust" ? "Signed adjustment" : "Quantity"}
                      </th>
                    )}
                    {action === "receive" && <th>Unit cost override</th>}
                    {action === "watch" && <th>Per-item watch overrides</th>}
                    {action === "publish" && (
                      <>
                        <th>Public listing configuration</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {review.items.map((item) => {
                    const values = rows[item.id] ?? {};
                    const locked = Boolean(
                      result &&
                      result.results.find((r) => r.id === item.id)?.status !==
                        "failed",
                    );
                    const included = values.skip !== true;
                    const inputDisabled = locked || !included;
                    return (
                      <tr key={item.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Include ${item.name}`}
                            checked={included}
                            disabled={
                              locked || (action === "publish" && item.archived)
                            }
                            onChange={(e) =>
                              rowChange(item.id, "skip", !e.target.checked)
                            }
                          />
                        </td>
                        <td>
                          <Link
                            href={`/admin/merchandise/catalog/${item.id}`}
                            target="_blank"
                          >
                            {item.name}
                          </Link>
                          {action === "publish" && (
                            <>
                              <MediaImage
                                reference={
                                  item.publication?.images.find(
                                    (image) =>
                                      image.approved &&
                                      image.deliverable &&
                                      (
                                        values.imageIds as string[] | undefined
                                      )?.includes(image.id),
                                  )?.storageKey
                                }
                                alt={item.name}
                              />
                              <div>
                                {item.characters
                                  .map((entry) => entry.name)
                                  .join(", ")}
                              </div>
                              <div>
                                MSRP:{" "}
                                {item.officialMsrpAmount !== null &&
                                item.officialMsrpCurrency
                                  ? formatMoney(
                                      item.officialMsrpAmount,
                                      item.officialMsrpCurrency,
                                    )
                                  : "Unavailable"}
                              </div>
                              <div>
                                Listing:{" "}
                                {item.saleListing
                                  ? item.saleListing.published
                                    ? "Published"
                                    : "Draft"
                                  : "Not configured"}
                              </div>
                            </>
                          )}
                          <div className="muted small-copy">
                            {item.internalSku}
                          </div>
                          {(action === "publish" || action === "price") && (
                            <LandedPrice
                              estimate={item.landedEstimate}
                              taxBasis={
                                action === "publish"
                                  ? (values.sellingPriceTaxInclusion as
                                      "UNKNOWN" | "INCLUDED" | "EXCLUDED")
                                  : item.saleListing?.sellingPriceTaxInclusion ?? "UNKNOWN"
                              }
                              priceText={String(
                                values.sellingPrice ??
                                  defaults.sellingPrice ??
                                  "",
                              )}
                              currency={String(
                                values.sellingCurrency ??
                                  defaults.sellingCurrency ??
                                  "EUR",
                              )}
                            />
                          )}
                          {action === "publish" && (
                            <div
                              className={
                                (
                                  item.publication?.issues ??
                                  item.publicationIssues
                                ).length
                                  ? "field-error"
                                  : "muted small-copy"
                              }
                            >
                              {(
                                item.publication?.issues ??
                                item.publicationIssues
                              ).join(" ") ||
                                "Listing data available for review."}
                            </div>
                          )}
                          {item.saleListing && (
                            <div className="muted small-copy">
                              Current selling price:{" "}
                              {formatMoney(
                                item.saleListing.sellingPriceAmount,
                                item.saleListing.sellingPriceCurrency,
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          <strong>
                            {item.stock.total} owned · {item.stock.fulfillable}{" "}
                            fulfillable globally
                            {action === "publish" && (
                              <span>
                                {" "}
                                / {item.franceQuantity} available to France
                              </span>
                            )}
                          </strong>
                          <div className="small-copy">
                            {item.stock.locations
                              .map((l) => `${l.path || l.code}: ${l.quantity}`)
                              .join("; ") || "No stock"}
                          </div>
                        </td>
                        {stockAction && (
                          <td>
                            <input
                              aria-label={`${item.name} quantity`}
                              type="number"
                              step={1}
                              min={action === "adjust" ? -2147483647 : 1}
                              max={2147483647}
                              required={!inputDisabled}
                              disabled={inputDisabled}
                              value={String(values.quantity ?? "")}
                              onChange={(e) =>
                                rowChange(
                                  item.id,
                                  "quantity",
                                  e.target.value === ""
                                    ? undefined
                                    : Number(e.target.value),
                                )
                              }
                            />
                          </td>
                        )}
                        {action === "receive" && (
                          <td>
                            <input
                              aria-label={`${item.name} unit cost override`}
                              disabled={inputDisabled}
                              placeholder="Use shared cost"
                              value={String(values.cost ?? "")}
                              onChange={(e) =>
                                override(item.id, "cost", e.target.value)
                              }
                            />
                          </td>
                        )}
                        {action === "watch" && (
                          <td>
                            <details>
                              <summary>Override defaults</summary>
                              <div className="bulk-row-overrides">
                                <label className="field">
                                  <span>Enabled</span>
                                  <select
                                    disabled={inputDisabled}
                                    value={
                                      values.enabled === undefined
                                        ? ""
                                        : String(values.enabled)
                                    }
                                    onChange={(e) =>
                                      override(
                                        item.id,
                                        "enabled",
                                        e.target.value === ""
                                          ? ""
                                          : e.target.value === "true",
                                      )
                                    }
                                  >
                                    <option value="">Shared default</option>
                                    <option value="true">Enabled</option>
                                    <option value="false">Disabled</option>
                                  </select>
                                </label>
                                <label className="field">
                                  <span>Priority</span>
                                  <select
                                    disabled={inputDisabled}
                                    value={String(values.priority ?? "")}
                                    onChange={(e) =>
                                      override(
                                        item.id,
                                        "priority",
                                        e.target.value,
                                      )
                                    }
                                  >
                                    <option value="">Shared default</option>
                                    {["LOW", "NORMAL", "HIGH", "URGENT"].map(
                                      (v) => (
                                        <option key={v}>{v}</option>
                                      ),
                                    )}
                                  </select>
                                </label>
                                <label className="field">
                                  <span>Target quantity</span>
                                  <input
                                    disabled={inputDisabled}
                                    type="number"
                                    min={1}
                                    step={1}
                                    placeholder="Shared default"
                                    value={String(values.targetQuantity ?? "")}
                                    onChange={(e) =>
                                      override(
                                        item.id,
                                        "targetQuantity",
                                        e.target.value === ""
                                          ? ""
                                          : Number(e.target.value),
                                      )
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span>Maximum purchase price</span>
                                  <input
                                    disabled={inputDisabled}
                                    placeholder="Shared default"
                                    value={String(values.maximumPrice ?? "")}
                                    onChange={(e) =>
                                      override(
                                        item.id,
                                        "maximumPrice",
                                        e.target.value,
                                      )
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span>Condition preference</span>
                                  <input
                                    disabled={inputDisabled}
                                    placeholder="Shared default"
                                    value={String(
                                      values.conditionPreference ?? "",
                                    )}
                                    onChange={(e) =>
                                      override(
                                        item.id,
                                        "conditionPreference",
                                        e.target.value,
                                      )
                                    }
                                  />
                                </label>
                              </div>
                            </details>
                          </td>
                        )}
                        {action === "publish" && (
                          <td>
                            <PublicationFields
                              item={item}
                              categories={review.publicCategories}
                              values={values}
                              disabled={inputDisabled}
                              onChange={(key, value) =>
                                rowChange(item.id, key, value)
                              }
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {requiresConfirmation && (
              <label className="checkbox-label bulk-confirm">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {action === "archive"
                  ? "I confirm archiving the included items while retaining their inventory history."
                  : "I reviewed the included listings and confirm their chosen publication states."}
              </label>
            )}
            <div className="form-actions">
              <button
                className={`button ${action === "archive" ? "danger" : "primary"}`}
                disabled={pending || (requiresConfirmation && !confirmed)}
              >
                {pending
                  ? "Processing batch…"
                  : result?.failed
                    ? "Retry failed items"
                    : action === "publish"
                      ? "Save reviewed listings"
                      : action === "export"
                        ? "Prepare CSV export"
                        : `Apply ${actionLabels[action].toLowerCase()}`}
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </dialog>
  );
}
