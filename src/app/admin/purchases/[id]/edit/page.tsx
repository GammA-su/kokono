import { notFound } from "next/navigation";
import Link from "next/link";
import { purchaseQueries } from "@/lib/admin";
import { PurchaseForm } from "@/components/admin/purchase-form";
import { moneyInputValue } from "@/modules/shared/money";
export const metadata = { title: "Edit purchase" };
export default async function EditPurchase({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const purchase = await purchaseQueries.detail((await params).id);
  if (!purchase) notFound();
  if (purchase.status !== "DRAFT")
    return (
      <>
        <h1>Purchase is locked</h1>
        <p>Only drafts can be edited.</p>
        <Link href={`/admin/purchases/${purchase.id}`}>Back to purchase</Link>
      </>
    );
  return (
    <>
      <div className="page-heading">
        <h1>Edit draft purchase</h1>
      </div>
      <PurchaseForm
        initial={{
          id: purchase.id,
          version: purchase.updatedAt.toISOString(),
          supplier: purchase.supplier,
          marketplace: purchase.marketplace || "",
          externalReference: purchase.externalReference || "",
          purchaseDate: purchase.purchaseDate.toISOString().slice(0, 10),
          currency: purchase.currency,
          status: purchase.status,
          notes: purchase.notes || "",
          domesticShipping: moneyInputValue(
            purchase.domesticShippingAmount,
            purchase.currency,
          ),
          fees: moneyInputValue(purchase.feesAmount, purchase.currency),
          taxes: moneyInputValue(purchase.taxesAmount, purchase.currency),
          items: purchase.items.map((item) => ({
            key: item.id,
            merchandiseItemId: item.merchandiseItemId,
            name: `${item.merchandiseItem.name} · ${item.merchandiseItem.internalSku}`,
            quantity: String(item.quantity),
            unitPrice: moneyInputValue(item.unitPriceAmount, purchase.currency),
            condition: item.condition || "",
            sellerListingUrl: item.sellerListingUrl || "",
            notes: item.notes || "",
          })),
        }}
      />
    </>
  );
}
