import { z } from "zod";
import { currencyCode } from "../shared/validation";
export const allocationMethods = [
  "BY_QUANTITY",
  "BY_WEIGHT",
  "BY_ITEM_VALUE",
  "MANUAL",
] as const;
export const shipmentComponents = [
  "internationalShipping",
  "insurance",
  "otherShippingFees",
  "customsDuty",
  "importVat",
  "carrierCustomsFee",
  "otherImportFees",
] as const;
export const components = [
  "purchasePrice",
  "domesticShipping",
  "marketplaceFees",
  "purchaseTaxes",
  ...shipmentComponents,
] as const;
export type Component = (typeof components)[number];
export const componentLabels: Record<Component, string> = {
  purchasePrice: "Purchase price",
  domesticShipping: "Japan domestic shipping",
  marketplaceFees: "Marketplace / proxy fees",
  purchaseTaxes: "Additional purchase taxes",
  internationalShipping: "International shipping",
  insurance: "Insurance",
  otherShippingFees: "Other shipping fees",
  customsDuty: "Customs duty",
  importVat: "Import VAT",
  carrierCustomsFee: "Carrier customs fee",
  otherImportFees: "Other import fees",
};
export const costingInput = z.object({
  id: z.uuid(),
  shipmentId: z.uuid(),
  method: z.enum(allocationMethods),
  rates: z
    .record(currencyCode, z.string().regex(/^\d{1,12}(?:\.\d{1,12})?$/))
    .default({}),
  rateReference: z
    .string()
    .trim()
    .min(
      1,
      "Record the exchange-rate or payment reference (or same-currency basis).",
    )
    .max(2000),
  rows: z
    .array(
      z.object({
        shipmentItemId: z.uuid(),
        purchaseItemId: z.uuid(),
        unitOffset: z.number().int().min(0).max(2147483647),
        quantity: z.number().int().min(1).max(2147483647),
        unitWeightGrams: z
          .string()
          .regex(/^\d{1,9}(?:\.\d{1,3})?$/)
          .refine((value) => Number(value) > 0)
          .nullable()
          .default(null),
        manual: z
          .partialRecord(z.enum(shipmentComponents), z.string().regex(/^\d+$/))
          .default({}),
      }),
    )
    .min(1)
    .max(1000),
});
export type CostingInput = z.infer<typeof costingInput>;
export type CostComponents = Record<Component, string>;
export type CostLine = {
  shipmentItemId: string;
  purchaseItemId: string;
  unitOffset: number;
  quantity: number;
  unitWeightGrams: string | null;
  name: string;
  purchaseLabel: string;
  components: CostComponents;
  totalAmount: string;
};
export type CostPreview = {
  revision: number;
  input: CostingInput;
  currency: string;
  importVatAsCost: boolean;
  lines: CostLine[];
  totals: CostComponents;
  totalAmount: string;
  shipmentCosts: {
    component: Component;
    amount: string | null;
    currency: string | null;
    convertedAmount: string | null;
    included: boolean;
  }[];
  blockers: string[];
  reviewHash: string;
  sourceSnapshot: unknown;
};
