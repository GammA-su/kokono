"use client";

import {
  memo,
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import {
  createBulkCharacter,
  reviewBulkItems,
  saveBulkItems,
  uploadBulkItemImage,
  type BulkFormState,
} from "@/modules/catalog/bulk-actions";
import { formatRowIssue } from "@/modules/catalog/bulk-fields";
import { MediaImage } from "@/components/ui/media-image";
import { Icon } from "@/components/ui/icon";
import { CharacterPicker, type CharacterOption } from "./character-picker";
import { sourceLabels } from "./source-editor";

export type BulkLineup = {
  id: string;
  name: string;
  japaneseName: string | null;
  franchiseName: string;
  manufacturer: string | null;
  releaseDate: string;
  releaseDateLabel: string | null;
  statusLabel: string;
  mainImageStorageKey: string | null;
  source: { provider: string; sourceType: string; url: string } | null;
};
type Precision = "unknown" | "year" | "month" | "day";
type RowSource = { provider: string; sourceType: string; url: string };
type RowWatch = {
  enabled: boolean;
  targetQuantity: string;
  maxUnitPriceAmount: string;
  maxUnitPriceCurrency: string;
  priority: string;
  conditionPreference: string;
  marketplaceSearchQuery: string;
  notes: string;
};
type Row = {
  key: string;
  name: string;
  japaneseName: string;
  categoryId: string;
  characterIds: string[];
  internalSku: string;
  janCode: string;
  manufacturer: string;
  releaseDate: string;
  releasePrecision: Precision;
  officialMsrpAmount: string;
  officialMsrpCurrency: string;
  officialMsrpTaxInclusion: string;
  privateNotes: string;
  image: string;
  source: RowSource;
  watch: RowWatch;
  expanded: boolean;
  uploading: boolean;
};

const currencies = ["JPY", "EUR", "USD", "GBP", "CNY", "KRW", "TWD", "HKD"];
const taxLabels: Record<string, string> = {
  UNKNOWN: "Tax status unknown",
  INCLUDED: "Tax included",
  EXCLUDED: "Tax excluded",
};
const priorityLabels: Record<string, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};
const emptyIssues: { row: number; field: string; message: string }[] = [];
const emptyWarnings: { row: number; message: string }[] = [];
const MAX_ROWS = 100;

function precisionOf(value: string): Precision {
  if (!value) return "unknown";
  return value.length === 4 ? "year" : value.length === 7 ? "month" : "day";
}
function emptyWatch(): RowWatch {
  return {
    enabled: false,
    targetQuantity: "",
    maxUnitPriceAmount: "",
    maxUnitPriceCurrency: "JPY",
    priority: "NORMAL",
    conditionPreference: "",
    marketplaceSearchQuery: "",
    notes: "",
  };
}
// Keys generated during render must match the server's HTML, so the first row's key comes
// from useId; every later row is created in an event handler on the client.
function inheritedRow(lineup: BulkLineup, key = crypto.randomUUID()): Row {
  return {
    key,
    name: "",
    japaneseName: "",
    categoryId: "",
    characterIds: [],
    internalSku: "",
    janCode: "",
    // New rows start from the lineup's release metadata; every field stays editable.
    manufacturer: lineup.manufacturer ?? "",
    releaseDate: lineup.releaseDate,
    releasePrecision: precisionOf(lineup.releaseDate),
    officialMsrpAmount: "",
    officialMsrpCurrency: "JPY",
    officialMsrpTaxInclusion: "UNKNOWN",
    privateNotes: "",
    image: "",
    source: lineup.source
      ? { ...lineup.source }
      : { provider: "", sourceType: "OFFICIAL_STORE", url: "" },
    watch: emptyWatch(),
    expanded: false,
    uploading: false,
  };
}
/**
 * Copies the release metadata that repeats across a lineup. Identity fields — SKU, JAN,
 * characters, names and the primary image — are deliberately left blank.
 */
