"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  useTransition,
} from "react";
import type { CatalogFilters } from "@/modules/catalog/queries";
import {
  actionLabels,
  emptySelection,
  isSelected,
  selectItems,
  selectionCount,
  type BulkAction,
  type Selection,
} from "@/modules/bulk-management/selection";
import { prepareMerchandiseBatch } from "@/modules/bulk-management/actions";
import type { BulkReview } from "@/modules/bulk-management/service";
import { BulkReviewDialog } from "./bulk-review-dialog";

type Context = {
  selection: Selection;
  toggle: (ids: string[], checked: boolean) => void;
  disabled: boolean;
};
const SelectionContext = createContext<Context | null>(null);
export function ItemSelectionCheckbox({
  id,
  name,
}: {
  id: string;
  name: string;
}) {
  const context = useContext(SelectionContext);
  if (!context) return null;
  return (
    <input
      type="checkbox"
      className="item-selection"
      aria-label={`Select ${name}`}
      disabled={context.disabled}
      checked={isSelected(context.selection, id)}
      onChange={(event) => context.toggle([id], event.target.checked)}
    />
  );
}
export function BulkSelection({
  children,
  visibleIds,
  lineup,
  filters,
}: {
  children: React.ReactNode;
  visibleIds: string[];
  lineup?: { id: string; total: number };
  filters: Partial<CatalogFilters>;
}) {
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [action, setAction] = useState<BulkAction>("receive");
  const [review, setReview] = useState<BulkReview | null>(null);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const visibleRef = useRef<HTMLInputElement>(null);
  const count = selectionCount(selection, lineup?.total ?? 0);
  const allVisible =
    visibleIds.length > 0 &&
    visibleIds.every((id) => isSelected(selection, id));
  const someVisible = visibleIds.some((id) => isSelected(selection, id));
  const toggle = (ids: string[], checked: boolean) =>
    setSelection((current) => selectItems(current, ids, checked));
  return (
    <SelectionContext value={{ selection, toggle, disabled: pending }}>
      <div className="bulk-selection-controls">
        <label className="checkbox-label">
          <input
            ref={(node) => {
              visibleRef.current = node;
              if (node) node.indeterminate = someVisible && !allVisible;
            }}
            type="checkbox"
            checked={allVisible}
            disabled={!visibleIds.length || pending}
            onChange={(event) => toggle(visibleIds, event.target.checked)}
          />{" "}
          Select all visible ({visibleIds.length})
        </label>
        <button
          type="button"
          className="text-button"
          disabled={!count || pending}
          onClick={() => setSelection(emptySelection())}
        >
          Clear selection
        </button>
        {lineup && (
          <button
            type="button"
            className="button small"
            disabled={!lineup.total || pending}
            onClick={() =>
              setSelection({
                mode: "lineup",
                lineupId: lineup.id,
                excludedIds: [],
              })
            }
          >
            Select entire lineup ({lineup.total})
          </button>
        )}
        <span className="muted small-copy">
          Selection stays across pages; changing catalog filters clears it.
        </span>
      </div>
      {count > 0 && (
        <div
          className="bulk-toolbar"
          role="region"
          aria-label="Bulk merchandise actions"
        >
          <strong aria-live="polite">
            {count.toLocaleString()} items selected
          </strong>
          {selection.mode === "lineup" && (
            <span>
              All pages of this lineup, including archived items
              {selection.excludedIds.length
                ? `; ${selection.excludedIds.length} excluded`
                : ""}
              . Resolved on the server when reviewed.
            </span>
          )}
          <label>
            <span className="sr-only">Bulk action</span>
            <select
              value={action}
              disabled={pending}
              onChange={(event) => setAction(event.target.value as BulkAction)}
            >
              {Object.entries(actionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(undefined);
                try {
                  const response = await prepareMerchandiseBatch({
                    selection,
                    filters,
                    action,
                  });
                  if (response.review) setReview(response.review);
                  else setError(response.error);
                } catch {
                  setError(
                    "Could not load the review. Your selection is retained; please retry.",
                  );
                }
              })
            }
          >
            {pending
              ? "Preparing review…"
              : action === "publish"
                ? "Open publication review"
                : "Review selected"}
          </button>
        </div>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {children}
      {review && (
        <BulkReviewDialog
          review={review}
          onClose={(completed) => {
            setReview(null);
            if (completed) setSelection(emptySelection());
          }}
        />
      )}
    </SelectionContext>
  );
}
