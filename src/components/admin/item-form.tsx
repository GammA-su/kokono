"use client";

import {
  createLineupItemForm,
  saveItemSourcesForm,
} from "@/modules/lineups/actions";
import { saveItemForm } from "@/modules/catalog/actions";
import type { SourceFormValue } from "@/modules/lineups/validation";
import { ActionForm, Field } from "./action-form";
import { SourceEditor } from "./source-editor";

export type ItemFormValue = {
  id: string;
  updatedAt: string;
  name: string;
  japaneseName: string | null;
  categoryId: string;
  internalSku: string;
  janCode: string | null;
  slug: string;
  description: string | null;
  manufacturer: string | null;
  privateNotes: string | null;
  officialMsrpAmount: number | null;
  officialMsrpTaxInclusion: string;
  characterIds: string[];
};

/**
 * One form for creating and editing a catalog item.
 *
 * Editing reuses the create fields rather than duplicating them, so a field added here reaches
 * both paths. Source links, images, stock and publication are deliberately absent: each is
 * edited on its own screen and must not be silently rewritten by an unrelated metadata save.
 */
export function ItemForm({
  lineupId,
  categories,
  characters,
  initial,
}: {
  lineupId: string;
  categories: { id: string; name: string }[];
  characters: { id: string; name: string }[];
  initial?: ItemFormValue;
}) {
  const editing = !!initial;
  const selected = new Set(initial?.characterIds ?? []);
  return (
    <ActionForm
      action={editing ? saveItemForm : createLineupItemForm}
      submitLabel={editing ? "Save changes" : "Add catalog item"}
      cancelHref={
        editing
          ? `/admin/merchandise/catalog/${initial.id}`
          : `/admin/merchandise/lineups/${lineupId}`
      }
    >
      <input type="hidden" name="lineupId" value={lineupId} />
      {editing && (
        <>
          <input type="hidden" name="id" value={initial.id} />
          {/* Optimistic concurrency: the server refuses the save if the row moved on. */}
          <input type="hidden" name="updatedAt" value={initial.updatedAt} />
          {/* An existing slug is part of admin URLs and prior references, so it is preserved. */}
          <input type="hidden" name="slug" value={initial.slug} />
        </>
      )}
      <div className="form-stack">
        <section className="panel form-section">
          <h2 className="section-title">Item details</h2>
          <div className="field-grid">
            <Field name="name" label="English name" full>
              <input
                name="name"
                required
                placeholder="e.g. Rem Marine Ver. Acrylic Stand"
                maxLength={500}
                defaultValue={initial?.name ?? ""}
              />
            </Field>
            <Field name="japaneseName" label="Japanese name" full>
              <input
                name="japaneseName"
                lang="ja"
                defaultValue={initial?.japaneseName ?? ""}
              />
            </Field>
            <Field name="categoryId" label="Category">
              <select
                name="categoryId"
                defaultValue={initial?.categoryId ?? ""}
                required
              >
                <option value="" disabled>
                  Select category
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              name="officialMsrpAmount"
              label="Official MSRP (JPY)"
              hint="Whole yen; optional. Separate from purchase cost and selling price."
            >
              <input
                name="officialMsrpAmount"
                type="number"
                min="0"
                max="2147483647"
                step="1"
                placeholder="1650"
                defaultValue={initial?.officialMsrpAmount ?? ""}
              />
            </Field>
            <Field
              name="internalSku"
              label="Internal SKU"
              hint="Leave blank to generate a unique SKU."
            >
              <input
                name="internalSku"
                defaultValue={initial?.internalSku ?? ""}
              />
            </Field>
            <Field
              name="janCode"
              label="JAN"
              hint="8 or 13 digits. Shared assortment codes are allowed."
            >
              <input
                name="janCode"
                inputMode="numeric"
                pattern="[0-9]{8}([0-9]{5})?"
                maxLength={13}
                defaultValue={initial?.janCode ?? ""}
              />
            </Field>
            <Field name="manufacturer" label="Manufacturer">
              <input
                name="manufacturer"
                defaultValue={initial?.manufacturer ?? ""}
              />
            </Field>
            <Field name="description" label="Description" full>
              <textarea
                name="description"
                defaultValue={initial?.description ?? ""}
              />
            </Field>
            <Field
              name="privateNotes"
              label="Private notes"
              hint="Internal only. Never shown to customers."
              full
            >
              <textarea
                name="privateNotes"
                defaultValue={initial?.privateNotes ?? ""}
              />
            </Field>
          </div>
          <h3 style={{ marginTop: 22 }}>Characters</h3>
          <div className="checklist">
            {characters.map((character) => (
              <label key={character.id}>
                <input
                  type="checkbox"
                  name="characterIds"
                  value={character.id}
                  defaultChecked={selected.has(character.id)}
                />
                {character.name}
              </label>
            ))}
            {!characters.length && (
              <span className="muted small-copy">
                No characters catalogued for this franchise yet.
              </span>
            )}
          </div>
        </section>
        {!editing && (
          <section className="panel form-section">
            <h2 className="section-title">Item sources & verification</h2>
            <SourceEditor />
          </section>
        )}
      </div>
    </ActionForm>
  );
}
export function ItemSourcesForm({
  item,
  sources,
}: {
  item: { id: string; lineupId: string; updatedAt: string };
  sources: SourceFormValue[];
}) {
  return (
    <ActionForm
      action={saveItemSourcesForm}
      submitLabel="Save source links"
      cancelHref={`/admin/merchandise/lineups/${item.lineupId}`}
    >
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="lineupId" value={item.lineupId} />
      <input type="hidden" name="updatedAt" value={item.updatedAt} />
      <section className="panel form-section">
        <SourceEditor initial={sources} />
      </section>
    </ActionForm>
  );
}
