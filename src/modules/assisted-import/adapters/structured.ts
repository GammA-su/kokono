import { randomUUID } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5";
import { parsePartialDate } from "../../catalog/partial-date";
import { parseMoneyInput } from "../../shared/money";
import { outboundUrl } from "../outbound";
import type { Candidate, SourceAdapter, SourcePage } from "../types";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value == null ? [] : [value];
const string = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
function named(value: unknown): string {
  return string(value) || string(object(value).name);
}
function attr(node: Tree.Element, name: string) {
  return node.attrs.find((a) => a.name === name)?.value ?? "";
}
function elements(root: Tree.Node) {
  const found: Tree.Element[] = [],
    stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
    if (found.length > 25000) throw new Error("Too many HTML elements");
  }
  return found;
}
function content(root: Tree.Node) {
  let text = "";
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeName === "#text" && "value" in node) text += node.value;
    else if ("childNodes" in node)
      stack.push(...[...node.childNodes].reverse());
  }
  return text;
}
export function sourceDate(
  raw: string,
): { value: string; precision: Candidate["releaseDatePrecision"] } | null {
  const value = raw.normalize("NFKC").trim();
  // Full-string matches only: ranges, seasons and ambiguous text require manual interpretation.
  let date = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) ? value : "";
  const jp =
    /^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?(?:発売(?:予定)?|予定)?$/.exec(
      value,
    );
  if (jp)
    date =
      jp[1] +
      (jp[2] ? `-${jp[2].padStart(2, "0")}` : "") +
      (jp[3] ? `-${jp[3].padStart(2, "0")}` : "");
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const english = /^(?:(\d{1,2}) )?([A-Za-z]+) (\d{4})$/.exec(value);
  if (english) {
    const month =
      months.findIndex((m) => m.toLowerCase() === english[2].toLowerCase()) + 1;
    if (month)
      date = `${english[3]}-${String(month).padStart(2, "0")}${english[1] ? `-${english[1].padStart(2, "0")}` : ""}`;
  }
  try {
    return date
      ? { value: date, precision: parsePartialDate(date).precision }
      : null;
  } catch {
    return null;
  }
}
function url(raw: unknown, base: string) {
  try {
    return outboundUrl(new URL(string(raw), base).href).href;
  } catch {
    return "";
  }
}
function candidate(
  product: RecordValue,
  page: SourcePage,
  confidence: Candidate["confidence"],
): Candidate {
  const original = string(product.name);
  const alternative = string(product.alternateName);
  const japanese =
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(original)
      ? original
      : /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
            alternative,
          )
        ? alternative
        : "";
  const properties = list(product.additionalProperty).map(object);
  const property = (...names: string[]) =>
    properties.find((p) => names.includes(string(p.name)))?.value;
  const releaseRaw = string(
    product.releaseDate || property("発売日", "発売時期", "Release date"),
  );
  const release = sourceDate(releaseRaw);
  const warnings = [
    confidence === "low"
      ? "Low confidence: page metadata may describe a whole lineup, not an individual product."
      : "Structured data is a candidate, not verified catalog data. Check every field against the source.",
  ];
  if (releaseRaw && !release)
    warnings.push(`Release text needs manual interpretation: ${releaseRaw}`);
  const offers = list(product.offers).map(object);
  const specification = offers
    .flatMap((offer) => list(offer.priceSpecification).map(object))
    .find((p) => /(?:^|\/)MSRP$/.test(string(p.priceType)));
  const msrpRaw = string(
    specification?.price ??
      property("希望小売価格", "メーカー希望小売価格", "MSRP"),
  );
  const currency =
    string(specification?.priceCurrency || property("MSRP currency")) ||
    (/円|[¥￥]/.test(msrpRaw) ? "JPY" : "");
  let amount = "";
  if (msrpRaw && currency) {
    try {
      amount = String(
        parseMoneyInput(
          msrpRaw.normalize("NFKC").replace(/[,円¥￥\s]/g, ""),
          currency,
        ),
      );
    } catch {
      warnings.push(`MSRP needs review: ${msrpRaw} ${currency}`);
    }
  } else if (msrpRaw) warnings.push(`MSRP currency is missing: ${msrpRaw}`);
  if (!amount && offers[0]?.price != null)
    warnings.push(
      `Offer price ${string(offers[0].price)} ${string(offers[0].priceCurrency)} was not assumed to be official MSRP.`,
    );
  const productUrl = product.url ? url(product.url, page.url) : page.url;
  const sources = [
    { provider: page.provider, sourceType: page.sourceType, url: page.url },
  ];
  if (productUrl && productUrl !== page.url)
    sources.push({
      provider: page.provider,
      sourceType: page.sourceType,
      url: productUrl,
    });
  const images = list(product.image)
    .flatMap((value) => {
      const raw =
        string(value) || string(object(value).contentUrl || object(value).url);
      const image = raw ? url(raw, page.url) : "";
      if (!image) {
        warnings.push("An unsafe or unsupported image URL was omitted.");
        return [];
      }
      return [{ url: image, sourceUrl: page.url, provider: page.provider }];
    })
    .slice(0, 8);
  const display =
    japanese === original &&
    alternative &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(alternative)
      ? alternative
      : original;
  return {
    key: randomUUID(),
    name: display,
    japaneseName: japanese,
    characterNames: list(property("キャラクター", "Character", "Characters"))
      .flatMap((v) => string(v).split(/[|、]/))
      .filter(Boolean),
    characterIds: [],
    categoryTerm: named(product.category),
    categoryId: "",
    officialMsrpAmount: amount,
    officialMsrpCurrency: amount ? currency : "JPY",
    officialMsrpTaxInclusion: "UNKNOWN",
    janCode: string(
      product.gtin13 || product.gtin8 || property("JAN", "JANコード"),
    ),
    releaseDate: release?.value ?? "",
    releaseDatePrecision: release?.precision ?? "",
    manufacturer: named(product.manufacturer),
    images,
    sources,
    warnings,
    confidence,
  };
}
export const structuredAdapter: SourceAdapter = {
  id: "structured-v1",
  label: "Structured products / page metadata",
  supports: () => true,
  extract(page) {
    const nodes = elements(parse(page.html));
    const products: RecordValue[] = [];
    for (const script of nodes.filter(
      (n) =>
        n.tagName === "script" &&
        attr(n, "type").toLowerCase() === "application/ld+json",
    )) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content(script));
      } catch {
        continue;
      }
      const stack = [parsed];
      let visited = 0;
      while (stack.length) {
        const value = stack.pop();
        if (++visited > 25000) throw new Error("Structured data is too large");
        if (Array.isArray(value)) {
          stack.push(...[...value].reverse());
          continue;
        }
        const record = object(value);
        if (
          list(record["@type"]).some((type) =>
            /^(?:https?:\/\/schema.org\/)?Product$/.test(string(type)),
          )
        )
          products.push(record);
        stack.push(
          ...Object.values(record).filter((v) => v && typeof v === "object"),
        );
      }
    }
    if (!products.length) {
      for (const root of nodes.filter((n) =>
        /(?:^|\s)https?:\/\/schema.org\/Product(?:\s|$)/.test(
          attr(n, "itemtype"),
        ),
      )) {
        const record: RecordValue = {},
          props = elements(root).filter((n) => attr(n, "itemprop"));
        for (const node of props) {
          const key = attr(node, "itemprop"),
            value =
              attr(node, "content") ||
              attr(node, "src") ||
              attr(node, "href") ||
              content(node).trim();
          if (
            [
              "name",
              "alternateName",
              "category",
              "gtin13",
              "gtin8",
              "releaseDate",
              "manufacturer",
            ].includes(key) &&
            !record[key]
          )
            record[key] = value;
          if (key === "image") record.image = [...list(record.image), value];
          if (["price", "priceCurrency"].includes(key))
            record.offers = { ...object(record.offers), [key]: value };
        }
        if (record.name) products.push(record);
      }
    }
    if (products.length > 50)
      throw new Error(
        "More than 50 product candidates; use a smaller source page.",
      );
    if (products.length)
      return products.map((p) => candidate(p, page, "structured"));
    const meta = (name: string) =>
      nodes.find(
        (n) =>
          n.tagName === "meta" &&
          (attr(n, "property") === name || attr(n, "name") === name),
      );
    const ogTitle = meta("og:title");
    const heading = nodes.find(n => n.tagName === "h1") ?? nodes.find(n => n.tagName === "title");
    const title = (ogTitle ? attr(ogTitle, "content") : "") || (heading ? content(heading).trim() : "");
    if (!title) return [];
    const image = meta("og:image");
    return [
      candidate(
        { name: title, ...(image ? { image: attr(image, "content") } : {}) },
        page,
        "low",
      ),
    ];
  },
};
