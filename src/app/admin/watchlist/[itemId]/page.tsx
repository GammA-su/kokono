import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogQueries } from "@/lib/admin";
import { WatchEditForm } from "@/components/admin/watch-controls";
import {
  marketplaceSearchLinks,
  sourcingQuery,
} from "@/modules/watchlist/marketplaces";
export const metadata = { title: "Manage purchase watch" };
export default async function EditWatch({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  const item = await catalogQueries.detail(itemId);
  if (!item) notFound();
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/watchlist">Watchlist</Link>
        <span>/</span>
        <Link href={`/admin/merchandise/catalog/${item.id}`}>{item.name}</Link>
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRIVATE SOURCING</p>
          <h1>Manage purchase watch</h1>
          <p>{item.name}</p>
          <p className="japanese" lang="ja">
            {item.japaneseName}
          </p>
        </div>
        <div className="detail-actions">
          <Link
            className="button primary"
            href={`/admin/marketplace-listings/new?item=${item.id}`}
          >
            Add marketplace candidate
          </Link>
          <Link
            className="button"
            href={`/admin/marketplace-listings?item=${item.id}`}
          >
            View marketplace offers
          </Link>
          <Link
            className="button primary"
            href={`/admin/purchases/new?item=${item.id}`}
          >
            Record purchase
          </Link>
          <Link
            className="button"
            href={`/admin/inventory/record?item=${item.id}`}
          >
            Receive purchased stock
          </Link>
        </div>
      </div>
      <section className="panel form-section">
        <WatchEditForm
          itemId={item.id}
          watch={item.purchaseWatch}
          version={item.purchaseWatch?.updatedAt.toISOString() ?? ""}
          fallbackQuery={item.japaneseName || item.name}
        />
        <div className="watch-search-links">
          {marketplaceSearchLinks(sourcingQuery(item)).map((link) => (
            <a
              key={link.label}
              className="button small"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              {link.label}
            </a>
          ))}
        </div>
      </section>
    </>
  );
}
