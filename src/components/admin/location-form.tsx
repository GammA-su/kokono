"use client";

import { useState } from "react";
import { StorageLocationType } from "@/generated/prisma/enums";
import { ActionForm, Field } from "./action-form";
import { saveLocation } from "@/app/admin/inventory/actions";

type Location = {
  id: string;
  code: string;
  name: string;
  type: StorageLocationType;
  parentId: string | null;
  countryCode?: string | null;
  active: boolean;
  fulfillmentEnabled: boolean;
  notes: string | null;
  updatedAt: string;
};
export function LocationForm({
  location,
  parents,
}: {
  location?: Location;
  parents: { id: string; path: string; effectiveActive: boolean }[];
}) {
  const [type, setType] = useState<StorageLocationType>(
    location?.type ?? "OTHER",
  );
  const [fulfillment, setFulfillment] = useState(
    location?.fulfillmentEnabled ?? false,
  );
  return (
    <ActionForm
      action={saveLocation}
      submitLabel={location ? "Save location" : "Create location"}
      cancelHref="/admin/inventory/locations"
      className="panel form-section"
    >
      {location && (
        <>
          <input type="hidden" name="id" value={location.id} />
          <input type="hidden" name="updatedAt" value={location.updatedAt} />
        </>
      )}
      <div className="form-grid">
        <Field name="code" label="Code">
          <input
            name="code"
            required
            maxLength={200}
            defaultValue={location?.code}
            placeholder="FR-SHELF-A-BOX-1"
          />
        </Field>
        <Field name="name" label="Name">
          <input
            name="name"
            required
            maxLength={200}
            defaultValue={location?.name}
            placeholder="Box A1"
          />
        </Field>
        <Field name="type" label="Type">
          <select
            aria-label="Type"
            name="type"
            value={type}
            onChange={(e) => {
              const next = e.target.value as StorageLocationType;
              setType(next);
              if (next === "IN_TRANSIT") setFulfillment(false);
            }}
          >
            {Object.values(StorageLocationType).map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field name="parentId" label="Parent location">
          <select
            aria-label="Parent location"
            name="parentId"
            defaultValue={location?.parentId ?? ""}
          >
            <option value="">Top-level location</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {parent.path}
                {!parent.effectiveActive ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field
          name="active"
          label="Active"
          hint="Deactivating preserves stock and history. Stock can leave an inactive location, but cannot enter it or its descendants."
        >
          <input
            type="checkbox"
            name="active"
            aria-label="Active"
            defaultChecked={location?.active ?? true}
          />
        </Field>
        <Field
          name="fulfillmentEnabled"
          label="Fulfillable"
          hint="Explicitly allow normal customer fulfillment from stock stored directly here. This setting is not inherited by shelves or boxes. All ancestors must be active and outside transit."
        >
          <input
            type="checkbox"
            name="fulfillmentEnabled"
            aria-label="Fulfillable"
            checked={fulfillment}
            disabled={type === "IN_TRANSIT"}
            onChange={(e) => setFulfillment(e.target.checked)}
          />
        </Field>
        <Field
          name="countryCode"
          label="Physical country"
          hint="Two-letter country code: JP for Japan, FR for France. Empty inherits from the parent. Transit stock is excluded from country totals."
        >
          <input
            name="countryCode"
            aria-label="Physical country"
            defaultValue={location?.countryCode ?? ""}
            placeholder="JP / FR"
            pattern="[A-Za-z]{2}"
            maxLength={2}
          />
        </Field>
        <Field name="notes" label="Notes" full>
          <textarea
            name="notes"
            rows={4}
            maxLength={20_000}
            defaultValue={location?.notes ?? ""}
            placeholder="How to find this location, access instructions…"
          />
        </Field>
      </div>
    </ActionForm>
  );
}
