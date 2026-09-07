import { Client } from "pg";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";

// Inspect every call instead of relying on pg's once-per-process warning.
export function guardPgQueryConcurrency() {
  const overlappingCalls: string[] = [];
  const original = Client.prototype.query;
  let restore: () => void;
  beforeAll(() => {
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const client = this as Client & { _queryQueue: unknown[] };
      if (client._queryQueue.length) overlappingCalls.push("Overlapping pg query");
      return Reflect.apply(original, this, args);
    });
    restore = () => spy.mockRestore();
  });
  afterEach(() => {
    expect(overlappingCalls.splice(0)).toEqual([]);
  });
  afterAll(() => restore());
}
