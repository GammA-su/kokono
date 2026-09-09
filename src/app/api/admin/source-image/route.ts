import { requireInternalUser } from "@/lib/authorization";
import { downloadPublic } from "@/modules/assisted-import/outbound";
import { DomainError } from "@/modules/shared/errors";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    await requireInternalUser();
    const image = await downloadPublic(
      new URL(request.url).searchParams.get("url") ?? "",
      "image",
    );
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": image.type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    const status =
      error instanceof DomainError && error.code === "UNAUTHENTICATED"
        ? 401
        : error instanceof DomainError && error.code === "FORBIDDEN"
          ? 403
          : 400;
    return new Response("Image preview unavailable", {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
