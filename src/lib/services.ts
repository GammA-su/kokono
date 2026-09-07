import "server-only";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createCatalogService } from "@/modules/catalog/service";
import { createLocationService } from "@/modules/locations/service";
import { createPublicationService } from "@/modules/publication/service";

export const catalog = createCatalogService(db, requireInternalUser);
export const locations = createLocationService(db, requireInternalUser);
export const publication = createPublicationService(db, requireInternalUser);
