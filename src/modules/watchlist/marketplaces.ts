/** External navigation only. No network requests, tracking callbacks or automatic check marks. */
export function sourcingQuery(item: {
  name: string;
  japaneseName?: string | null;
  purchaseWatch?: { marketplaceSearchQuery: string | null } | null;
}) {
  return (
    item.purchaseWatch?.marketplaceSearchQuery?.trim() ||
    item.japaneseName?.trim() ||
    item.name.trim()
  );
}
export function marketplaceSearchLinks(query: string) {
  const value = query.trim();
  if (!value) return [];
  const parameter = (base: string, key: string) => {
    const url = new URL(base);
    url.searchParams.set(key, value);
    return url.href;
  };
  return [
    {
      label: "Search Mercari",
      href: parameter("https://jp.mercari.com/search", "keyword"),
    },
    {
      label: "Search Yahoo Auctions",
      href: parameter("https://auctions.yahoo.co.jp/search/search", "p"),
    },
    {
      label: "Search Yahoo Flea Market",
      href: `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(value)}`,
    },
    { label: "Search Rakuma", href: parameter("https://fril.jp/s", "query") },
    {
      label: "Search Suruga-ya",
      href: parameter("https://www.suruga-ya.jp/search", "search_word"),
    },
    {
      label: "Search Mandarake",
      href: parameter(
        "https://order.mandarake.co.jp/order/listPage/list?lang=ja",
        "keyword",
      ),
    },
  ];
}
