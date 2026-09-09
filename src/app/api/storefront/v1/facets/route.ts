import { db } from "@/lib/db";
import { getPublicFacets } from "@/modules/publication/queries";
import {
  publicJson,
  publicError,
  publicOptions,
} from "@/modules/publication/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return publicJson(request, await getPublicFacets(db));
  } catch (error) {
    return publicError(request, error);
  }
}
export const OPTIONS = publicOptions;