function duplicatedRow(row: Row): Row {
  return {
    ...row,
    key: crypto.randomUUID(),
    name: "",
    japaneseName: "",
    internalSku: "",
    janCode: "",
    characterIds: [],
    image: "",
    privateNotes: "",
    watch: {
      ...row.watch,
      marketplaceSearchQuery: "",
      notes: "",
    },
    expanded: false,
    uploading: false,
  };
}
/** A row still holding only inherited lineup values has nothing to save. */
function isBlank(row: Row, lineup: BulkLineup) {
  return (
    !row.name.trim() &&
    !row.japaneseName.trim() &&
    !row.janCode.trim() &&
    !row.internalSku.trim() &&
    !row.image.trim() &&
    !row.officialMsrpAmount.trim() &&
    !row.privateNotes.trim() &&
    !row.characterIds.length &&
    !row.watch.enabled &&
    !row.watch.marketplaceSearchQuery.trim() &&
    !row.watch.notes.trim() &&
    row.source.url === (lineup.source?.url ?? "")
  );
}
function toPayload(row: Row) {
  return {
    name: row.name,
    japaneseName: row.japaneseName,
    categoryId: row.categoryId,
    characterIds: row.characterIds,
    internalSku: row.internalSku,
    janCode: row.janCode,
    manufacturer: row.manufacturer,
    releaseDate: row.releasePrecision === "unknown" ? "" : row.releaseDate,
    officialMsrpAmount: row.officialMsrpAmount,
    officialMsrpCurrency: row.officialMsrpCurrency,
    officialMsrpTaxInclusion: row.officialMsrpTaxInclusion,
    privateNotes: row.privateNotes,
    image: row.image,
    source: { ...row.source },
    watch: { ...row.watch },
  };
}

