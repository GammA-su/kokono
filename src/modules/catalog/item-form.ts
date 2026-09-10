import { randomUUID } from "node:crypto";
import { generatedSlug } from "../lineups/service";

/**
 * Maps the merchandise item form to service input.
 *
 * Shared by the create and edit paths so a field added to the form reaches both, rather than
 * being silently dropped by whichever action was not updated.
 */
export function itemFromForm(form: FormData, lineupId: string) {
  const name = String(form.get("name") ?? "");
  const msrp = form.get("officialMsrpAmount");
  const hasMsrp = msrp !== null && String(msrp).trim() !== "";
  return {
    lineupId,
    name,
    japaneseName: form.get("japaneseName"),
    categoryId: form.get("categoryId"),
    internalSku: String(
      form.get("internalSku") || `MERCH-${randomUUID().toUpperCase()}`,
    ),
    janCode: form.get("janCode") || null,
    // An existing item keeps its slug: it is part of admin URLs and prior references.
    slug: String(form.get("slug") || generatedSlug(name)),
    description: form.get("description"),
    manufacturer: form.get("manufacturer"),
    privateNotes: form.get("privateNotes"),
    characterIds: form.getAll("characterIds"),
    // Amount and currency must travel together, and tax inclusion is meaningless without them.
    officialMsrpAmount: hasMsrp ? Number(msrp) : null,
    officialMsrpCurrency: hasMsrp ? "JPY" : null,
    officialMsrpTaxInclusion: hasMsrp
      ? String(form.get("officialMsrpTaxInclusion") || "UNKNOWN")
      : "UNKNOWN",
  };
}
