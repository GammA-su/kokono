import Link from "next/link";
import { notFound } from "next/navigation";
import { lineupQueries } from "@/lib/admin";
import { formatPartialDate } from "@/modules/catalog/partial-date";
import { StatusBadge } from "@/components/ui/badge";
import { MediaImage } from "@/components/ui/media-image";
import { Icon } from "@/components/ui/icon";
import { LineupActions } from "@/components/admin/lineup-actions";
import { ItemTable } from "@/components/admin/item-table";
import { Pagination } from "@/components/admin/pagination";

export const metadata = { title: "Lineup details" };
export default async function LineupDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const lineup = await lineupQueries.detail(id, query);
  if (!lineup) notFound();
  const archived = Boolean(lineup.archivedAt || lineup.franchise.archivedAt);
  const notices: Record<string, string> = {
    saved: "Lineup saved.",
    item: "Catalog item added. No inventory or listing was created.",
    sources: "Source links updated.",
  };
  const notice =
    typeof query.notice === "string" ? notices[query.notice] : null;
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/merchandise/lineups">Lineups</Link>
        <span>/</span>
        {lineup.name}
      </div>
      {notice && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      {archived && (
        <p className="alert">
          This lineup or its franchise is archived. Inventory remains available
          internally; public listings are hidden.
        </p>
      )}
      <section className="detail-heading">
        <MediaImage
          reference={lineup.mainImageStorageKey}
          alt={lineup.name}
          large
        />
        <div className="detail-info">
          <p className="eyebrow">{lineup.franchise.name}</p>
          <h1>{lineup.name}</h1>
          {lineup.japaneseName && (
            <p className="japanese" lang="ja">
              {lineup.japaneseName}
            </p>
          )}
          <div className="detail-meta">
            <span>{lineup.manufacturer ?? "Manufacturer not specified"}</span>
            <span>
              Release:{" "}
              <strong>
                {formatPartialDate(
                  lineup.releaseDate,
                  lineup.releaseDatePrecision,
                ) ?? "Not announced"}
              </strong>
            </span>
            <StatusBadge status={lineup.status} />
            {lineup.sources[0] && (
              <a
                className="source-link"
                href={lineup.sources[0].url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {lineup.sources[0].provider}
                <Icon name="link" size={13} />
              </a>
            )}
          </div>
          <div className="detail-actions">
            {!archived && (
              <Link
                className="button primary"
                href={`/admin/merchandise/lineups/${id}/items/new`}
              >
                <Icon name="plus" />
                Add item
              </Link>
            )}
            <Link
              className="button"
              href={`/admin/merchandise/lineups/${id}/edit`}
            >
              Edit lineup
            </Link>
            <LineupActions
              id={id}
              name={lineup.name}
              hasItems={lineup.counts.catalogued > 0}
              archived={Boolean(lineup.archivedAt)}
            />
          </div>
        </div>
      </section>
      {lineup.description && (
        <p className="description">{lineup.description}</p>
      )}
      <div className="metric-strip">
        {[
          ["Catalogued items", lineup.counts.catalogued],
          ["Owned item designs", lineup.counts.owned],
          ["Published items", lineup.counts.published],
          ["Characters", lineup.counts.characters],
          ["Watched items", lineup.counts.watched],
          ["Stock · all locations", lineup.counts.stock],
        ].map(([label, count]) => (
          <div className="metric" key={label}>
            <strong>{Number(count).toLocaleString()}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            Merchandise items{" "}
            <span className="heading-count">{lineup.counts.catalogued}</span>
          </h2>
          <span className="muted small-copy">
            Stock includes units in transit
          </span>
        </div>
        <ItemTable items={lineup.items} parentArchived={archived} />
        {!lineup.items.length && (
          <div className="empty-state">
            <Icon name="tag" size={30} />
            <h2>No merchandise items yet</h2>
            <p>Add individual designs to build this release’s catalog.</p>
            {!archived && (
              <Link
                className="button"
                href={`/admin/merchandise/lineups/${id}/items/new`}
              >
                Add first item
              </Link>
            )}
          </div>
        )}
        <Pagination
          base={`/admin/merchandise/lineups/${id}`}
          params={{ size: lineup.size }}
          page={lineup.page}
          pageCount={lineup.pageCount}
          total={lineup.counts.catalogued}
          size={lineup.size}
        />
      </section>
      <section className="panel sources-panel">
        <div className="panel-heading">
          <h2>
            Sources & verification{" "}
            <span className="heading-count">{lineup.sources.length}</span>
          </h2>
          <Link
            className="text-button"
            href={`/admin/merchandise/lineups/${id}/edit`}
          >
            Manage source links
          </Link>
        </div>
        <ul className="source-list">
          {lineup.sources.map((source) => (
            <li key={source.id}>
              <div>
                <a
                  className="source-link"
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.provider}
                  <Icon name="link" size={13} />
                </a>
                <div className="source-meta">
                  {source.sourceType.toLowerCase().replaceAll("_", " ")} ·{" "}
                  {new URL(source.url).hostname}
                </div>
                {source.notes && <p className="source-meta">{source.notes}</p>}
              </div>
              <span className="badge">
                {source.checkedAt
                  ? `Checked ${source.checkedAt.toISOString().slice(0, 10)}`
                  : "Not checked"}
              </span>
            </li>
          ))}
        </ul>
        {!lineup.sources.length && (
          <p className="muted small-copy" style={{ padding: "0 20px 20px" }}>
            No lineup sources yet. Item-specific evidence is available in each
            item’s Sources column.
          </p>
        )}
        {lineup.announcedDate && (
          <p className="table-note" style={{ padding: "0 20px 18px" }}>
            Announced:{" "}
            {formatPartialDate(
              lineup.announcedDate,
              lineup.announcedDatePrecision,
            )}
          </p>
        )}
      </section>
    </>
  );
}