export function BulkItemEditor({
  lineup,
  categories,
  characters: initialCharacters,
}: {
  lineup: BulkLineup;
  categories: { id: string; name: string }[];
  characters: CharacterOption[];
}) {
  const firstRowKey = useId();
  const [rows, setRows] = useState<Row[]>(() => [
    inheritedRow(lineup, firstRowKey),
  ]);
  const [characters, setCharacters] = useState(initialCharacters);
  const [dirty, setDirty] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [review, setReview] = useState<BulkFormState | null>(null);
  const [checking, startCheck] = useTransition();
  const [busy, startBusy] = useTransition();
  const [state, submit, saving] = useActionState<BulkFormState, unknown>(
    saveBulkItems,
    {},
  );
  const nameInputs = useRef(new Map<string, HTMLInputElement | null>());
  const focusKey = useRef<string | null>(null);

  const feedback: BulkFormState =
    (state.at ?? 0) >= (review?.at ?? 0) ? state : (review ?? {});
  const issuesByRow = useMemo(() => {
    const map = new Map<number, typeof emptyIssues>();
    for (const issue of feedback.issues ?? [])
      map.set(issue.row, [...(map.get(issue.row) ?? []), issue]);
    return map;
  }, [feedback.issues]);
  const warningsByRow = useMemo(() => {
    const map = new Map<number, typeof emptyWarnings>();
    for (const warning of feedback.warnings ?? [])
      map.set(warning.row, [...(map.get(warning.row) ?? []), warning]);
    return map;
  }, [feedback.warnings]);

  const touch = useCallback(() => {
    setDirty(true);
    setAcknowledged(false);
  }, []);
  const update = useCallback(
    (key: string, patch: Partial<Row>) => {
      setRows((old) =>
        old.map((row) => (row.key === key ? { ...row, ...patch } : row)),
      );
      touch();
    },
    [touch],
  );
  const addRow = useCallback(() => {
    setRows((old) => {
      if (old.length >= MAX_ROWS) return old;
      const next = inheritedRow(lineup);
      focusKey.current = next.key;
      return [...old, next];
    });
    touch();
  }, [lineup, touch]);
  const duplicateRow = useCallback(
    (key: string) => {
      setRows((old) => {
        if (old.length >= MAX_ROWS) return old;
        const index = old.findIndex((row) => row.key === key);
        if (index < 0) return old;
        const copy = duplicatedRow(old[index]);
        focusKey.current = copy.key;
        return [...old.slice(0, index + 1), copy, ...old.slice(index + 1)];
      });
      touch();
    },
    [touch],
  );
  const duplicatePrevious = useCallback(() => {
    setRows((old) => {
      if (!old.length || old.length >= MAX_ROWS) return old;
      // Copy the last row that has content: trailing empty rows carry nothing to reuse.
      const previous =
        [...old].reverse().find((row) => !isBlank(row, lineup)) ??
        old[old.length - 1];
      const copy = duplicatedRow(previous);
      focusKey.current = copy.key;
      return [...old, copy];
    });
    touch();
  }, [lineup, touch]);
  const removeRow = useCallback(
    (key: string) => {
      setRows((old) =>
        old.length === 1 ? old : old.filter((row) => row.key !== key),
      );
      touch();
    },
    [touch],
  );
  const applyLineupValues = useCallback(() => {
    setRows((old) =>
      old.map((row) => ({
        ...row,
        manufacturer: lineup.manufacturer ?? "",
        releaseDate: lineup.releaseDate,
        releasePrecision: precisionOf(lineup.releaseDate),
        source: lineup.source ? { ...lineup.source } : row.source,
      })),
    );
    touch();
  }, [lineup, touch]);
  const createCharacter = useCallback(
    (key: string, name: string) => {
      startBusy(async () => {
        const result = await createBulkCharacter({ lineupId: lineup.id, name });
        if ("error" in result || !result.character) {
          setLocalError(
            "error" in result && result.error
              ? result.error
              : "The character could not be created.",
          );
          return;
        }
        const created = result.character;
        setCharacters((old) =>
          old.some((option) => option.id === created.id)
            ? old
            : [...old, created].sort((a, b) => a.name.localeCompare(b.name)),
        );
        setRows((old) =>
          old.map((row) =>
            row.key === key
              ? { ...row, characterIds: [...row.characterIds, created.id] }
              : row,
          ),
        );
        setLocalError(null);
        touch();
      });
    },
    [lineup.id, touch],
  );
  const uploadImage = useCallback(
    (key: string, file: File) => {
      setRows((old) =>
        old.map((row) => (row.key === key ? { ...row, uploading: true } : row)),
      );
      startBusy(async () => {
        const data = new FormData();
        data.set("file", file);
        const result = await uploadBulkItemImage(data);
        setRows((old) =>
          old.map((row) =>
            row.key === key
              ? {
                  ...row,
                  uploading: false,
                  image: result.storageKey ?? row.image,
                }
              : row,
          ),
        );
        setLocalError(result.error ?? null);
        if (result.storageKey) touch();
      });
    },
    [touch],
  );
  const registerName = useCallback(
    (key: string, element: HTMLInputElement | null) => {
      nameInputs.current.set(key, element);
    },
    [],
  );

  useEffect(() => {
    if (!focusKey.current) return;
    nameInputs.current.get(focusKey.current)?.focus();
    focusKey.current = null;
  }, [rows]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function prepare() {
    const kept = rows.filter((row) => !isBlank(row, lineup));
    // Row numbers in every message refer to the rows that are actually submitted.
    if (kept.length !== rows.length) setRows(kept.length ? kept : rows);
    if (!kept.length) {
      setLocalError("Add at least one item before saving.");
      return null;
    }
    setLocalError(null);
    return kept;
  }
  function check() {
    const kept = prepare();
    if (!kept) return;
    startCheck(async () => {
      setReview(
        await reviewBulkItems({
          lineupId: lineup.id,
          acknowledgeDuplicates: false,
          rows: kept.map(toPayload),
        }),
      );
    });
  }
  function save() {
    const kept = prepare();
    if (!kept) return;
    startTransition(() =>
      submit({
        lineupId: lineup.id,
        acknowledgeDuplicates: acknowledged,
        rows: kept.map(toPayload),
      }),
    );
  }
  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      addRow();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicatePrevious();
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      target.tagName !== "INPUT" ||
      (target as HTMLInputElement).type === "file" ||
      target.closest(".character-picker")
    )
      return;
    // Enter advances to the next item instead of submitting the page.
    event.preventDefault();
    const key = target.closest("tr")?.getAttribute("data-row-key");
    const index = rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    if (index === rows.length - 1) addRow();
    else nameInputs.current.get(rows[index + 1].key)?.focus();
  }

  const pending = saving || checking || busy;
  const issueCount = feedback.issues?.length ?? 0;
  const warningCount = feedback.warnings?.length ?? 0;
  return (
    <div className="bulk-editor" onKeyDown={onGridKeyDown} aria-busy={pending}>
      <section className="panel bulk-context">
        <MediaImage
          reference={lineup.mainImageStorageKey}
          alt={lineup.name}
          large
        />
        <div className="detail-info">
          <p className="eyebrow">{lineup.franchiseName}</p>
          <h2>{lineup.name}</h2>
          {lineup.japaneseName && (
            <p className="japanese" lang="ja">
              {lineup.japaneseName}
            </p>
          )}
          <div className="detail-meta">
            <span>{lineup.manufacturer ?? "Manufacturer not specified"}</span>
            <span>
              Release:{" "}
              <strong>{lineup.releaseDateLabel ?? "Not announced"}</strong>
            </span>
            <span className="badge">{lineup.statusLabel}</span>
            {lineup.source && (
              <a
                className="source-link"
                href={lineup.source.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {lineup.source.provider}
                <Icon name="link" size={13} />
              </a>
            )}
          </div>
        </div>
        <div className="bulk-context-actions">
          <button
            type="button"
            className="button"
            onClick={applyLineupValues}
            title="Overwrites manufacturer, release date and initial source on every row."
          >
            Apply lineup values to all items
          </button>
          <p className="muted small-copy">
            New rows already inherit these values. Every field can be overridden
            per row.
          </p>
        </div>
      </section>

      <div className="bulk-toolbar">
        <div className="bulk-toolbar-group">
          <button
            type="button"
            className="button"
            onClick={addRow}
            disabled={rows.length >= MAX_ROWS}
          >
            <Icon name="plus" />
            Add another item
          </button>
          <button
            type="button"
            className="button"
            onClick={duplicatePrevious}
            disabled={rows.length >= MAX_ROWS}
          >
            Duplicate previous row
          </button>
          <span className="muted small-copy">
            {rows.length} row{rows.length === 1 ? "" : "s"}
            {rows.length >= MAX_ROWS
              ? ` · ${MAX_ROWS}-row maximum reached; save this batch first`
              : " · Enter moves to the next item · Ctrl+Enter adds one · Ctrl+D duplicates the last row"}
          </span>
        </div>
        <div className="bulk-toolbar-group">
          {dirty && (
            <span className="badge status-preorder" role="status">
              Unsaved changes
            </span>
          )}
          <button
            type="button"
            className="button"
            onClick={check}
            disabled={pending}
          >
            {checking ? "Checking…" : "Check rows"}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={save}
            disabled={pending}
          >
            {saving ? "Saving…" : "Save all"}
          </button>
        </div>
      </div>

      {(localError || feedback.error) && (
        <div className="alert error" role="alert">
          {localError ?? feedback.error}
        </div>
      )}
      {feedback.checked && !issueCount && !warningCount && (
        <p className="alert success" role="status">
          All rows are valid and no possible duplicates were found.
        </p>
      )}
      {issueCount > 0 && (
        <section className="panel bulk-messages" aria-label="Validation errors">
          <h3>
            {issueCount} validation error{issueCount === 1 ? "" : "s"}
          </h3>
          <ul>
            {feedback.issues!.map((issue, index) => (
              <li key={index}>{formatRowIssue(issue)}</li>
            ))}
          </ul>
          <p className="muted small-copy">
            Valid rows are kept in the editor; nothing was saved.
          </p>
        </section>
      )}
      {warningCount > 0 && (
        <section
          className="panel bulk-messages warning"
          aria-label="Possible duplicates"
        >
          <h3>
            {warningCount} possible duplicate{warningCount === 1 ? "" : "s"}
          </h3>
          <ul>
            {feedback.warnings!.map((warning, index) => (
              <li key={index}>
                Row {warning.row} — {warning.message}
              </li>
            ))}
          </ul>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I reviewed these possible duplicates and want to save them anyway.
          </label>
        </section>
      )}

      <div className="panel table-scroll bulk-table-scroll">
        <table className="data-table bulk-table">
          <thead>
            <tr>
              <th className="numeric">#</th>
              <th>Image</th>
              <th>Names</th>
              <th>Characters</th>
              <th>Category</th>
              <th>Official MSRP</th>
              <th>Release</th>
              <th>JAN</th>
              <th>Watch</th>
              <th>Row</th>
            </tr>
          </thead>
          {rows.map((row, index) => (
            <BulkRowFields
              key={row.key}
              row={row}
              number={index + 1}
              categories={categories}
              characters={characters}
              issues={issuesByRow.get(index + 1) ?? emptyIssues}
              warnings={warningsByRow.get(index + 1) ?? emptyWarnings}
              canRemove={rows.length > 1}
              update={update}
              duplicateRow={duplicateRow}
              removeRow={removeRow}
              createCharacter={createCharacter}
              uploadImage={uploadImage}
              registerName={registerName}
            />
          ))}
        </table>
      </div>
      <div className="form-actions bulk-footer">
        <Link
          href={`/admin/merchandise/lineups/${lineup.id}`}
          className="button"
          onNavigate={(event) => {
            if (
              dirty &&
              !window.confirm(
                "Leave this page? The items you entered have not been saved.",
              )
            )
              event.preventDefault();
          }}
        >
          Cancel
        </Link>
        <button
          type="button"
          className="button primary"
          onClick={save}
          disabled={pending}
        >
          {saving ? "Saving…" : `Save all ${rows.length} rows`}
        </button>
      </div>
    </div>
  );
}

