import { z } from "zod";
import { currencyCode, moneyAmount, optionalText } from "../shared/validation";
import type { ShipmentStatus } from "../../generated/prisma/enums";
export const shipmentNumber = (number: number) =>
  `JP-${String(number).padStart(5, "0")}`;
export const shipmentStatuses: ShipmentStatus[] = [
  "DRAFT",
  "PACKING",
  "READY",
  "SHIPPED",
  "IN_TRANSIT",
  "CUSTOMS",
  "DELIVERED",
  "CANCELLED",
];
export const preparationStatuses: string[] = ["DRAFT", "PACKING", "READY"];
export const statusTransitions: Record<ShipmentStatus, ShipmentStatus[]> = {
  DRAFT: ["PACKING", "READY", "CANCELLED"],
  PACKING: ["DRAFT", "READY", "CANCELLED"],
  READY: ["PACKING", "CANCELLED"],
  SHIPPED: ["IN_TRANSIT", "CUSTOMS"],
  IN_TRANSIT: ["CUSTOMS"],
  CUSTOMS: ["IN_TRANSIT"],
  DELIVERED: [],
  CANCELLED: [],
};
const text = optionalText.transform((value) => value || null);
const amount = moneyAmount.nullable().default(null);
export const shippingAmounts = [
  "shippingCostAmount",
  "insuranceCostAmount",
  "otherShippingFeesAmount",
] as const;
export const importAmounts = [
  "customsDutyAmount",
  "importVatAmount",
  "carrierCustomsFeeAmount",
  "otherImportFeesAmount",
] as const;
export const costLabels: Record<
  (typeof shippingAmounts)[number] | (typeof importAmounts)[number],
  string
> = {
  shippingCostAmount: "Shipping cost",
  insuranceCostAmount: "Insurance cost",
  otherShippingFeesAmount: "Other shipping fees",
  customsDutyAmount: "Customs duty",
  importVatAmount: "Import VAT",
  carrierCustomsFeeAmount: "Carrier customs fee",
  otherImportFeesAmount: "Other import fees",
};
export const shipmentInput = z
  .object({
    id: z.uuid(),
    originLocationId: z.uuid(),
    destinationLocationId: z.uuid(),
    transitParentId: z.uuid(),
    carrier: text,
    carrierService: text,
    trackingNumber: text,
    packageCount: z.number().int().min(1).max(10000).default(1),
    totalWeight: z
      .string()
      .regex(
        /^\d{1,9}(?:\.\d{1,3})?$/,
        "Use a weight with at most three decimal places.",
      )
      .refine((value) => Number(value) > 0, "Weight must be positive.")
      .nullable()
      .default(null),
    weightUnit: z.enum(["G", "KG", "LB"]).nullable().default(null),
    shippingCostAmount: amount,
    insuranceCostAmount: amount,
    otherShippingFeesAmount: amount,
    shippingCurrency: currencyCode.nullable().default(null),
    customsDutyAmount: amount,
    importVatAmount: amount,
    carrierCustomsFeeAmount: amount,
    otherImportFeesAmount: amount,
    importCurrency: currencyCode.nullable().default(null),
    notes: text,
    items: z
      .array(
        z.object({
          merchandiseItemId: z.uuid(),
          quantity: z.number().int().min(1).max(2147483647),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((data, ctx) => {
    if (
      new Set(data.items.map((item) => item.merchandiseItemId)).size !==
      data.items.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Combine quantities for repeated merchandise into one line.",
      });
    if (
      new Set([
        data.originLocationId,
        data.destinationLocationId,
        data.transitParentId,
      ]).size !== 3
    )
      ctx.addIssue({
        code: "custom",
        message: "Origin, transit and destination must be distinct.",
      });
    if ((data.totalWeight === null) !== (data.weightUnit === null))
      ctx.addIssue({
        code: "custom",
        path: ["totalWeight"],
        message: "Enter weight and unit together.",
      });
    for (const [fields, currency] of [
      [shippingAmounts, "shippingCurrency"],
      [importAmounts, "importCurrency"],
    ] as const) {
      if (fields.some((field) => data[field] !== null) && !data[currency])
        ctx.addIssue({
          code: "custom",
          path: [currency],
          message: "A currency is required for recorded costs.",
        });
    }
  });
export const shipInput = z.object({ id: z.uuid(), shipmentDate: z.iso.date() });
export const deliverInput = z.object({
  id: z.uuid(),
  arrivalDate: z.iso.date(),
  destinationLocationId: z.uuid(),
});
