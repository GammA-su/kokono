import { describe, expect, it } from "vitest";
import {
  allocateMinor,
  convertMinor,
  roundRatio,
  unitSlice,
  weightMilligrams,
} from "../src/modules/landed-costs/math";
import { landedPricing } from "../src/modules/landed-costs/presentation";
import { moneyInputValue } from "../src/modules/shared/money";
describe("exact landed-cost arithmetic", () => {
  it("allocates by quantity with deterministic remainders and no missing cents", () => {
    expect(allocateMinor(101n, [10n, 5n, 2n])).toEqual([59n, 30n, 12n]);
    expect(allocateMinor(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
  });
  it("allocates by recorded weights and item values", () => {
    expect(weightMilligrams("1.025")).toBe(1025n);
    expect(allocateMinor(85n, [100n * 10n, 100n * 5n, 500n * 2n])).toEqual([
      34n,
      17n,
      34n,
    ]);
    expect(allocateMinor(100n, [500n, 1500n])).toEqual([25n, 75n]);
    expect(() => allocateMinor(100n, [0n, 0n])).toThrow();
    expect(allocateMinor(0n, [0n, 0n])).toEqual([0n, 0n]);
  });
  it("converts major-unit FX rates using each currency exponent without floating-point money", () => {
    expect(convertMinor(1000n, "JPY", "EUR", "0.00697")).toBe(697n);
    expect(convertMinor(697n, "EUR", "JPY", "150")).toBe(1046n);
    expect(convertMinor(100n, "EUR", "KWD", "0.333")).toBe(333n);
    expect(convertMinor(0n, "JPY", "EUR")).toBe(0n);
    expect(() => convertMinor(1000n, "JPY", "EUR")).toThrow("rate");
    expect(() => convertMinor(1000n, "JPY", "EUR", "0")).toThrow();
    const huge = 9007199254740993n;
    expect(moneyInputValue(huge, "EUR")).toBe("90071992547409.93");
    expect(allocateMinor(huge, [1n, 2n]).reduce((a, b) => a + b, 0n)).toBe(
      huge,
    );
  });
  it("apportions domestic charges over full acquisition units and honors disjoint ranges", () => {
    expect(unitSlice(101n, 15, 0, 4)).toBe(28n);
    expect(unitSlice(101n, 15, 10, 2)).toBe(13n);
    expect(unitSlice(101n, 15, 0, 7) + unitSlice(101n, 15, 7, 8)).toBe(101n);
    expect(() => unitSlice(10n, 3, 2, 2)).toThrow();
  });
  it("derives batch-based unit estimates and safe margins without cross-currency comparison", () => {
    const estimate = {
      itemId: "item",
      calculationId: "cost",
      shipmentId: "shipment",
      currency: "EUR",
      totalAmount: "2091",
      quantity: 3,
      createdAt: "2026-09-08",
    };
    expect(landedPricing(estimate, 1000, "EUR")).toEqual({
      unitAmount: "697",
      marginAmount: "303",
      marginPercent: "30.30",
    });
    expect(landedPricing(estimate, 500, "EUR")?.marginAmount).toBe("-197");
    expect(landedPricing(estimate, 1000, "JPY")?.marginAmount).toBeNull();
    expect(landedPricing(estimate, 0, "EUR")?.marginPercent).toBeNull();
    expect(landedPricing(null, 1000, "EUR")).toBeNull();
    expect(landedPricing(estimate, 1000, "EUR", "UNKNOWN")?.marginAmount).toBeNull();
    expect(landedPricing(estimate, 1000, "EUR", "INCLUDED")?.marginPercent).toBeNull();
    expect(landedPricing(estimate, 1000, "EUR", "EXCLUDED")?.marginAmount).toBe("303");
    expect(roundRatio(1n, 3n)).toBe(0n);
  });
});