const BulkRowFields = memo(function BulkRowFields({
  row,
  number,
  categories,
  characters,
  issues,
  warnings,
  canRemove,
  update,
  duplicateRow,
  removeRow,
  createCharacter,
  uploadImage,
  registerName,
}: {
  row: Row;
  number: number;
  categories: { id: string; name: string }[];
  characters: CharacterOption[];
  issues: { row: number; field: string; message: string }[];
  warnings: { row: number; message: string }[];
  canRemove: boolean;
  update: (key: string, patch: Partial<Row>) => void;
  duplicateRow: (key: string) => void;
  removeRow: (key: string) => void;
  createCharacter: (key: string, name: string) => void;
  uploadImage: (key: string, file: File) => void;
  registerName: (key: string, element: HTMLInputElement | null) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const flagged = (field: string) =>
    issues.some((issue) => issue.field === field) ? "has-error" : "";
  const watch = (patch: Partial<RowWatch>) =>
    update(row.key, { watch: { ...row.watch, ...patch } });
  const source = (patch: Partial<RowSource>) =>
    update(row.key, { source: { ...row.source, ...patch } });
  return (
    <tbody className={issues.length ? "bulk-row invalid" : "bulk-row"}>
      <tr data-row-key={row.key}>
        <td className="numeric row-number">{number}</td>
        <td>
          <div className="bulk-image">
            <MediaImage reference={row.image} alt={`Row ${number} image`} />
            <input
              ref={file}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) uploadImage(row.key, chosen);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="text-button"
              onClick={() => file.current?.click()}
              disabled={row.uploading}
            >
              {row.uploading ? "Uploading…" : row.image ? "Replace" : "Upload"}
            </button>
            {row.image && (
              <button
                type="button"
                className="text-button"
                onClick={() => update(row.key, { image: "" })}
              >
                Clear
              </button>
            )}
          </div>
        </td>
        <td className="bulk-names">
          <input
            ref={(element) => registerName(row.key, element)}
            className={flagged("name")}
            value={row.name}
            aria-label={`Row ${number} English name`}
            placeholder="English or display name"
            maxLength={500}
            onChange={(event) => update(row.key, { name: event.target.value })}
          />
          <input
            className={flagged("japaneseName")}
            value={row.japaneseName}
            lang="ja"
            aria-label={`Row ${number} Japanese name`}
            placeholder="日本語名"
            maxLength={500}
            onChange={(event) =>
              update(row.key, { japaneseName: event.target.value })
            }
          />
        </td>
        <td className="bulk-characters">
          <CharacterPicker
            label={`Row ${number} characters`}
            options={characters}
            selected={row.characterIds}
            onChange={(characterIds) => update(row.key, { characterIds })}
            onCreate={(name) => createCharacter(row.key, name)}
          />
        </td>
        <td>
          <select
            className={flagged("categoryId")}
            value={row.categoryId}
            aria-label={`Row ${number} category`}
            onChange={(event) =>
              update(row.key, { categoryId: event.target.value })
            }
          >
            <option value="">Select category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </td>
        <td>
          <div className="bulk-money">
            <input
              className={flagged("officialMsrpAmount")}
              value={row.officialMsrpAmount}
              inputMode="numeric"
              aria-label={`Row ${number} official MSRP`}
              placeholder="1650"
              onChange={(event) =>
                update(row.key, { officialMsrpAmount: event.target.value })
              }
            />
            <select
              value={row.officialMsrpCurrency}
              aria-label={`Row ${number} MSRP currency`}
              onChange={(event) =>
                update(row.key, { officialMsrpCurrency: event.target.value })
              }
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </td>
        <td>
          <div className="bulk-date">
            <select
              value={row.releasePrecision}
              aria-label={`Row ${number} release date precision`}
              onChange={(event) => {
                const next = event.target.value as Precision;
                const length = next === "year" ? 4 : next === "month" ? 7 : 10;
                update(row.key, {
                  releasePrecision: next,
                  releaseDate:
                    next === "unknown" || row.releaseDate.length < length
                      ? ""
                      : row.releaseDate.slice(0, length),
                });
              }}
            >
              <option value="unknown">Unknown</option>
              <option value="year">Year</option>
              <option value="month">Month</option>
              <option value="day">Exact date</option>
            </select>
            {row.releasePrecision !== "unknown" && (
              <input
                className={flagged("releaseDate")}
                type={
                  row.releasePrecision === "year"
                    ? "number"
                    : row.releasePrecision === "month"
                      ? "month"
                      : "date"
                }
                min={
                  row.releasePrecision === "year"
                    ? "1"
                    : row.releasePrecision === "month"
                      ? "0001-01"
                      : "0001-01-01"
                }
                max={
                  row.releasePrecision === "year"
                    ? "9999"
                    : row.releasePrecision === "month"
                      ? "9999-12"
                      : "9999-12-31"
                }
                value={row.releaseDate}
                aria-label={`Row ${number} release date`}
                onChange={(event) =>
                  update(row.key, { releaseDate: event.target.value })
                }
              />
            )}
          </div>
        </td>
        <td>
          <input
            className={`code-cell ${flagged("janCode")}`}
            value={row.janCode}
            inputMode="numeric"
            maxLength={13}
            aria-label={`Row ${number} JAN code`}
            placeholder="8 or 13 digits"
            onChange={(event) =>
              update(row.key, { janCode: event.target.value })
            }
          />
        </td>
        <td>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={row.watch.enabled}
              onChange={(event) => watch({ enabled: event.target.checked })}
            />
            Watch
          </label>
        </td>
        <td className="bulk-row-actions">
          <button
            type="button"
            className="text-button"
            aria-expanded={row.expanded}
            onClick={() => update(row.key, { expanded: !row.expanded })}
          >
            {row.expanded ? "Less" : "More"}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => duplicateRow(row.key)}
          >
            Duplicate
          </button>
          <button
            type="button"
            className="text-button"
            disabled={!canRemove}
            onClick={() => removeRow(row.key)}
          >
            Remove
          </button>
        </td>
      </tr>
      {(row.expanded || issues.length > 0 || warnings.length > 0) && (
        <tr className="bulk-detail-row">
          <td />
          <td colSpan={9}>
            {issues.length > 0 && (
              <ul className="bulk-row-messages error" role="alert">
                {issues.map((issue, index) => (
                  <li key={index}>{formatRowIssue(issue)}</li>
                ))}
              </ul>
            )}
            {warnings.length > 0 && (
              <ul className="bulk-row-messages warning">
                {warnings.map((warning, index) => (
                  <li key={index}>{warning.message}</li>
                ))}
              </ul>
            )}
            {row.expanded && (
              <div className="bulk-detail">
                <div className="field-grid">
                  <label className="field">
                    <span>Manufacturer</span>
                    <input
                      value={row.manufacturer}
                      maxLength={500}
                      placeholder="Inherited from the lineup"
                      onChange={(event) =>
                        update(row.key, { manufacturer: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Internal SKU</span>
                    <input
                      className={flagged("internalSku")}
                      value={row.internalSku}
                      maxLength={200}
                      placeholder="Generated on save"
                      onChange={(event) =>
                        update(row.key, { internalSku: event.target.value })
                      }
                    />
                    <small>
                      Leave blank for a deterministic lineup SKU. A manual SKU
                      must be unique.
                    </small>
                  </label>
                  <label className="field">
                    <span>MSRP tax status</span>
                    <select
                      value={row.officialMsrpTaxInclusion}
                      disabled={!row.officialMsrpAmount.trim()}
                      onChange={(event) =>
                        update(row.key, {
                          officialMsrpTaxInclusion: event.target.value,
                        })
                      }
                    >
                      {Object.entries(taxLabels).map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </select>
                    <small>
                      The official manufacturer price only, never a purchase or
                      selling price.
                    </small>
                  </label>
                  <label className="field full">
                    <span>Primary image URL</span>
                    <input
                      className={flagged("image")}
                      value={row.image}
                      placeholder="https://… or an uploaded reference"
                      onChange={(event) =>
                        update(row.key, { image: event.target.value })
                      }
                    />
                    <small>
                      Remote images are referenced, never copied into the
                      database.
                    </small>
                  </label>
                  <label className="field">
                    <span>Source provider</span>
                    <input
                      className={flagged("source.provider")}
                      value={row.source.provider}
                      maxLength={200}
                      placeholder="e.g. KADOKAWA"
                      onChange={(event) =>
                        source({ provider: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Source type</span>
                    <select
                      value={row.source.sourceType}
                      onChange={(event) =>
                        source({ sourceType: event.target.value })
                      }
                    >
                      {Object.entries(sourceLabels).map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field full">
                    <span>Source URL</span>
                    <input
                      className={flagged("source.url")}
                      value={row.source.url}
                      maxLength={2048}
                      placeholder="https://…"
                      onChange={(event) => source({ url: event.target.value })}
                    />
                    <small>
                      One initial source per item. Add further sources from the
                      item’s Sources view.
                    </small>
                  </label>
                  <label className="field full">
                    <span>Private notes</span>
                    <input
                      value={row.privateNotes}
                      maxLength={20_000}
                      placeholder="Internal only; never published"
                      onChange={(event) =>
                        update(row.key, { privateNotes: event.target.value })
                      }
                    />
                  </label>
                </div>
                <fieldset className="bulk-watch">
                  <legend>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={row.watch.enabled}
                        onChange={(event) =>
                          watch({ enabled: event.target.checked })
                        }
                      />
                      Watch for purchase
                    </label>
                  </legend>
                  <div className="field-grid">
                    <label className="field">
                      <span>Target quantity</span>
                      <input
                        className={flagged("watch.targetQuantity")}
                        value={row.watch.targetQuantity}
                        inputMode="numeric"
                        placeholder="5"
                        onChange={(event) =>
                          watch({ targetQuantity: event.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Maximum unit price</span>
                      <div className="bulk-money">
                        <input
                          className={flagged("watch.maxUnitPriceAmount")}
                          value={row.watch.maxUnitPriceAmount}
                          inputMode="numeric"
                          placeholder="1000"
                          onChange={(event) =>
                            watch({ maxUnitPriceAmount: event.target.value })
                          }
                        />
                        <select
                          value={row.watch.maxUnitPriceCurrency}
                          aria-label={`Row ${number} maximum price currency`}
                          onChange={(event) =>
                            watch({ maxUnitPriceCurrency: event.target.value })
                          }
                        >
                          {currencies.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </select>
                      </div>
                    </label>
                    <label className="field">
                      <span>Priority</span>
                      <select
                        value={row.watch.priority}
                        onChange={(event) =>
                          watch({ priority: event.target.value })
                        }
                      >
                        {Object.entries(priorityLabels).map(([value, text]) => (
                          <option key={value} value={value}>
                            {text}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Condition preference</span>
                      <input
                        value={row.watch.conditionPreference}
                        maxLength={500}
                        placeholder="e.g. Sealed only"
                        onChange={(event) =>
                          watch({ conditionPreference: event.target.value })
                        }
                      />
                    </label>
                    <label className="field full">
                      <span>Marketplace search query</span>
                      <input
                        value={row.watch.marketplaceSearchQuery}
                        maxLength={500}
                        placeholder="e.g. レム アクリルスタンド マリン"
                        onChange={(event) =>
                          watch({ marketplaceSearchQuery: event.target.value })
                        }
                      />
                    </label>
                    <label className="field full">
                      <span>Watch notes</span>
                      <input
                        value={row.watch.notes}
                        maxLength={20_000}
                        onChange={(event) =>
                          watch({ notes: event.target.value })
                        }
                      />
                    </label>
                  </div>
                </fieldset>
              </div>
            )}
          </td>
        </tr>
      )}
    </tbody>
  );
});
