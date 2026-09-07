import { describe, expect, it } from "vitest";
import { formatPartialDate, parsePartialDate } from "../src/modules/catalog/partial-date";

describe("partial calendar dates", () => {
  it.each([
    ["2026", "YEAR", "2026-01-01", "2026"],
    ["2026-11", "MONTH", "2026-11-01", "November 2026"],
    ["2026-11-14", "DAY", "2026-11-14", "14 November 2026"],
  ] as const)("preserves the source precision of %s", (input, precision, stored, display) => {
    const parsed = parsePartialDate(input);
    expect(parsed.precision).toBe(precision);
    expect(parsed.date.toISOString().slice(0, 10)).toBe(stored);
    expect(formatPartialDate(parsed.date, parsed.precision)).toBe(display);
  });
  it.each(["2026-02-29", "2026-13", "2026-11-31", "2026-0", "0000", "November 2026", "2026-11-14T00:00:00Z"])("rejects invalid or ambiguous input %s", (input) => {
    expect(() => parsePartialDate(input)).toThrow();
  });
  it("accepts leap days and preserves unknown dates", () => {
    expect(parsePartialDate("2024-02-29").precision).toBe("DAY");
    expect(formatPartialDate(null, null)).toBeNull();
    expect(() => formatPartialDate(new Date(), null)).toThrow();
  });
});
