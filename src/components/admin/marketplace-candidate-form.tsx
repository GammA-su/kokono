"use client";
import { useState } from "react";
import type { MarketplaceListing } from "@/generated/prisma/client";
import { ActionForm, Field } from "./action-form";
import { saveCandidate } from "@/app/admin/marketplace-listings/actions";
import { moneyInputValue } from "@/modules/shared/money";
import { editableStatuses } from "@/modules/marketplace-listings/validation";
import {
  listingUrlMetadata,
  marketplaceProviders,
} from "@/modules/marketplace-listings/providers";

export function MarketplaceCandidateForm({
  id,
  itemId,
  candidate,
}: {
  id: string;
  itemId: string;
  candidate?: MarketplaceListing;
}) {
  const [marketplace, setMarketplace] = useState(
    candidate?.marketplace ?? "Mercari Japan",
  );
  const [externalId, setExternalId] = useState(
    candidate?.externalListingId ?? "",
  );
  return (
    <ActionForm
      action={saveCandidate}
      submitLabel={candidate ? "Save candidate" : "Add marketplace candidate"}
      cancelHref={`/admin/marketplace-listings?item=${itemId}`}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="merchandiseItemId" value={itemId} />
      {candidate && (
        <input
          type="hidden"
          name="version"
          value={candidate.updatedAt.toISOString()}
        />
      )}
      <div className="field-grid">
        <Field
          name="url"
          label="Listing URL"
          full
          hint="Paste the offer URL. Provider and listing ID are recognized locally for supported item links."
        >
          <input
            aria-label="Listing URL"
            type="url"
            name="url"
            required
            maxLength={2000}
            defaultValue={candidate?.url}
            onChange={(event) => {
              try {
                const metadata = listingUrlMetadata(event.target.value);
                if (metadata.marketplace) setMarketplace(metadata.marketplace);
                setExternalId(metadata.externalListingId ?? "");
              } catch {
                /* An incomplete URL is validated on submit. */
              }
            }}
          />
        </Field>
        <Field name="marketplace" label="Marketplace">
          <input
            name="marketplace"
            required
            maxLength={100}
            list="marketplace-providers"
            value={marketplace}
            onChange={(event) => setMarketplace(event.target.value)}
          />
          <datalist id="marketplace-providers">
            {marketplaceProviders.map((provider) => (
              <option key={provider.name} value={provider.name} />
            ))}
          </datalist>
        </Field>
        <Field name="externalListingId" label="External listing ID">
          <input
            name="externalListingId"
            maxLength={256}
            value={externalId}
            onChange={(event) => setExternalId(event.target.value)}
          />
        </Field>
        <Field name="sellerName" label="Seller name">
          <input
            name="sellerName"
            defaultValue={candidate?.sellerName ?? ""}
            maxLength={20000}
          />
        </Field>
        <Field name="currency" label="Currency">
          <input
            name="currency"
            required
            pattern="[A-Za-z]{3}"
            maxLength={3}
            defaultValue={candidate?.currency ?? "JPY"}
          />
        </Field>
        <Field
          name="itemPrice"
          label="Offer item price"
          hint="Price shown by the seller, excluding domestic shipping. Comparisons assume one item; verify bundle quantities before buying."
        >
          <input
            aria-label="Offer item price"
            name="itemPrice"
            required
            inputMode="decimal"
            defaultValue={
              candidate
                ? moneyInputValue(candidate.itemPriceAmount, candidate.currency)
                : ""
            }
          />
        </Field>
        <Field
          name="domesticShipping"
          label="Domestic shipping"
          hint="Blank means unknown; enter 0 only when free or included."
        >
          <input
            aria-label="Domestic shipping"
            name="domesticShipping"
            inputMode="decimal"
            defaultValue={
              candidate?.domesticShippingAmount != null
                ? moneyInputValue(
                    candidate.domesticShippingAmount,
                    candidate.currency,
                  )
                : ""
            }
          />
        </Field>
        <Field name="condition" label="Condition">
          <input
            name="condition"
            defaultValue={candidate?.condition ?? ""}
            maxLength={20000}
          />
        </Field>
        <Field name="status" label="Status">
          <select
            name="status"
            aria-label="Status"
            defaultValue={candidate?.status ?? "UNKNOWN"}
          >
            {editableStatuses.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </Field>
        <Field name="notes" label="Private candidate notes" full>
          <textarea
            name="notes"
            rows={4}
            defaultValue={candidate?.notes ?? ""}
            maxLength={20000}
          />
        </Field>
      </div>
    </ActionForm>
  );
}
