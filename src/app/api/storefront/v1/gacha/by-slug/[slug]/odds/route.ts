import { db } from "@/lib/db";
import { publicGachaOdds } from "@/modules/gacha/queries";
import { z } from "zod";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = {
  "Cache-Control": "no-store",
  "CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const result = await publicGachaOdds(db, (await params).slug);
    return Response.json(result ?? { error: { code: "NOT_FOUND" } }, {
      status: result ? 200 : 404,
      headers,
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          code:
            error instanceof z.ZodError
              ? "INVALID_REQUEST"
              : "SERVICE_UNAVAILABLE",
        },
      },
      { status: error instanceof z.ZodError ? 400 : 503, headers },
    );
  }
}
