import { requireInternalUser } from "@/lib/authorization";
import { loadImage } from "@/modules/media/storage";
import { DomainError } from "@/modules/shared/errors";

export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    await requireInternalUser();
    const { bytes, mime } = await loadImage((await params).key);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.code)
    )
      return new Response("Unauthorized", { status: 401 });
    if (
      error instanceof DomainError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return new Response("Image not found", { status: 404 });
    throw error;
  }
}
