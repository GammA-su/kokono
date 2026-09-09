import { db } from "@/lib/db";
import { getPublicListing } from "@/modules/publication/queries";
import {
  publicJson,
  publicNotFound,
  publicError,
  publicOptions,
} from "@/modules/publication/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const item = await getPublicListing(db, (await params).slug);
    return item ? publicJson(request, item) : publicNotFound(request);
  } catch (error) {
    return publicError(request, error);
  }
}
export const OPTIONS = publicOptions;
