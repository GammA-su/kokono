import { notFound } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { withInternalTransaction } from "@/modules/auth/transaction";
export const metadata = { title: "Gacha configuration audit" };
export default async function ConfigurationAudit({
  params,
}: {
  params: Promise<{ id: string; configurationId: string }>;
}) {
  const ids = z
    .object({ id: z.uuid(), configurationId: z.uuid() })
    .parse(await params);
  const c = await withInternalTransaction(db, requireInternalUser, (tx) =>
    tx.gachaConfiguration.findFirst({
      where: { id: ids.configurationId, bannerId: ids.id },
      include: { actorUser: { select: { name: true } } },
    }),
  );
  if (!c) notFound();
  return (
    <>
      <div className="page-heading">
        <h1>Configuration v{c.version}</h1>
        <Link className="button" href={`/admin/gacha/${ids.id}`}>
          Back to banner
        </Link>
      </div>
      <section className="panel form-section">
        <p>
          Created {c.createdAt.toISOString()} by {c.actorUser.name}. This
          snapshot cannot be edited or deleted.
        </p>
        <p style={{ overflowWrap: "anywhere" }}>SHA-256: {c.digest}</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {JSON.stringify(c.snapshot, null, 2)}
        </pre>
      </section>
    </>
  );
}
