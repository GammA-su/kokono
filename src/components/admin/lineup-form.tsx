"use client";

import { saveLineupForm } from "@/modules/lineups/actions";
import type { SourceFormValue } from "@/modules/lineups/validation";
import { statusLabels } from "@/components/ui/badge";
import { MediaImage } from "@/components/ui/media-image";
import { ActionForm, Field } from "./action-form";
import { PartialDateField } from "./partial-date-field";
import { SourceEditor } from "./source-editor";

export type LineupFormValue = {
  id?: string;
  updatedAt?: string;
  franchiseId?: string;
  name?: string;
  japaneseName?: string | null;
  description?: string | null;
  manufacturer?: string | null;
  announcedDate?: string;
  releaseDate?: string;
  status?: string;
  mainImageStorageKey?: string | null;
  sources?: SourceFormValue[];
};
export function LineupForm({
  franchises,
  initial = {},
}: {
  franchises: { id: string; name: string }[];
  initial?: LineupFormValue;
}) {
  return (
    <ActionForm
      action={saveLineupForm}
      submitLabel={initial.id ? "Save lineup" : "Create lineup"}
      cancelHref={
        initial.id
          ? `/admin/merchandise/lineups/${initial.id}`
          : "/admin/merchandise/lineups"
      }
    >
      {initial.id && (
        <>
          <input type="hidden" name="id" value={initial.id} />
          <input type="hidden" name="updatedAt" value={initial.updatedAt} />
        </>
      )}
      <div className="form-grid">
        <div className="form-stack">
          <section className="panel form-section">
            <h2 className="section-title">Lineup details</h2>
            <div className="field-grid">
              <Field name="franchiseId" label="Franchise" full>
                <select
                  name="franchiseId"
                  defaultValue={initial.franchiseId ?? ""}
                  required
                >
                  <option value="" disabled>
                    Select a franchise
                  </option>
                  {franchises.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field name="name" label="Lineup name" full>
                <input
                  name="name"
                  defaultValue={initial.name ?? ""}
                  required
                  maxLength={500}
                  placeholder="e.g. Marine Ver. 2026"
                />
              </Field>
              <Field name="japaneseName" label="Japanese lineup name" full>
                <input
                  name="japaneseName"
                  defaultValue={initial.japaneseName ?? ""}
                  lang="ja"
                  placeholder="Optional original Japanese name"
                />
              </Field>
              <Field name="description" label="Description" full>
                <textarea
                  name="description"
                  defaultValue={initial.description ?? ""}
                  rows={4}
                  placeholder="Theme, collection details, or release information"
                />
              </Field>
              <Field name="manufacturer" label="Manufacturer">
                <input
                  name="manufacturer"
                  defaultValue={initial.manufacturer ?? ""}
                  maxLength={500}
                  placeholder="e.g. KADOKAWA"
                />
              </Field>
              <Field name="status" label="Status">
                <select
                  name="status"
                  defaultValue={initial.status ?? "UNKNOWN"}
                >
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <PartialDateField
                name="announcedDate"
                label="Announced date"
                initial={initial.announcedDate}
              />
              <PartialDateField
                name="releaseDate"
                label="Release date"
                initial={initial.releaseDate}
              />
            </div>
          </section>
          <section className="panel form-section">
            <h2 className="section-title">Sources & verification</h2>
            <SourceEditor initial={initial.sources} />
          </section>
        </div>
        <aside className="form-aside">
          <section className="panel form-section">
            <h2 className="section-title">Main image</h2>
            <MediaImage
              reference={initial.mainImageStorageKey}
              alt={initial.name || "New lineup"}
              large
            />
            <input
              type="hidden"
              name="currentImage"
              value={initial.mainImageStorageKey ?? ""}
            />
            <div className="form-stack">
              <Field
                name="mainImageStorageKey"
                label="Upload image"
                hint="JPEG, PNG, or WebP. Maximum 5 MB."
              >
                <input
                  name="imageFile"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                />
              </Field>
              <Field name="imageUrl" label="Or use an image URL">
                <input
                  type="url"
                  name="imageUrl"
                  placeholder="https://…"
                  defaultValue={
                    /^https?:\/\//.test(initial.mainImageStorageKey ?? "")
                      ? initial.mainImageStorageKey!
                      : ""
                  }
                />
              </Field>
              {initial.mainImageStorageKey && (
                <label className="checkbox-label">
                  <input type="checkbox" name="removeImage" />
                  Remove current image
                </label>
              )}
            </div>
          </section>
          <section className="panel form-section">
            <h3>One release, many items</h3>
            <p className="muted small-copy" style={{ marginTop: 9 }}>
              Create the lineup first, then add its merchandise. Cataloguing a
              release does not add stock or publish products.
            </p>
          </section>
        </aside>
      </div>
    </ActionForm>
  );
}
