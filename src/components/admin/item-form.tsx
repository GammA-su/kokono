"use client";

import {
  createLineupItemForm,
  saveItemSourcesForm,
} from "@/modules/lineups/actions";
import type { SourceFormValue } from "@/modules/lineups/validation";
import { ActionForm, Field } from "./action-form";
import { SourceEditor } from "./source-editor";

export function ItemForm({
  lineupId,
  categories,
  characters,
}: {
  lineupId: string;
  categories: { id: string; name: string }[];
  characters: { id: string; name: string }[];
}) {
  return (
    <ActionForm
      action={createLineupItemForm}
      submitLabel="Add catalog item"
      cancelHref={`/admin/merchandise/lineups/${lineupId}`}
    >
      <input type="hidden" name="lineupId" value={lineupId} />
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
              />
            </Field>
            <Field name="japaneseName" label="Japanese name" full>
              <input name="japaneseName" lang="ja" />
            </Field>
            <Field name="categoryId" label="Category">
              <select name="categoryId" defaultValue="" required>
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
              />
            </Field>
            <Field
              name="internalSku"
              label="Internal SKU"
              hint="Leave blank to generate a unique SKU."
            >
              <input name="internalSku" />
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
              />
            </Field>
            <Field name="description" label="Description" full>
              <textarea name="description" />
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
        <section className="panel form-section">
          <h2 className="section-title">Item sources & verification</h2>
          <SourceEditor />
        </section>
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
