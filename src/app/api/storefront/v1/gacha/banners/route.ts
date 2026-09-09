import { db } from "@/lib/db";
import { publicGachaBanners } from "@/modules/gacha/queries";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const headers = {
    "Cache-Control": "no-store",
    "CDN-Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  try {
    return Response.json(
      await publicGachaBanners(
        db,
        new URL(request.url).searchParams.get("page") ?? 1,
      ),
      { headers },
    );
  } catch {
    return Response.json(
      { error: { code: "SERVICE_UNAVAILABLE" } },
      { status: 503, headers },
    );
  }
}
