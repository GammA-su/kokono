import Link from "next/link";
import type { createLineupQueries } from "@/modules/lineups/queries";
import { MediaImage } from "@/components/ui/media-image";

type Item = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createLineupQueries>["detail"]>>
>["items"][number] & { parentArchived?: boolean };
export function ItemTable({
  items,
  parentArchived = false,
}: {
  items: Item[];
  parentArchived?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table items-table">
        <thead>
          <tr>
            <th>Merchandise item</th>
            <th>Characters</th>
            <th>Category</th>
            <th className="numeric">MSRP · JPY</th>
            <th>JAN</th>
            <th className="numeric">Stock</th>
            <th className="numeric">Locations</th>
            <th>Purchase watch</th>
            <th>Public listing</th>
            <th>Sources</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <div className="lineup-cell">
                  <MediaImage
                    reference={item.images[0]?.storageKey}
                    alt={item.name}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    {item.japaneseName && (
                      <span className="japanese" lang="ja">
                        {item.japaneseName}
                      </span>
                    )}
                    {item.archivedAt && <span className="badge">Archived</span>}
                  </span>
                </div>
              </td>
              <td>
                {item.characters
                  .map(({ character }) => character.name)
                  .join(", ") || <span className="muted">—</span>}
              </td>
              <td className="nowrap">{item.category.name}</td>
              <td className="numeric nowrap">
                {item.officialMsrpAmount !== null &&
                item.officialMsrpCurrency === "JPY" ? (
                  `¥${item.officialMsrpAmount.toLocaleString("en-US")}`
                ) : (
                  <span
                    className="muted"
                    title={
                      item.officialMsrpCurrency
                        ? `MSRP is recorded in ${item.officialMsrpCurrency}; no currency conversion is applied.`
                        : "No MSRP recorded"
                    }
                  >
                    —
                  </span>
                )}
              </td>
              <td className="code-cell">
                {item.janCode || <span className="muted">—</span>}
              </td>
              <td className="numeric count">{item.stock.toLocaleString()}</td>
              <td className="numeric">{item.locationCount}</td>
              <td>
                <span
                  className={`badge ${item.purchaseWatch?.enabled ? "status-preorder" : ""}`}
                >
                  {item.purchaseWatch?.enabled
                    ? `Watching · ${item.purchaseWatch.priority.toLowerCase()}`
                    : item.purchaseWatch
                      ? "Disabled"
                      : "Not watched"}
                </span>
              </td>
              <td>
                <span
                  className={`badge ${item.saleListing?.published && !item.archivedAt && !parentArchived && !item.parentArchived ? "status-released" : ""}`}
                >
                  {item.saleListing?.published
                    ? item.archivedAt || parentArchived || item.parentArchived
                      ? "Published · hidden"
                      : "Published"
                    : item.saleListing
                      ? "Draft"
                      : "No listing"}
                </span>
              </td>
              <td>
                <Link
                  className="source-link nowrap"
                  href={`/admin/merchandise/lineups/${item.lineupId}/items/${item.id}/sources`}
                >
                  {item.sources.length} links
                </Link>
                {item.sources.length > 0 && (
                  <details className="item-source-links">
                    <summary>View links</summary>
                    {item.sources.map((source) => (
                      <a
                        key={source.id}
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="source-link"
                      >
                        {source.provider}
                      </a>
                    ))}
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
