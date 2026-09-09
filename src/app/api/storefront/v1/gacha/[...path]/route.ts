import { db } from "@/lib/db";
import { createCustomerGachaHandler } from "@/modules/gacha/customer-http";
export const runtime = "nodejs";
const handler = createCustomerGachaHandler(db);
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return handler(request, (await context.params).path);
}
export { handle as GET, handle as POST };
