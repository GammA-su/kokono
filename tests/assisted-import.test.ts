import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSource } from "../src/modules/assisted-import/adapters";
import { sourceDate } from "../src/modules/assisted-import/adapters/structured";
import { matchReferences } from "../src/modules/assisted-import/matching";
import {
  downloadPublic,
  outboundUrl,
  publicAddress,
  publicTarget,
  type Transport,
} from "../src/modules/assisted-import/outbound";
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/sources/${name}.html`, import.meta.url),
    "utf8",
  );
const page = (html: string) => ({
  html,
  url: "https://merch.example.com/lineup",
  provider: "Fixture Official",
  sourceType: "MANUFACTURER" as const,
});
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
describe("assisted source adapters", () => {
  it("extracts Japanese structured products, explicit MSRP, JAN, images and source relationships", () => {
    const { candidates: rows } = extractSource(
      page(fixture("structured-lineup")),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      japaneseName: "レム　マリンVer. アクリルスタンド",
      officialMsrpAmount: "1650",
      officialMsrpCurrency: "JPY",
      janCode: "0490123456789",
      releaseDate: "2026-11",
      releaseDatePrecision: "MONTH",
      manufacturer: "Fixture Manufacturer",
      characterNames: ["レム", "未登録キャラ"],
    });
    expect(rows[0].images).toEqual([
      {
        url: "https://merch.example.com/rem.png",
        sourceUrl: page("").url,
        provider: "Fixture Official",
      },
      {
        url: "https://images.example.com/rem-package.webp",
        sourceUrl: page("").url,
        provider: "Fixture Official",
      },
    ]);
    expect(rows[0].sources).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      officialMsrpAmount: "",
      releaseDate: "2026",
      releaseDatePrecision: "YEAR",
    });
    expect(rows[1].warnings.join(" ")).toContain(
      "not assumed to be official MSRP",
    );
    expect(rows[2]).toMatchObject({
      name: "Ram Clear File",
      japaneseName: "ラム クリアファイル",
      releaseDatePrecision: "DAY",
      officialMsrpAmount: "440",
    });
  });
  it("reads inert microdata and labels fallback/malformed structured data conservatively", () => {
    const row = extractSource(page(fixture("microdata"))).candidates[0];
    expect(row).toMatchObject({
      name: "レム & ラム クリアファイル",
      releaseDate: "2026-11",
      releaseDatePrecision: "MONTH",
      janCode: "4901234567894",
      officialMsrpAmount: "",
    });
    const fallback = extractSource(page(fixture("metadata"))).candidates[0];
    expect(fallback.confidence).toBe("low");
    expect(fallback.images).toEqual([]);
    expect(fallback.japaneseName).toBe("フリーレン 新作グッズ");
    expect(
      extractSource(page("<html><body>Nothing to extract</body></html>"))
        .candidates,
    ).toEqual([]);
  });
  it("never invents date precision, including invalid, seasonal and ranged dates", () => {
    for (const [raw, value, precision] of [
      ["November 2026", "2026-11", "MONTH"],
      ["2026年", "2026", "YEAR"],
      ["２０２６年１１月２３日", "2026-11-23", "DAY"],
      ["23 November 2026", "2026-11-23", "DAY"],
    ])
      expect(sourceDate(raw)).toEqual({ value, precision });
    for (const raw of [
      "2026-02-30",
      "2026年春",
      "2026年11月〜12月",
      "2026-11-01T00:00:00Z",
      "Soon",
      "2026-13",
    ])
      expect(sourceDate(raw)).toBeNull();
  });
  it("matches existing references only and exposes unresolved/ambiguous character names", () => {
    const row = extractSource(page(fixture("structured-lineup"))).candidates[0];
    const matched = matchReferences(row, {
      categories: [
        { id: "category", name: "Acrylic Stand", slug: "acrylic-stand" },
      ],
      characters: [
        { id: "rem", name: "Rem", japaneseName: "レム", aliases: [] },
      ],
    });
    expect(matched.categoryId).toBe("category");
    expect(matched.characterIds).toEqual(["rem"]);
    expect(matched.warnings.join(" ")).toContain("未登録キャラ");
    expect(matched.japaneseName).toBe(row.japaneseName);
    const ambiguous = matchReferences(row, {
      categories: [],
      characters: [
        { id: "1", name: "Rem", japaneseName: "レム", aliases: [] },
        { id: "2", name: "Rem", japaneseName: "レム", aliases: [] },
      ],
    });
    expect(ambiguous.characterIds).toEqual([]);
    expect(ambiguous.categoryId).toBe("");
  });
  it("bounds product counts and ignores script instructions and unsafe image protocols", () => {
    const html = `<script type="application/ld+json">${JSON.stringify(Array.from({ length: 51 }, () => ({ "@type": "Product", name: "Item" })))}</script>`;
    expect(() => extractSource(page(html))).toThrow(/50/);
    const row = extractSource(
      page(
        '<script type="application/ld+json">{"@type":"Product","name":"<img onerror=alert(1)>","image":"javascript:alert(1)"}</script>',
      ),
    ).candidates[0];
    expect(row.name).toBe("<img onerror=alert(1)>");
    expect(row.images).toEqual([]);
  });
});
describe("strict outbound source protection", () => {
  it.each([
    "http://example.com",
    "file:///etc/passwd",
    "ftp://example.com",
    "https://localhost",
    "https://printer.local",
    "https://user:pass@example.com",
    "https://example.com:8443",
    "https://127.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://example.com/#fragment",
    "https://example.com\\@127.0.0.1",
  ])("rejects unsafe URL %s", (raw) => {
    expect(() => outboundUrl(raw)).toThrow();
  });
  it("rejects private/reserved DNS answers, mixed answers and unsupported IPv6 routing", async () => {
    for (const address of [
      "0.0.0.0",
      "100.64.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "192.0.2.1",
      "168.63.129.16",
      "224.0.0.1",
      "255.255.255.255",
      "fc00::1",
      "fe80::1",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2001:db8::1",
      "2002:0808:0808::",
      "3fff::1",
    ])
      expect(publicAddress(address)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
    await expect(
      publicTarget("https://example.com", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow(/network/);
    await expect(
      publicTarget("https://example.com", async () => []),
    ).rejects.toThrow();
  });
  it("validates each redirect and passes only the validated pinned target to transport", async () => {
    const targets: string[] = [];
    const transport: Transport = async (target) => {
      targets.push(target.address.address);
      return {
        status: 302,
        location: "https://127.0.0.1/secret",
        type: "text/html",
        bytes: Buffer.alloc(0),
      };
    };
    await expect(
      downloadPublic("https://example.com", "html", { resolve, transport }),
    ).rejects.toThrow(/Local/);
    expect(targets).toEqual(["93.184.216.34"]);
    let lookups = 0;
    await expect(
      downloadPublic("https://example.com", "html", {
        resolve: async () => [
          { address: ++lookups === 1 ? "8.8.8.8" : "10.0.0.1", family: 4 },
        ],
        transport: async () => ({
          status: 302,
          location: "/again",
          type: "text/html",
          bytes: Buffer.alloc(0),
        }),
      }),
    ).rejects.toThrow(/network/);
    expect(lookups).toBe(2);
  });
  it("limits redirects, bytes, content types, encoding and total elapsed time without live websites", async () => {
    const result =
      (type: string, bytes: Buffer): Transport =>
      async () => ({ status: 200, type, bytes });
    const good = await downloadPublic("https://example.com", "html", {
      resolve,
      transport: result(
        "text/html; charset=utf-8",
        Buffer.from(fixture("structured-lineup")),
      ),
    });
    expect(good.html).toContain("レム");
    await expect(
      downloadPublic("https://example.com", "html", {
        resolve,
        transport: result("text/html", Buffer.alloc(2 * 1024 * 1024 + 1)),
      }),
    ).rejects.toThrow(/large/);
    await expect(
      downloadPublic("https://example.com", "html", {
        resolve,
        transport: result("application/json", Buffer.from("{}")),
      }),
    ).rejects.toThrow(/HTML/);
    await expect(
      downloadPublic("https://example.com", "html", {
        resolve,
        transport: result("text/html; charset=unknown", Buffer.from("test")),
      }),
    ).rejects.toThrow(/encoding/);
    await expect(
      downloadPublic("https://example.com", "html", {
        resolve,
        transport: async () => ({
          status: 302,
          location: "/loop",
          type: "",
          bytes: Buffer.alloc(0),
        }),
      }),
    ).rejects.toThrow(/redirected/);
    await expect(
      downloadPublic("https://example.com", "html", {
        resolve: () => new Promise(() => {}),
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/too long/);
    await expect(
      downloadPublic("https://example.com/image", "image", {
        resolve,
        transport: result(
          "image/svg+xml",
          Buffer.from('<svg onload="alert(1)"/>'),
        ),
      }),
    ).rejects.toThrow(/PNG/);
    await expect(
      downloadPublic("https://example.com/image", "image", {
        resolve,
        transport: result(
          "image/png",
          Buffer.from("<html>not an image</html>"),
        ),
      }),
    ).rejects.toThrow(/PNG/);
  });
});
