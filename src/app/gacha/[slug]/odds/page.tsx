import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { publicGachaOdds } from "@/modules/gacha/queries";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Gacha odds",
  description: "Current configured prize probabilities and banner terms.",
};
export default async function PublicOdds({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (slug.length > 180 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) notFound();
  const b = await publicGachaOdds(db, slug);
  if (!b) notFound();
  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: "clamp(16px,4vw,48px)",
        display: "grid",
        gap: 16,
      }}
    >
      <p className="eyebrow">KOKONO · PRIZE PROBABILITIES</p>
      <h1>{b.name}</h1>
      <p>{b.description}</p>
      <section
        className="panel form-section"
        style={{ display: "grid", gap: 12, minWidth: 0 }}
      >
        <h2>Current configuration · version {b.version}</h2>
        <p>
          Banner state: {b.drawState.replaceAll("_", " ")}. Customer pulls
          require account authorization. Paid draws are unavailable.
        </p>
        <p>
          Each draw uses the exact fractions below. Probabilities stay fixed
          within this version. When any prize is depleted, all draws stop;
          remaining prizes never receive redistributed odds. Percentages marked
          rounded are for readability; the fraction is exact.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Prize</th>
                <th>Exact probability</th>
                <th>Tier</th>
                <th>Weight</th>
                <th>Remaining allocation</th>
              </tr>
            </thead>
            <tbody>
              {b.prizes.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    <div>{p.description}</div>
                  </td>
                  <td>
                    {p.probability.numerator}/{p.probability.denominator}
                    <div>
                      {p.probability.percentage}%
                      {p.probability.percentageExact ? "" : " (rounded)"}
                    </div>
                  </td>
                  <td>{p.tier}</td>
                  <td>
                    {p.probability.weight} / {p.probability.totalWeight}
                  </td>
                  <td>
                    {p.remaining} / {p.allocation}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Window (UTC): {b.startsAt ?? "No start limit"} —{" "}
          {b.endsAt ?? "No end limit"}.
        </p>
        <p>
          These figures describe this version at page load. Reload for current
          allocation and banner state.
        </p>
      </section>
      <section className="panel form-section">
        <h2>Terms · {b.termsVersion}</h2>
        <p style={{ whiteSpace: "pre-wrap" }}>{b.terms}</p>
        <p style={{ overflowWrap: "anywhere" }}>
          Configuration: {b.configurationId}
          <br />
          SHA-256: {b.configurationDigest}
        </p>
      </section>
    </main>
  );
}
