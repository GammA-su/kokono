import { db } from "@/lib/db";
import { getPublishedListings } from "@/modules/publication/queries";
import {
  publicJson,
  publicError,
  publicOptions,
} from "@/modules/publication/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return publicJson(
      request,
      await getPublishedListings(
        db,
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  } catch (error) {
    return publicError(request, error);
  }
}
export const OPTIONS = publicOptions;
