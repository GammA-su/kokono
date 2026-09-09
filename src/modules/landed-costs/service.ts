import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { DomainError } from "../shared/errors";
import { currencyCode } from "../shared/validation";
import {
  allocateMinor,
  convertMinor,
  unitSlice,
  weightMilligrams,
} from "./math";
import {
  components,
  costingInput,
  shipmentComponents,
  type CostComponents,
  type CostLine,
  type CostPreview,
  type CostingInput,
} from "./validation";

const sourceFields = {
  internationalShipping: "shippingCostAmount",
  insurance: "insuranceCostAmount",
  otherShippingFees: "otherShippingFeesAmount",
  customsDuty: "customsDutyAmount",
  importVat: "importVatAmount",
  carrierCustomsFee: "carrierCustomsFeeAmount",
  otherImportFees: "otherImportFeesAmount",
} as const;
const emptyComponents = () =>
  Object.fromEntries(components.map((key) => [key, "0"])) as CostComponents;
export async function assignedRanges(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  purchaseIds: string[],
) {
  if (!purchaseIds.length) return [];
  return tx.$queryRaw<
    { purchaseItemId: string; unitOffset: number; quantity: number }[]
  >`
    WITH latest AS (SELECT DISTINCT ON (shipment_id) id FROM landed_cost_calculations
      WHERE shipment_id <> ${shipmentId}::uuid ORDER BY shipment_id,revision DESC)
    SELECT l.purchase_item_id::text AS "purchaseItemId",l.unit_offset AS "unitOffset",l.quantity
    FROM landed_cost_lines l JOIN latest c ON c.id=l.calculation_id
    WHERE l.purchase_item_id IN (${Prisma.join(purchaseIds.map((id) => Prisma.sql`${id}::uuid`))})`;
}
export function createLandedCostService(
  database: PrismaClient,
  authorize: Authorize,
) {
  async function run<T>(
    operation: (tx: Prisma.TransactionClient, actorId: string) => Promise<T>,
  ) {
    const actor = await authorize();
    return database.$transaction(
      async (tx) => {
        await assertInternalAccount(tx, actor.id);
        return operation(tx, actor.id);
      },
      { maxWait: 10000, timeout: 30000 },
    );
  }
  async function calculate(
    tx: Prisma.TransactionClient,
    input: CostingInput,
  ): Promise<CostPreview> {
    const settings = await tx.landedCostSettings.findUnique({
      where: { id: "global" },
    });
    if (!settings)
      throw new DomainError(
        "MISSING_POLICY",
        "Configure the costing currency and import VAT treatment first.",
      );
    const shipment = await tx.shipment.findUnique({
      where: { id: input.shipmentId },
      include: {
        items: {
          orderBy: { id: "asc" },
          include: { merchandiseItem: { select: { name: true } } },
        },
      },
    });
    if (!shipment || !shipment.shipmentDate || shipment.status === "CANCELLED")
      throw new DomainError(
        "NOT_DISPATCHED",
        "Cost allocation requires a dispatched shipment with locked contents.",
      );
    const previous = await tx.landedCostCalculation.findFirst({
      where: { shipmentId: shipment.id },
      orderBy: { revision: "desc" },
      select: { id: true, revision: true },
    });
    const purchaseIds = [
      ...new Set(input.rows.map((row) => row.purchaseItemId)),
    ];
    const purchases = await tx.purchaseItem.findMany({
      where: { id: { in: purchaseIds } },
      orderBy: { id: "asc" },
      include: {
        purchase: {
          include: { items: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
        },
      },
    });
    const byPurchase = new Map(purchases.map((row) => [row.id, row]));
    const used = await assignedRanges(tx, shipment.id, purchaseIds);
    const rows = [...input.rows].sort(
      (a, b) =>
        a.purchaseItemId.localeCompare(b.purchaseItemId) ||
        a.unitOffset - b.unitOffset,
    );
    for (const item of shipment.items)
      if (
        rows
          .filter((row) => row.shipmentItemId === item.id)
          .reduce((sum, row) => sum + row.quantity, 0) !== item.quantity
      )
        throw new DomainError(
          "QUANTITY_MISMATCH",
          `Allocate all ${item.quantity} units of ${item.merchandiseItem.name} to purchase batches.`,
        );
    const conversion = (amount: bigint, currency: string) =>
      convertMinor(amount, currency, settings.currency, input.rates[currency]);
    const lines: CostLine[] = [];
    for (const row of rows) {
      const item = shipment.items.find(
          (item) => item.id === row.shipmentItemId,
        ),
        batch = byPurchase.get(row.purchaseItemId);
      if (
        !item ||
        !batch ||
        item.merchandiseItemId !== batch.merchandiseItemId ||
        !batch.receivedMovementId ||
        ["CANCELLED", "REFUNDED", "DRAFT"].includes(batch.purchase.status)
      )
        throw new DomainError(
          "INVALID_BATCH",
          "Choose a received, non-refunded purchase line for the same merchandise.",
        );
      if (row.unitOffset + row.quantity > batch.quantity)
        throw new DomainError(
          "INVALID_RANGE",
          "Selected units exceed the purchase line quantity.",
        );
      if (
        used.some(
          (range) =>
            range.purchaseItemId === row.purchaseItemId &&
            row.unitOffset < range.unitOffset + range.quantity &&
            range.unitOffset < row.unitOffset + row.quantity,
        )
      )
        throw new DomainError(
          "BATCH_OVERLAP",
          "These purchase units are already assigned in another shipment or overlap another selected batch range.",
        );
      used.push(row);
      const purchase = batch.purchase,
        totalUnits = purchase.items.reduce(
          (sum, line) => sum + line.quantity,
          0,
        );
      const preceding = purchase.items
        .slice(
          0,
          purchase.items.findIndex((line) => line.id === batch.id),
        )
        .reduce((sum, line) => sum + line.quantity, 0);
      const costs = emptyComponents();
      costs.purchasePrice = unitSlice(
        conversion(
          BigInt(batch.unitPriceAmount) * BigInt(batch.quantity),
          purchase.currency,
        ),
        batch.quantity,
        row.unitOffset,
        row.quantity,
      ).toString();
      for (const [component, amount] of [
        ["domesticShipping", purchase.domesticShippingAmount],
        ["marketplaceFees", purchase.feesAmount],
        ["purchaseTaxes", purchase.taxesAmount],
      ] as const)
        costs[component] = unitSlice(
          conversion(BigInt(amount), purchase.currency),
          totalUnits,
          preceding + row.unitOffset,
          row.quantity,
        ).toString();
      lines.push({
        ...row,
        name: item.merchandiseItem.name,
        purchaseLabel: `${purchase.supplier} · ${purchase.externalReference || purchase.id.slice(0, 8)} · line ${batch.position + 1}`,
        components: costs,
        totalAmount: "0",
      });
    }
    const blockers: string[] = [],
      shipmentCosts: CostPreview["shipmentCosts"] = [];
    const weights = lines.map((line) =>
      input.method === "BY_ITEM_VALUE"
        ? BigInt(line.components.purchasePrice)
        : input.method === "BY_WEIGHT"
          ? line.unitWeightGrams
            ? weightMilligrams(line.unitWeightGrams) * BigInt(line.quantity)
            : 0n
          : BigInt(line.quantity),
    );
    if (
      input.method === "BY_WEIGHT" &&
      lines.some((line) => !line.unitWeightGrams)
    )
      throw new DomainError(
        "MISSING_WEIGHT",
        "Record a known unit weight for every batch or choose another allocation method. Shipment package weight is not item weight.",
      );
    for (const component of shipmentComponents) {
      const amount = shipment[sourceFields[component]],
        currency = [
          "internationalShipping",
          "insurance",
          "otherShippingFees",
        ].includes(component)
          ? shipment.shippingCurrency
          : shipment.importCurrency;
      const included = component !== "importVat" || settings.importVatAsCost;
      const converted =
        !included || amount === null || !currency
          ? null
          : conversion(BigInt(amount), currency);
      shipmentCosts.push({
        component,
        amount: amount?.toString() ?? null,
        currency,
        convertedAmount: converted?.toString() ?? null,
        included,
      });
      if (!included) {
        if (
          input.method === "MANUAL" &&
          rows.some((row) => BigInt(row.manual[component] || "0") !== 0n)
        )
          throw new DomainError(
            "VAT_EXCLUDED",
            "Manual VAT allocation must be zero when policy excludes import VAT.",
          );
        continue;
      }
      if (converted === null) {
        blockers.push(
          `${component}: shipment cost is not recorded. Enter the known amount, including an explicit zero where applicable.`,
        );
        continue;
      }
      let allocation: bigint[];
      if (input.method === "MANUAL") {
        allocation = rows.map((row) => BigInt(row.manual[component] || "0"));
        if (allocation.reduce((sum, amount) => sum + amount, 0n) !== converted)
          throw new DomainError(
            "MANUAL_TOTAL",
            `Manual ${component} allocations must equal ${converted} minor units in ${settings.currency}.`,
          );
      } else allocation = allocateMinor(converted, weights);
      lines.forEach((line, index) => {
        line.components[component] = allocation[index].toString();
      });
    }
    const totals = emptyComponents();
    for (const line of lines) {
      line.totalAmount = components
        .reduce((sum, key) => sum + BigInt(line.components[key]), 0n)
        .toString();
      for (const key of components)
        totals[key] = (
          BigInt(totals[key]) + BigInt(line.components[key])
        ).toString();
    }
    const totalAmount = lines
      .reduce((sum, line) => sum + BigInt(line.totalAmount), 0n)
      .toString();
    if (BigInt(totalAmount) > 9223372036854775807n)
      throw new DomainError(
        "AMOUNT_TOO_LARGE",
        "Calculation exceeds the supported monetary range.",
      );
    const sourceSnapshot = JSON.parse(
      JSON.stringify({
        settings,
        shipment: {
          ...shipment,
          items: shipment.items.map((item) => ({
            id: item.id,
            merchandiseItemId: item.merchandiseItemId,
            quantity: item.quantity,
            name: item.merchandiseItem.name,
          })),
        },
        purchases,
        previousCalculationId: previous?.id ?? null,
      }),
    );
    const digest = {
      revision: (previous?.revision ?? 0) + 1,
      input,
      currency: settings.currency,
      importVatAsCost: settings.importVatAsCost,
      lines,
      totals,
      totalAmount,
      shipmentCosts,
      blockers,
      sourceSnapshot,
    };
    return {
      ...digest,
      reviewHash: createHash("sha256")
        .update(JSON.stringify(digest))
        .digest("hex"),
    };
  }
  return {
    saveSettings: (input: unknown) =>
      run(async (tx) => {
        const parsed = z
          .object({
            currency: currencyCode,
            importVatAsCost: z.boolean(),
            version: z.string().nullable(),
          })
          .parse(input);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('landed-cost-settings',0))::text`;
        const current = await tx.landedCostSettings.findUnique({
          where: { id: "global" },
        });
        if ((current?.updatedAt.toISOString() ?? null) !== parsed.version)
          throw new DomainError(
            "CONFLICT",
            "Costing settings changed. Reload before saving.",
          );
        return tx.landedCostSettings.upsert({
          where: { id: "global" },
          create: {
            currency: parsed.currency,
            importVatAsCost: parsed.importVatAsCost,
          },
          update: {
            currency: parsed.currency,
            importVatAsCost: parsed.importVatAsCost,
          },
        });
      }),
    preview: (input: unknown) =>
      run((tx) => calculate(tx, costingInput.parse(input))),
    finalize: (input: unknown, hash: unknown) =>
      run(async (tx, actorId) => {
        const parsed = costingInput.parse(input),
          reviewHash = z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(hash);
        await tx.$queryRaw`SELECT id FROM shipments WHERE id=${parsed.shipmentId}::uuid FOR UPDATE`;
        const existing = await tx.landedCostCalculation.findUnique({
          where: { id: parsed.id },
        });
        if (existing) {
          if (
            existing.reviewHash !== reviewHash ||
            !isDeepStrictEqual(
              (existing.snapshot as unknown as CostPreview).input,
              parsed,
            ) ||
            existing.createdByUserId !== actorId ||
            existing.shipmentId !== parsed.shipmentId
          )
            throw new DomainError(
              "CONFLICT",
              "Calculation identity already used.",
            );
          return { id: existing.id, replayed: true };
        }
        const ids = [
          ...new Set(parsed.rows.map((row) => row.purchaseItemId)),
        ].sort();
        await tx.$queryRaw`SELECT id FROM purchase_items WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
        // Prevent policy changes between review verification and final persistence.
        await tx.$queryRaw`SELECT id FROM landed_cost_settings WHERE id='global' FOR SHARE`;
        const preview = await calculate(tx, parsed);
        if (preview.reviewHash !== reviewHash)
          throw new DomainError(
            "STALE_REVIEW",
            "Costs, policy or batch assignments changed. Review the calculation again.",
          );
        if (preview.blockers.length)
          throw new DomainError(
            "INCOMPLETE_COSTS",
            "Record all included shipment costs before finalizing; unknown costs are not zero.",
          );
        const record = await tx.landedCostCalculation.create({
          data: {
            id: parsed.id,
            shipmentId: parsed.shipmentId,
            method: parsed.method,
            revision: preview.revision,
            createdAt: new Date(),
            currency: preview.currency,
            importVatAsCost: preview.importVatAsCost,
            reviewHash,
            snapshot: JSON.parse(JSON.stringify(preview)),
            totalAmount: BigInt(preview.totalAmount),
            createdByUserId: actorId,
            lines: {
              create: preview.lines.map((line) => ({
                shipmentItemId: line.shipmentItemId,
                purchaseItemId: line.purchaseItemId,
                unitOffset: line.unitOffset,
                quantity: line.quantity,
                unitWeightGrams: line.unitWeightGrams,
                components: line.components,
                totalAmount: BigInt(line.totalAmount),
              })),
            },
          },
        });
        return { id: record.id, replayed: false };
      }),
  };
}
