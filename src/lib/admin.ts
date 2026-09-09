import "server-only";
import { createPublicationQueries } from "@/modules/publication/admin-queries";
import { redirect } from "next/navigation";
import { requireInternalUser } from "./authorization";
import { DomainError } from "@/modules/shared/errors";
import { db } from "./db";
import { createLineupQueries } from "@/modules/lineups/queries";
import { createCatalogQueries } from "@/modules/catalog/queries";
import { createInventoryQueries } from "@/modules/inventory/queries";
import { createLocationQueries } from "@/modules/locations/queries";
import { createWatchlistQueries } from "@/modules/watchlist/queries";
import { createDashboardQueries } from "@/modules/dashboard/queries";
import { createPurchaseQueries } from "@/modules/purchases/queries";
import { createShipmentQueries } from "@/modules/shipments/queries";
import { createLandedCostQueries } from "@/modules/landed-costs/queries";
import { createMarketplaceListingQueries } from "@/modules/marketplace-listings/queries";

export async function requireAdminPage() {
  try {
    return await requireInternalUser();
  } catch (error) {
    if (error instanceof DomainError && error.code === "UNAUTHENTICATED")
      redirect("/login");
    if (error instanceof DomainError && error.code === "FORBIDDEN")
      redirect("/login?error=access");
    throw error;
  }
}
export const lineupQueries = createLineupQueries(db, requireAdminPage);
export const catalogQueries = createCatalogQueries(db, requireAdminPage);
export const inventoryQueries = createInventoryQueries(db, requireAdminPage);
export const locationQueries = createLocationQueries(db, requireAdminPage);
export const watchlistQueries = createWatchlistQueries(db, requireAdminPage);
export const dashboardQueries = createDashboardQueries(db, requireAdminPage);
export const purchaseQueries = createPurchaseQueries(db, requireAdminPage);
export const shipmentQueries = createShipmentQueries(db, requireAdminPage);
export const landedCostQueries = createLandedCostQueries(db, requireAdminPage);
export const publicationQueries = createPublicationQueries(
  db,
  requireAdminPage,
);
export const marketplaceListingQueries = createMarketplaceListingQueries(
  db,
  requireAdminPage,
);
