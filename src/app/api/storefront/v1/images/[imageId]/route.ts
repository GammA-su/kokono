import { db } from "@/lib/db";
import { getPublicImage } from "@/modules/publication/queries";
import {
  headersFor,
  publicNotFound,
  publicError,
  publicOptions,
} from "@/modules/publication/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ imageId: string }> },
) {
  try {
    const image = await getPublicImage(db, (await params).imageId);
    return image
      ? new Response(new Uint8Array(image.bytes), {
          headers: {
            ...headersFor(request),
            "Content-Type": image.mime,
            "Content-Security-Policy": "default-src 'none'",
          },
        })
      : publicNotFound(request);
  } catch (error) {
    return publicError(request, error);
  }
}
export const OPTIONS = publicOptions;
