import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createGachaQueries } from "@/modules/gacha/queries";
import { GachaEditor } from "@/components/admin/gacha-editor";
export const metadata = { title: "Edit gacha configuration" };
export default async function EditGacha({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    result = await createGachaQueries(db, requireInternalUser).detail(id);
  if (!result) notFound();
  const b = result.banner;
  return (
    <>
      <div className="page-heading">
        <h1>Edit {b.name}</h1>
      </div>
      <GachaEditor
        initial={{
          id: b.id,
          expectedConfigurationId: b.currentConfigurationId,
          name: b.name,
          slug: b.slug,
          description: b.description,
          startsAt: b.startsAt?.toISOString() ?? null,
          endsAt: b.endsAt?.toISOString() ?? null,
          active: b.active,
          currency: b.currency,
          pullPriceAmount: b.pullPriceAmount,
          terms: b.terms,
          termsVersion: b.termsVersion,
          prizes:
            b.currentConfiguration?.prizes.map((p) => ({
              merchandiseItemId: p.merchandiseItemId,
              displayName: p.displayName,
              description: p.description,
              tier: p.tier,
              weight: p.weight,
              allocation: p.allocation,
            })) ?? [],
        }}
      />
    </>
  );
}
