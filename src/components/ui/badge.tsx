import type { LineupStatus } from "@/generated/prisma/enums";
import {
  catalogStatusLabels,
  type CatalogStatus,
} from "@/modules/catalog/presentation";

export const statusLabels: Record<LineupStatus, string> = {
  ANNOUNCED: "Announced",
  PREORDER: "Preorder",
  RELEASED: "Released",
  DISCONTINUED: "Discontinued",
  UNKNOWN: "Unknown",
};
export function StatusBadge({ status }: { status: LineupStatus }) {
  return (
    <span className={`badge status-${status.toLowerCase()}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}

const catalogStatusClasses: Record<CatalogStatus, string> = {
  ARCHIVED: "catalog-archived",
  LIVE: "catalog-live",
  OUT_OF_STOCK: "catalog-out",
  IN_STOCK: "catalog-stock",
  WATCHING: "catalog-watch",
  CATALOG_ONLY: "catalog-only",
};
/** The independent states an item can hold at once: archival, publication, stock and watching. */
export function CatalogBadges({ statuses }: { statuses: CatalogStatus[] }) {
  return (
    <span className="catalog-badges">
      {statuses.map((status) => (
        <span key={status} className={`badge ${catalogStatusClasses[status]}`}>
          {catalogStatusLabels[status]}
        </span>
      ))}
    </span>
  );
}
