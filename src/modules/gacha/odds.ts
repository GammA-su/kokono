import { randomInt } from "node:crypto";
export const RANDOM_ALGORITHM = "node:crypto.randomInt/v1";
import {
  totalWeight,
  prizeForTicket,
  probability,
  type WeightedPrize,
} from "./probability";
export { totalWeight, prizeForTicket, probability } from "./probability";
export function secureSelection(prizes: WeightedPrize[]) {
  const total = totalWeight(prizes),
    ticket = randomInt(total);
  return {
    ...prizeForTicket(prizes, ticket),
    ticket,
    total,
    algorithm: RANDOM_ALGORITHM,
  };
}
export function simulate(prizes: WeightedPrize[], count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 100000)
    throw new Error("Simulate between 1 and 100,000 draws.");
  const total = totalWeight(prizes),
    counts = new Map(prizes.map((p) => [p.id, 0]));
  for (let n = 0; n < count; n++) {
    const selected = prizeForTicket(prizes, randomInt(total)).prize;
    counts.set(selected.id, counts.get(selected.id)! + 1);
  }
  return {
    count,
    algorithm: RANDOM_ALGORITHM,
    model:
      "Independent draws with replacement; depletion is intentionally not simulated. No real rewards or stock changes.",
    results: prizes.map((p) => ({
      prizeId: p.id,
      configured: probability(p.weight, total),
      observed: counts.get(p.id)!,
      observedProbability: probability(counts.get(p.id)!, count),
    })),
  };
}
