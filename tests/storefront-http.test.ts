import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  headersFor,
  publicError,
  publicNotFound,
  readResolutionBody,
  storefrontProductUrl,
} from "../src/modules/publication/http";
import { storefrontFilters } from "../src/modules/publication/contract";
describe("public HTTP boundary", () => {
  it("uses no-store and never returns internal errors or filesystem information", async () => {
    const request = new Request(
      "https://backend.test/api/storefront/v1/listings",
    );
    for (const response of [
      publicError(
        request,
        new Error("DATABASE_URL PRIVATE C:/uploads/secret.png"),
      ),
      publicError(request, new z.ZodError([])),
      publicNotFound(request),
    ]) {
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).not.toMatch(
        /PRIVATE|DATABASE_URL|uploads|stack|Prisma/,
      );
    }
  });
  it("bounds the read-only cart body and validates currency-specific price filters", async () => {
    await expect(
      readResolutionBody(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "x".repeat(16385),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      readResolutionBody(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toThrow();
    expect(storefrontFilters.safeParse({ minPrice: 100 }).success).toBe(false);
    expect(
      storefrontFilters.safeParse({ minPrice: 100, currency: "EUR" }).success,
    ).toBe(true);
  });
  it("allows only the configured public origin and gates product links until Prompt 17", () => {
    vi.stubEnv("STOREFRONT_BASE_URL", "https://store.example.test");
    vi.stubEnv("STOREFRONT_PRODUCT_ROUTES_READY", "false");
    expect(storefrontProductUrl("rem")).toBeNull();
    expect(
      headersFor(
        new Request("http://backend.test", {
          headers: { Origin: "https://evil.test" },
        }),
      )["Access-Control-Allow-Origin"],
    ).toBeUndefined();
    expect(
      headersFor(
        new Request("http://backend.test", {
          headers: { Origin: "https://store.example.test" },
        }),
      )["Access-Control-Allow-Origin"],
    ).toBe("https://store.example.test");
    vi.stubEnv("STOREFRONT_PRODUCT_ROUTES_READY", "true");
    expect(storefrontProductUrl("rem")).toBe(
      "https://store.example.test/products/rem",
    );
    vi.unstubAllEnvs();
  });
});
