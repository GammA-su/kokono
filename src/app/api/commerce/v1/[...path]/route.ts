import { db } from "@/lib/db";
import { createCommerceHandler } from "@/modules/commerce/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createCommerceHandler(db);
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return handler(request, (await context.params).path);
}
export const POST = GET;
