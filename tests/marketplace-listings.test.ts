import { describe, expect, it } from "vitest";
import {
  compareCandidatePrice,
  priceComparisonLabel,
} from "../src/modules/marketplace-listings/presentation";
import { listingUrlMetadata } from "../src/modules/marketplace-listings/providers";
import { candidateUrl } from "../src/modules/marketplace-listings/validation";

describe("marketplace candidate presentation and URL metadata", () => {
  it("compares integer prices with target and MSRP including exact, below and above", () => {
    expect(compareCandidatePrice(700, "JPY", 1000, "JPY")).toEqual({
      kind: "comparable",
      difference: 300,
    });
    expect(
      priceComparisonLabel(700, "JPY", 1000, "JPY", "Target max"),
    ).toContain("¥300 below target max");
    expect(priceComparisonLabel(1100, "JPY", 1000, "JPY", "MSRP")).toContain(
      "¥100 above msrp",
    );
    expect(compareCandidatePrice(1000, "JPY", 1000, "JPY").difference).toBe(0);
    expect(compareCandidatePrice(700, "JPY", 0, "JPY").difference).toBe(-700);
    expect(compareCandidatePrice(123, "EUR", 150, "EUR").difference).toBe(27);
  });
  it("does not invent missing targets or convert currencies", () => {
    expect(compareCandidatePrice(700, "JPY", null, "JPY").kind).toBe("unknown");
    expect(compareCandidatePrice(700, "JPY", 1000, "EUR").kind).toBe(
      "different_currency",
    );
    expect(
      priceComparisonLabel(700, "JPY", 1000, "EUR", "Target max"),
    ).toContain("Different currency");
  });
  it("recognizes known offer paths without fetching and removes only safe tracking metadata", () => {
    expect(
      listingUrlMetadata(
        "https://jp.mercari.com/item/m12345?utm_source=share#top",
      ),
    ).toEqual({
      marketplace: "Mercari Japan",
      externalListingId: "m12345",
      url: "https://jp.mercari.com/item/m12345",
    });
    expect(
      listingUrlMetadata("https://page.auctions.yahoo.co.jp/jp/auction/a123")
        .externalListingId,
    ).toBe("a123");
    expect(
      listingUrlMetadata("https://paypayfleamarket.yahoo.co.jp/item/z123")
        .marketplace,
    ).toBe("Yahoo Flea Market");
    expect(
      listingUrlMetadata("https://item.fril.jp/abcdef123").marketplace,
    ).toBe("Rakuma");
    expect(
      listingUrlMetadata("https://www.suruga-ya.jp/product/detail/12345")
        .externalListingId,
    ).toBe("12345");
    expect(
      listingUrlMetadata(
        "https://order.mandarake.co.jp/order/detailPage/item?itemCode=123",
      ).url,
    ).toContain("itemCode=123");
    expect(listingUrlMetadata("https://example.test/offer?id=9")).toMatchObject(
      {
        marketplace: null,
        externalListingId: null,
        url: "https://example.test/offer?id=9",
      },
    );
    expect(
      listingUrlMetadata("https://jp.mercari.com.evil.test/item/m123")
        .marketplace,
    ).toBeNull();
  });
  it("rejects executable URLs and embedded credentials", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///C:/secret",
      "https://user:password@example.test/",
    ])
      expect(candidateUrl.safeParse(url).success).toBe(false);
  });
});
