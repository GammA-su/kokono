/** Pure URL metadata adapters. These never fetch pages, scrape, or place orders. */
export const marketplaceProviders = [
  {
    name: "Mercari Japan",
    hosts: ["jp.mercari.com"],
    id: /^\/item\/(m\d+)\/?$/,
  },
  {
    name: "Yahoo Auctions Japan",
    hosts: ["auctions.yahoo.co.jp", "page.auctions.yahoo.co.jp"],
    id: /^\/jp\/auction\/([a-zA-Z0-9]+)\/?$/,
  },
  {
    name: "Yahoo Flea Market",
    hosts: ["paypayfleamarket.yahoo.co.jp", "flea-market.yahoo.co.jp"],
    id: /^\/item\/([a-zA-Z0-9]+)\/?$/,
  },
  { name: "Rakuma", hosts: ["item.fril.jp"], id: /^\/([a-zA-Z0-9]+)\/?$/ },
  {
    name: "Suruga-ya",
    hosts: ["www.suruga-ya.jp", "suruga-ya.jp"],
    id: /^\/product\/detail\/([a-zA-Z0-9-]+)\/?$/,
  },
  { name: "Mandarake", hosts: ["order.mandarake.co.jp"], id: null },
] as const;
export function listingUrlMetadata(value: string) {
  const url = new URL(value);
  const provider = marketplaceProviders.find((provider) =>
    (provider.hosts as readonly string[]).includes(url.hostname.toLowerCase()),
  );
  const externalListingId = provider?.id?.exec(url.pathname)?.[1] ?? null;
  url.hash = "";
  // Known item paths identify an offer independently of tracking query parameters.
  if (externalListingId) url.search = "";
  return {
    url: url.toString(),
    marketplace: provider?.name ?? null,
    externalListingId,
  };
}
