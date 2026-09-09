import { describe, expect, it, vi } from "vitest";
import {
  probability,
  prizeForTicket,
  secureSelection,
  simulate,
  totalWeight,
} from "../src/modules/gacha/odds";
import { grantInput, bannerInput } from "../src/modules/gacha/validation";
describe("exact and secure gacha selection", () => {
  const prizes = [
    { id: "a", weight: 1 },
    { id: "b", weight: 9 },
  ];
  it("reports exact 1:9 probabilities and interval boundaries", () => {
    expect(probability(1, 10)).toMatchObject({
      numerator: "1",
      denominator: "10",
      percentage: "10",
      percentageExact: true,
    });
    expect(probability(9, 10).percentage).toBe("90");
    expect(probability(1, 3)).toMatchObject({
      numerator: "1",
      denominator: "3",
      percentage: "33.333333",
      percentageExact: false,
    });
    expect(probability(1, 1).percentage).toBe("100");
    expect(probability(0, 10).percentage).toBe("0");
    expect(prizeForTicket(prizes, 0).prize.id).toBe("a");
    for (let ticket = 1; ticket < 10; ticket++)
      expect(prizeForTicket(prizes, ticket).prize.id).toBe("b");
    expect(() => prizeForTicket(prizes, 10)).toThrow();
    expect(() => prizeForTicket(prizes, -1)).toThrow();
    expect(() => totalWeight([{ id: "x", weight: 0 }])).toThrow();
    expect(() => totalWeight([{ id: "x", weight: 1.5 }])).toThrow();
  });
  it("uses server crypto without Math.random or caller-supplied outcomes", () => {
    const insecure = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Insecure RNG");
    });
    try {
      for (let n = 0; n < 50; n++) {
        const s = secureSelection(prizes);
        expect(s.algorithm).toBe("node:crypto.randomInt/v1");
        expect(prizeForTicket(prizes, s.ticket).prize).toEqual(s.prize);
      }
    } finally {
      insecure.mockRestore();
    }
    expect(grantInput.safeParse({ randomTicket: 0 }).success).toBe(false);
    expect(bannerInput.safeParse({ paidEnabled: true }).success).toBe(false);
  });
  it("simulates 100,000 independent draws with counts and explicit replacement model", () => {
    const result = simulate(prizes, 100000);
    expect(result.results.reduce((n, r) => n + r.observed, 0)).toBe(100000);
    expect(result.results[0].observed).toBeGreaterThan(8500);
    expect(result.results[0].observed).toBeLessThan(11500);
    expect(result.model).toContain("with replacement");
    expect(prizes).toEqual([
      { id: "a", weight: 1 },
      { id: "b", weight: 9 },
    ]);
    expect(() => simulate(prizes, 100001)).toThrow();
    expect(() => simulate(prizes, 0)).toThrow();
  });
});
