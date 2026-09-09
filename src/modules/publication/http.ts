import { z } from "zod";
export const publicHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Surrogate-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
export function storefrontOrigin() {
  try {
    const url = new URL(process.env.STOREFRONT_BASE_URL ?? "");
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
export function storefrontProductUrl(slug: string) {
  const origin = storefrontOrigin();
  return origin && process.env.STOREFRONT_PRODUCT_ROUTES_READY === "true"
    ? `${origin}/products/${encodeURIComponent(slug)}`
    : null;
}
export function headersFor(request: Request) {
  const headers: Record<string, string> = { ...publicHeaders, Vary: "Origin" };
  if (
    storefrontOrigin() &&
    request.headers.get("origin") === storefrontOrigin()
  )
    headers["Access-Control-Allow-Origin"] = storefrontOrigin()!;
  return headers;
}
export function publicJson(request: Request, data: unknown, status = 200) {
  return Response.json(data, { status, headers: headersFor(request) });
}
export function publicError(request: Request, error: unknown) {
  return publicJson(
    request,
    {
      error: {
        code:
          error instanceof z.ZodError
            ? "INVALID_REQUEST"
            : "SERVICE_UNAVAILABLE",
        message:
          error instanceof z.ZodError
            ? "Invalid storefront request parameters."
            : "Storefront data is temporarily unavailable.",
      },
    },
    error instanceof z.ZodError ? 400 : 503,
  );
}
export function publicNotFound(request: Request) {
  return publicJson(
    request,
    { error: { code: "NOT_FOUND", message: "Not found." } },
    404,
  );
}
export function publicOptions(request: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...headersFor(request),
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
export async function readResolutionBody(request: Request) {
  const bad = () =>
    new z.ZodError([
      { code: "custom", path: [], message: "Invalid JSON body." },
    ]);
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw bad();
  const reader = request.body?.getReader();
  if (!reader) throw bad();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) {
        await reader.cancel();
        throw bad();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw bad();
  }
}
