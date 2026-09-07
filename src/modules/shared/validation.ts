import { z } from "zod";

export const databaseInteger = z.number().int().min(-2_147_483_647).max(2_147_483_647);
export const moneyAmount = databaseInteger.nonnegative();
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code.");
export const entityId = z.uuid();
export const name = z.string().trim().min(1).max(500);
export const slug = z.string().trim().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const optionalText = z.string().trim().max(20_000).nullable().optional();
