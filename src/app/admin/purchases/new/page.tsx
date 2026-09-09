import { randomUUID } from "node:crypto";
import { catalogQueries, requireAdminPage } from "@/lib/admin";
import { PurchaseForm } from "@/components/admin/purchase-form";
import { z } from "zod";
export const metadata = { title: "Create purchase" };
export default async function NewPurchase({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const parsed = z.uuid().safeParse((await searchParams).item);
  const selected = parsed.success
    ? await catalogQueries.selected([parsed.data])
    : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PURCHASING</p>
          <h1>Create purchase</h1>
        </div>
      </div>
      <PurchaseForm
        initial={{
          id: randomUUID(),
          purchaseDate: new Date().toISOString().slice(0, 10),
          currency: "JPY",
          items: selected
            .filter((item) => !item.archived)
            .map((item) => ({
              key: randomUUID(),
              merchandiseItemId: item.id,
              name: `${item.name} · ${item.internalSku}`,
              quantity: "1",
              unitPrice: "",
              condition: "",
              sellerListingUrl: "",
              notes: "",
            })),
        }}
      />
    </>
  );
}
