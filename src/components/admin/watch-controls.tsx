"use client";
import { startTransition, useActionState, useState } from "react";
import { WatchPriority } from "@/generated/prisma/enums";
import { updateWatch } from "@/app/admin/watchlist/actions";
import { moneyInputValue } from "@/modules/shared/money";

export type EditableWatch = {
  enabled: boolean;
  priority: WatchPriority;
  targetQuantity: number | null;
  maxUnitPriceAmount: number | null;
  maxUnitPriceCurrency: string;
  conditionPreference: string | null;
  marketplaceSearchQuery: string | null;
};

export function WatchQuickActions({
  itemId,
  priority,
}: {
  itemId: string;
  priority: WatchPriority;
}) {
  const [state, dispatch, pending] = useActionState(updateWatch, {});
  const submit = (data: FormData) => startTransition(() => dispatch(data));
  return (
    <div className="watch-quick" aria-busy={pending}>
      <label className="field">
        <span>Priority</span>
        <select
          aria-label="Priority"
          disabled={pending}
          value={priority}
          onChange={(event) => {
            const data = new FormData();
            data.set("action", "priority");
            data.set("merchandiseItemId", itemId);
            data.set("priority", event.target.value);
            submit(data);
          }}
        >
          {Object.values(WatchPriority)
            .reverse()
            .map((value) => (
              <option key={value}>{value}</option>
            ))}
        </select>
      </label>
      <div className="inventory-row-actions">
        {[
          ["checked", "Mark checked"],
          ["disable", "Disable watch"],
        ].map(([action, label]) => (
          <button
            type="button"
            className="button small"
            disabled={pending}
            key={action}
            onClick={() => {
              const data = new FormData();
              data.set("action", action);
              data.set("merchandiseItemId", itemId);
              submit(data);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="muted" role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}

export function WatchEditForm({
  itemId,
  watch,
  fallbackQuery,
  version = "",
}: {
  itemId: string;
  watch: EditableWatch | null;
  fallbackQuery: string;
  version?: string;
}) {
  const [initialVersion] = useState(version);
  const [state, dispatch, pending] = useActionState(updateWatch, {});
  return (
    <form
      className="watch-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => dispatch(data));
      }}
      aria-busy={pending}
    >
      {state.error && (
        <p className="alert error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="alert" role="status">
          {state.message}
        </p>
      )}
      <fieldset className="form-fieldset" disabled={pending}>
        <input type="hidden" name="action" value="save" />
        <input type="hidden" name="merchandiseItemId" value={itemId} />
        <input
          type="hidden"
          name="version"
          value={state.version ?? initialVersion}
        />
        <div className="watch-edit-grid">
          <label className="field">
            <span>Target quantity</span>
            <input
              name="targetQuantity"
              type="number"
              min={1}
              max={2147483647}
              step={1}
              defaultValue={watch?.targetQuantity ?? ""}
              placeholder="Not set"
            />
            <small>Blank means no numeric target.</small>
          </label>
          <label className="field">
            <span>Priority</span>
            <select
              aria-label="Edit priority"
              name="priority"
              defaultValue={watch?.priority ?? "NORMAL"}
            >
              {Object.values(WatchPriority)
                .reverse()
                .map((value) => (
                  <option key={value}>{value}</option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Maximum purchase unit price</span>
            <input
              name="maxPrice"
              inputMode="decimal"
              defaultValue={
                watch?.maxUnitPriceAmount == null
                  ? ""
                  : moneyInputValue(
                      watch.maxUnitPriceAmount,
                      watch.maxUnitPriceCurrency,
                    )
              }
              placeholder="No limit recorded"
            />
          </label>
          <label className="field">
            <span>Currency</span>
            <input
              name="currency"
              pattern="[A-Z]{3}"
              minLength={3}
              maxLength={3}
              required
              defaultValue={watch?.maxUnitPriceCurrency ?? "JPY"}
            />
          </label>
          <label className="field full">
            <span>Condition preference</span>
            <input
              name="condition"
              maxLength={20_000}
              defaultValue={watch?.conditionPreference ?? ""}
              placeholder="e.g. Unopened, original packaging"
            />
          </label>
          <label className="field full">
            <span>Marketplace search query</span>
            <textarea
              name="query"
              rows={2}
              maxLength={20_000}
              defaultValue={watch?.marketplaceSearchQuery ?? ""}
              placeholder={fallbackQuery}
            />
            <small>
              Blank uses the exact Japanese name when available, then the
              English name.
            </small>
          </label>
          <label className="field">
            <span>Watch enabled</span>
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={watch?.enabled ?? true}
            />
          </label>
        </div>
        <button type="submit" className="button primary small">
          {pending ? "Saving…" : "Save watch"}
        </button>
      </fieldset>
    </form>
  );
}

export function WatchInlineEditor(props: Parameters<typeof WatchEditForm>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="watch-editor"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Edit target, price &amp; sourcing</summary>
      {open && <WatchEditForm {...props} />}
    </details>
  );
}
