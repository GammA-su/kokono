import { notFound } from "next/navigation";
import Link from "next/link";
import { marketplaceListingQueries } from "@/lib/admin";
import { MarketplaceCandidateForm } from "@/components/admin/marketplace-candidate-form";
export const metadata = { title: "Edit marketplace candidate" };
export default async function EditCandidate({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const row = await marketplaceListingQueries.detail((await params).id);
  if (!row) notFound();
  return (
    <>
      <div className="page-heading">
        <h1>Edit marketplace candidate</h1>
      </div>
      <section className="panel form-section">
        {row.purchaseItem ? (
          <p>
            This offer has been converted.{" "}
            <Link href={`/admin/purchases/${row.purchaseItem.purchaseId}`}>
              Open its purchase
            </Link>
            .
          </p>
        ) : (
          <MarketplaceCandidateForm
            id={row.id}
            itemId={row.merchandiseItemId}
            candidate={row}
          />
        )}
      </section>
    </>
  );
}
