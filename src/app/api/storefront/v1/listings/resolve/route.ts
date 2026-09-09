import { db } from "@/lib/db";
import { resolvePublicListings } from "@/modules/publication/queries";
import {
  publicJson,
  publicError,
  publicOptions,
  readResolutionBody,
} from "@/modules/publication/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return publicJson(
      request,
      await resolvePublicListings(db, await readResolutionBody(request)),
    );
  } catch (error) {
    return publicError(request, error);
  }
}
export const OPTIONS = publicOptions;
