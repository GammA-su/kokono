import Link from "next/link";
import { notFound } from "next/navigation";
import { landedCostQueries } from "@/lib/admin";
import { LandedCostReview } from "@/components/admin/landed-cost-review";
export const metadata = { title: "Finalized landed costs" };
export default async function CostHistory({
  params,
}: {
  params: Promise<{ id: string; calculationId: string }>;
}) {
  const { id, calculationId } = await params;
  const calculation = await landedCostQueries.detail(calculationId);
  if (!calculation || calculation.shipmentId !== id) notFound();
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">IMMUTABLE COST HISTORY</p>
          <h1>Finalized landed costs · version {calculation.revision}</h1>
          <p className="muted">
            {calculation.createdBy.name} · {calculation.createdAt.toISOString()}
          </p>
        </div>
        <Link className="button" href={`/admin/shipments/${id}/costs`}>
          History / new allocation
        </Link>
      </div>
      <LandedCostReview review={calculation.snapshot} />
    </>
  );
}
