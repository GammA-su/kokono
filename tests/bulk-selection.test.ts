import { describe, expect, it } from "vitest";
import {
  emptySelection,
  isSelected,
  selectItems,
  selectionCount,
} from "../src/modules/bulk-management/selection";
import { snapshotCodec } from "../src/modules/bulk-management/snapshot";
import { parseMoneyInput, moneyInputValue } from "../src/modules/shared/money";

describe("bulk selection", () => {
  it("toggles individuals and visible pages without losing selections on other pages", () => {
    let selected = selectItems(emptySelection(), ["a"], true);
    selected = selectItems(selected, ["b", "c"], true);
    selected = selectItems(selected, ["b", "c"], false);
    expect(selectionCount(selected, 0)).toBe(1);
    expect(isSelected(selected, "a")).toBe(true);
    expect(isSelected(selected, "b")).toBe(false);
    expect(selectionCount(emptySelection(), 0)).toBe(0);
  });
  it("entire lineup selection includes off-page records and honors exclusions", () => {
    const selection = selectItems(
      { mode: "lineup", lineupId: "lineup", excludedIds: [] },
      ["b"],
      false,
    );
    expect(selectionCount(selection, 103)).toBe(102);
    expect(isSelected(selection, "off-page")).toBe(true);
    expect(isSelected(selection, "b")).toBe(false);
    expect(selectionCount(selectItems(selection, ["b"], true), 103)).toBe(103);
  });
  it("rejects expired snapshots", () => {
    const codec = snapshotCodec(
      "test-signing-secret-with-at-least-32-characters",
    );
    const token = codec.sign({
      actorId: "actor",
      action: "archive",
      nonce: "00000000-0000-4000-8000-000000000001",
      expires: Date.now() - 1,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          updatedAt: new Date().toISOString(),
          listingUpdatedAt: null,
        },
      ],
    });
    expect(() => codec.verify(token, "actor")).toThrow("expired");
  });
  it("parses money exactly in the selected currency without rounding", () => {
    expect(parseMoneyInput("12.34", "EUR")).toBe(1234);
    expect(parseMoneyInput("1650", "JPY")).toBe(1650);
    expect(moneyInputValue(1234, "EUR")).toBe("12.34");
    expect(() => parseMoneyInput("12.34", "JPY")).toThrow();
    expect(() => parseMoneyInput("12.345", "EUR")).toThrow();
  });
});
