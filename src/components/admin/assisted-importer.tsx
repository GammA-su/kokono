"use client";
import { cloneElement, useState, useTransition, type ReactElement } from "react";
import Link from "next/link";
import {
  assistedOptions,
  extractMerchandise,
  reviewExtractedMerchandise,
  importExtractedMerchandise,
} from "@/modules/assisted-import/actions";
import type {
  Extraction,
  ImportReview,
} from "@/modules/assisted-import/service";
import type { Candidate } from "@/modules/assisted-import/types";
import { SourceType } from "@/generated/prisma/enums";
import { CharacterPicker } from "./character-picker";

type Options = {
  franchises: { id: string; name: string }[];
  lineups: { id: string; name: string; franchiseId: string }[];
};
function Field({ label, children }: { label: string; children: ReactElement<{"aria-label"?: string}> }) {
  return (
    <label className="field">
      <span>{label}</span>
      {cloneElement(children, {"aria-label": label})}
    </label>
  );
}
export function AssistedImporter({
  initialOptions,
  initialLineup,
}: {
  initialOptions: Options;
  initialLineup: string;
}) {
  const [options, setOptions] = useState(initialOptions);
  const [lineupId, setLineup] = useState(initialLineup);
  const [franchiseId, setFranchise] = useState(
    initialOptions.lineups.find((l) => l.id === initialLineup)?.franchiseId ??
      "",
  );
  const [provider, setProvider] = useState("");
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] =
    useState<Candidate["sources"][number]["sourceType"]>("MANUFACTURER");
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [rows, setRows] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [summary, setSummary] = useState<{
    created: number;
    skipped: number;
    lineupId: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<void>) => {
    setError("");
    start(async () => {
      try {
        await fn();
      } catch {
        setError(
          "The request was interrupted. Your source URL is preserved. Retry; confirming the same reviewed batch will not insert it twice.",
        );
      }
    });
  };
  const change = (key: string, patch: Partial<Candidate>) => {
    setReview(null);
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };
  const reset = () => {
    setExtraction(null);
    setReview(null);
    setSummary(null);
    setSelected([]);
    setRows([]);
    setError("");
  };
  return (
    <div className="form-stack" aria-busy={pending}>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!extraction && (
        <form
          className="panel form-section"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              const result = await extractMerchandise({
                franchiseId,
                lineupId,
                provider,
                sourceType,
                url,
              });
              if (result.error) setError(result.error);
              else if (result.extraction) {
                setExtraction(result.extraction);
                setRows(result.extraction.candidates);
                setSelected([]);
              }
            });
          }}
        >
          <fieldset className="form-fieldset" disabled={pending}>
            <h2 className="section-title">1. Choose destination and source</h2>
            <div className="field-grid">
              <Field label="Franchise">
                <select
                  required
                  value={franchiseId}
                  onChange={(e) => {
                    setFranchise(e.target.value);
                    setLineup("");
                  }}
                >
                  <option value="">Choose franchise</option>
                  {options.franchises.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Existing lineup">
                <select
                  required
                  value={lineupId}
                  onChange={(e) => setLineup(e.target.value)}
                >
                  <option value="">Choose lineup</option>
                  {options.lineups
                    .filter((l) => l.franchiseId === franchiseId)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Source provider">
                <input
                  required
                  maxLength={200}
                  list="source-providers"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                />
              </Field>
              <Field label="Source type">
                <select
                  value={sourceType}
                  onChange={(e) =>
                    setSourceType(e.target.value as typeof sourceType)
                  }
                >
                  {Object.values(SourceType).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </Field>
              <Field label="Official source URL">
                <input
                  required
                  type="url"
                  placeholder="https://…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
            </div>
            <datalist id="source-providers">
              {[
                "KADOKAWA",
                "Animate",
                "Good Smile Company",
                "AmiAmi",
                "COSPA",
                "Movic",
                "Ichiban Kuji",
              ].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <p>
              Need a new lineup?{" "}
              <Link
                className="source-link"
                href="/admin/merchandise/lineups/new"
                target="_blank"
                rel="noopener noreferrer"
              >
                Create a lineup in a new tab
              </Link>
              , return here, then{" "}
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  run(async () => {
                    const result = await assistedOptions();
                    if (result.options) setOptions(result.options);
                    else setError(result.error ?? "Could not reload lineups.");
                  })
                }
              >
                Refresh lineups
              </button>
              . Your source inputs stay here.
            </p>
            <p className="table-note">
              Supports structured products and a low-confidence page-title
              fallback. JavaScript-only pages may need a dedicated adapter or
              manual entry. Selecting a provider records attribution; it does
              not independently verify the page is official.
            </p>
            <div className="form-actions">
              <button className="button primary" type="submit">
                {pending ? "Extracting…" : "Extract candidates"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {extraction && !summary && (
        <fieldset className="form-fieldset form-stack" disabled={pending}>
          <div className="page-heading">
            <div>
              <h2>2. Review {rows.length} candidates</h2>
              <p className="muted">
                Nothing has been imported. All candidates start unselected.
                Reviews expire after 30 minutes.
              </p>
              <p>
                {provider} · {url}
              </p>
            </div>
            <button className="button" type="button" onClick={reset}>
              Change source / retry
            </button>
          </div>
          <p className="alert">
            Japanese names are preserved separately from display names. Confirm
            character/category suggestions and unresolved names. Images remain
            unapproved for public use. A source-page link is retained even if
            you edit the additional source information.
          </p>
          <div className="dashboard-actions">
            <strong>{selected.length} selected</strong>
            <button
              type="button"
              className="button"
              onClick={() => {
                setSelected(rows.map((r) => r.key));
                setReview(null);
              }}
            >
              Select all candidates
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setSelected([]);
                setReview(null);
              }}
            >
              Clear selection
            </button>
          </div>
          <div className="panel table-scroll">
            <table className="data-table assisted-table">
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Candidate / review signals</th>
                  <th>Editable merchandise fields</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.key}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select candidate ${index + 1}`}
                        checked={selected.includes(row.key)}
                        onChange={(e) => {
                          setSelected((current) =>
                            e.target.checked
                              ? [...current, row.key]
                              : current.filter((id) => id !== row.key),
                          );
                          setReview(null);
                        }}
                      />
                    </td>
                    <td>
                      <strong>
                        Candidate {index + 1}: {row.name || "Missing name"}
                      </strong>
                      <p>
                        <span className="badge">
                          {row.confidence === "low"
                            ? "Low confidence"
                            : "Structured candidate"}
                        </span>
                      </p>
                      {row.warnings.map((message, i) => (
                        <p key={i} className="table-note">
                          {message}
                        </p>
                      ))}
                      {extraction.issues
                        .filter((issue) => issue.row === index + 1)
                        .map((issue, i) => (
                          <p className="field-error" key={i}>
                            Extraction: {issue.message}
                          </p>
                        ))}
                      {extraction.duplicates
                        .filter((w) => w.row === index + 1)
                        .map((w, i) => (
                          <p key={i}>{w.message}</p>
                        ))}
                      {row.images.map((image, i) => (
                        <div
                          className="assisted-image"
                          key={`${i}-${image.url}`}
                        >
                          {/* Images use the authenticated, bounded SSRF-safe proxy; source HTML is never embedded. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            loading="lazy"
                            src={`/api/admin/source-image?url=${encodeURIComponent(image.url)}`}
                            alt={`Source image ${i + 1} for ${row.name}`}
                          />
                        </div>
                      ))}
                    </td>
                    <td>
                      <div className="assisted-fields">
                        <Field label="Display name">
                          <input
                            value={row.name}
                            onChange={(e) =>
                              change(row.key, { name: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Japanese product name">
                          <input
                            value={row.japaneseName}
                            onChange={(e) =>
                              change(row.key, { japaneseName: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Extracted character names (| separator)">
                          <input
                            value={row.characterNames.join("|")}
                            onChange={(e) =>
                              change(row.key, {
                                characterNames: e.target.value
                                  .split("|")
                                  .filter(Boolean),
                              })
                            }
                          />
                        </Field>
                        <CharacterPicker
                          label="Confirmed characters"
                          options={extraction.characters}
                          selected={row.characterIds}
                          onChange={(ids) =>
                            change(row.key, { characterIds: ids })
                          }
                        />
                        <Field label="Source category term">
                          <input
                            value={row.categoryTerm}
                            onChange={(e) =>
                              change(row.key, { categoryTerm: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Confirmed category">
                          <select
                            value={row.categoryId}
                            onChange={(e) =>
                              change(row.key, { categoryId: e.target.value })
                            }
                          >
                            <option value="">Choose category</option>
                            {extraction.categories.map((c) => (
                              <option value={c.id} key={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Official MSRP (integer minor units)">
                          <input
                            inputMode="numeric"
                            value={row.officialMsrpAmount}
                            onChange={(e) =>
                              change(row.key, {
                                officialMsrpAmount: e.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label="MSRP currency">
                          <input
                            value={row.officialMsrpCurrency}
                            onChange={(e) =>
                              change(row.key, {
                                officialMsrpCurrency: e.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label="MSRP tax state">
                          <select
                            value={row.officialMsrpTaxInclusion}
                            onChange={(e) =>
                              change(row.key, {
                                officialMsrpTaxInclusion: e.target
                                  .value as Candidate["officialMsrpTaxInclusion"],
                              })
                            }
                          >
                            {["UNKNOWN", "INCLUDED", "EXCLUDED"].map(
                              (value) => (
                                <option key={value}>{value}</option>
                              ),
                            )}
                          </select>
                        </Field>
                        <Field label="JAN">
                          <input
                            value={row.janCode}
                            onChange={(e) =>
                              change(row.key, { janCode: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Release date (YYYY / YYYY-MM / YYYY-MM-DD)">
                          <input
                            value={row.releaseDate}
                            onChange={(e) =>
                              change(row.key, { releaseDate: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Release precision">
                          <select
                            value={row.releaseDatePrecision}
                            onChange={(e) =>
                              change(row.key, {
                                releaseDatePrecision: e.target
                                  .value as Candidate["releaseDatePrecision"],
                              })
                            }
                          >
                            <option value="">Unknown</option>
                            {["YEAR", "MONTH", "DAY"].map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Manufacturer">
                          <input
                            value={row.manufacturer}
                            onChange={(e) =>
                              change(row.key, { manufacturer: e.target.value })
                            }
                          />
                        </Field>
                      </div>
                      <details>
                        <summary>Edit images and source provenance</summary>
                        {row.images.map((image, i) => (
                          <div
                            className="assisted-fields assisted-relation"
                            key={i}
                          >
                            {(["url", "sourceUrl", "provider"] as const).map(
                              (field) => (
                                <Field
                                  key={field}
                                  label={`Image ${i + 1} ${field}`}
                                >
                                  <input
                                    value={image[field]}
                                    onChange={(e) =>
                                      change(row.key, {
                                        images: row.images.map((value, n) =>
                                          n === i
                                            ? {
                                                ...value,
                                                [field]: e.target.value,
                                              }
                                            : value,
                                        ),
                                      })
                                    }
                                  />
                                </Field>
                              ),
                            )}
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                change(row.key, {
                                  images: row.images.filter((_, n) => n !== i),
                                })
                              }
                            >
                              Remove image
                            </button>
                          </div>
                        ))}
                        {row.images.length < 8 && (
                          <button
                            type="button"
                            className="button"
                            onClick={() =>
                              change(row.key, {
                                images: [
                                  ...row.images,
                                  { url: "", sourceUrl: url, provider },
                                ],
                              })
                            }
                          >
                            Add image reference
                          </button>
                        )}
                        {row.sources.map((source, i) => (
                          <div
                            className="assisted-fields assisted-relation"
                            key={i}
                          >
                            <Field label={`Source ${i + 1} provider`}>
                              <input
                                value={source.provider}
                                onChange={(e) =>
                                  change(row.key, {
                                    sources: row.sources.map((value, n) =>
                                      n === i
                                        ? { ...value, provider: e.target.value }
                                        : value,
                                    ),
                                  })
                                }
                              />
                            </Field>
                            <Field label={`Source ${i + 1} URL`}>
                              <input
                                value={source.url}
                                onChange={(e) =>
                                  change(row.key, {
                                    sources: row.sources.map((value, n) =>
                                      n === i
                                        ? { ...value, url: e.target.value }
                                        : value,
                                    ),
                                  })
                                }
                              />
                            </Field>
                            <Field label={`Source ${i + 1} type`}>
                              <select
                                value={source.sourceType}
                                onChange={(e) =>
                                  change(row.key, {
                                    sources: row.sources.map((value, n) =>
                                      n === i
                                        ? {
                                            ...value,
                                            sourceType: e.target
                                              .value as typeof source.sourceType,
                                          }
                                        : value,
                                    ),
                                  })
                                }
                              >
                                {Object.values(SourceType).map((type) => (
                                  <option key={type}>{type}</option>
                                ))}
                              </select>
                            </Field>
                            {row.sources.length > 1 && (
                              <button
                                type="button"
                                className="text-button"
                                onClick={() =>
                                  change(row.key, {
                                    sources: row.sources.filter(
                                      (_, n) => n !== i,
                                    ),
                                  })
                                }
                              >
                                Remove edited source
                              </button>
                            )}
                          </div>
                        ))}
                        {row.sources.length < 10 && (
                          <button
                            type="button"
                            className="button"
                            onClick={() =>
                              change(row.key, {
                                sources: [
                                  ...row.sources,
                                  { provider, url: "", sourceType },
                                ],
                              })
                            }
                          >
                            Add source
                          </button>
                        )}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel form-section">
            <h2 className="section-title">3. Validate selected products</h2>
            <p>
              MSRP amounts use minor units: JPY 1650 = ¥1,650; EUR 1250 =
              €12.50. Editing fields or selection invalidates the previous
              review.
            </p>
            <button
              className="button"
              type="button"
              disabled={!selected.length || pending}
              onClick={() =>
                run(async () => {
                  const result = await reviewExtractedMerchandise({
                    token: extraction.token,
                    rows: rows.filter((row) => selected.includes(row.key)),
                  });
                  if (result.error) setError(result.error);
                  else if (result.review) setReview(result.review);
                })
              }
            >
              Validate selection and duplicates
            </button>
            {review && (
              <div aria-live="polite">
                <p>
                  {review.issues.length
                    ? "Correct the selected-record errors and validate again."
                    : `${selected.length} selected products validated. Review the warnings before confirming.`}
                </p>
                {review.issues.map((issue, i) => (
                  <p className="field-error" key={i}>
                    Selected record {issue.row}: {issue.message}
                  </p>
                ))}
                {review.duplicates.map((w, i) => (
                  <p key={i}>
                    Selected record {w.row}: {w.message}
                    {w.existingItemId && (
                      <>
                        {" "}
                        <Link
                          className="source-link"
                          target="_blank"
                          href={`/admin/merchandise/catalog/${w.existingItemId}`}
                        >
                          View existing item
                        </Link>
                      </>
                    )}
                  </p>
                ))}
              </div>
            )}
          </div>
          {review?.token && (
            <form
              className="panel form-section"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                run(async () => {
                  const result = await importExtractedMerchandise({
                    token: review.token,
                    confirmed: form.get("confirmed") === "on",
                    acknowledgeDuplicates: form.get("duplicates") === "on",
                  });
                  if (result.error) setError(result.error);
                  else if (result.summary) setSummary(result.summary);
                });
              }}
            >
              <label>
                <input type="checkbox" name="confirmed" required /> I reviewed
                the selected products, original names, unresolved character
                names, category, dates, prices and image provenance.
              </label>
              {!!review.duplicates.length && (
                <p>
                  <label>
                    <input type="checkbox" name="duplicates" required /> I
                    reviewed the duplicate warnings and intend to create these
                    additional catalog records.
                  </label>
                </p>
              )}
              <div className="form-actions">
                <button className="button primary" type="submit">
                  {pending ? "Importing…" : "Import Selected Products"}
                </button>
              </div>
            </form>
          )}
        </fieldset>
      )}
      {summary && (
        <section className="panel form-section">
          <h2>Import complete</h2>
          <p role="status">
            {summary.created} created · {summary.skipped} already imported. No
            stock or store listings were created.
          </p>
          <div className="form-actions">
            <button className="button" type="button" onClick={reset}>
              Import another source
            </button>
            <Link
              className="button primary"
              href={`/admin/merchandise/lineups/${summary.lineupId}`}
            >
              Open lineup
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
