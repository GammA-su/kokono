import { customerHandler } from "@/lib/customer-handler";
export const runtime = "nodejs";
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return customerHandler(request, ["auth", ...(await context.params).path]);
}
export { handle as GET, handle as POST };
