import { z } from "zod";

export const databaseInteger = z.number().int().min(-2_147_483_647).max(2_147_483_647);
export const moneyAmount = databaseInteger.nonnegative();
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code.");
export const entityId = z.uuid();
export const name = z.string().trim().min(1).max(500);
export const slug = z.string().trim().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const optionalText = z.string().trim().max(20_000).nullable().optional();

/**
 * Search parameters as a validated plain record.
 *
 * Next resolves a route's `searchParams` to a class instance rather than a plain object, and
 * Zod's record type rejects those outright — a page that fed it straight to `z.record` returned
 * 500 for every request. Copying the own enumerable keys first keeps the validation while
 * accepting what the framework actually passes.
 */
export const searchParamsRecord = z.preprocess(
  (input) => (input && typeof input === "object" ? { ...input } : input),
  z.record(z.string(), z.unknown()),
);
