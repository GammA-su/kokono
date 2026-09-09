import { structuredAdapter } from "./structured";
import type { SourceAdapter, SourcePage } from "../types";
// Add provider adapters before the generic fallback, each with its own host test and fixture suite.
export const sourceAdapters: SourceAdapter[] = [structuredAdapter];
export function extractSource(page: SourcePage) {
  const adapter = sourceAdapters.find((adapter) =>
    adapter.supports(new URL(page.url)),
  )!;
  return { adapter: adapter.id, candidates: adapter.extract(page) };
}
