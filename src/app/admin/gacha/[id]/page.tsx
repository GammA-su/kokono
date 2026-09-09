import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createGachaQueries } from "@/modules/gacha/queries";
import { probability } from "@/modules/gacha/probability";
import { GachaAction, GachaSimulator } from "@/components/admin/gacha-controls";
import { Pagination } from "@/components/admin/pagination";
export const metadata = { title: "Gacha banner" };
export default async function GachaDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params,
    { page } = await searchParams,
    r = await createGachaQueries(db, requireInternalUser).detail(id, page);
  if (!r || !r.banner.currentConfiguration) notFound();
  const b = r.banner,
    c = b.currentConfiguration!,
    common = { bannerId: id, configurationId: c.id };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">GACHA · VERSION {c.version}</p>
          <h1>{b.name}</h1>
          <p>{r.readiness.reason.replaceAll("_", " ")} · Paid draws disabled</p>
        </div>
        <div className="form-actions">
          <Link
            className="button"
            href={`/gacha/${b.slug}/odds`}
            target="_blank"
          >
            Public odds
          </Link>
          <Link className="button" href={`/admin/gacha/${id}/edit`}>
            Edit configuration
          </Link>
        </div>
      </div>
      <section className="panel form-section">
        <h2>Configured odds and stock backing</h2>
        <p>{b.description}</p>
        <p>
          Odds remain fixed. If any prize runs out, every draw stops. Pausing
          keeps stock reserved; releasing the pool frees only unawarded units.
          Awards already made are preserved.
        </p>
        <p>
          Window (UTC): {b.startsAt?.toISOString() ?? "No start limit"} —{" "}
          {b.endsAt?.toISOString() ?? "No end limit"}. Terms version:{" "}
          {b.termsVersion}.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Prize</th>
                <th>Tier</th>
                <th>Weight</th>
                <th>Exact odds</th>
                <th>Original allocation</th>
                <th>Unawarded reserved units</th>
              </tr>
            </thead>
            <tbody>
              {c.prizes.map((p) => {
                const o = probability(p.weight, c.totalWeight);
                return (
                  <tr key={p.id}>
                    <td>
                      <Link
                        href={`/admin/merchandise/catalog/${p.merchandiseItemId}`}
                      >
                        {p.displayName}
                      </Link>
                    </td>
                    <td>{p.tier}</td>
                    <td>
                      {p.weight} / {c.totalWeight}
                    </td>
                    <td>
                      {o.numerator}/{o.denominator} ({o.percentage}%
                      {o.percentageExact ? "" : " rounded"})
                    </td>
                    <td>{p.allocation}</td>
                    <td>{r.readiness.remaining[p.id] ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Link href={`/admin/gacha/${id}/configurations/${c.id}`}>
          View immutable configuration and terms
        </Link>
      </section>
      <section className="panel form-section">
        <h2>Operations</h2>
        <p>
          Grants are internal, no-charge operations. Identify the recipient
          explicitly. Customer execution requires explicit no-charge
          authorization. Paid draws are unavailable.
        </p>
        {r.readiness.ready && (
          <GachaAction
            {...common}
            action="GRANT"
            label="Grant one draw"
            operationKey={randomUUID()}
          />
        )}
        <details>
          <summary>Pause, resume or release pool</summary>
          <GachaAction
            {...common}
            action={b.active ? "PAUSE" : "RESUME"}
            label={b.active ? "Pause banner" : "Resume banner"}
          />
          <GachaAction
            {...common}
            action="RELEASE_POOL"
            label="Release unawarded stock and pause"
          />
        </details>
      </section>
      <section className="panel form-section">
        <h2>Customer no-charge execution</h2>
        <p>
          Banner permission: {b.customerEnabled ? "Enabled" : "Disabled"}. The
          server setting GACHA_CUSTOMER_EXECUTION_ENABLED must also be true. No
          payment is accepted. Each customer needs an expiring, bounded
          authorization.
        </p>
        <GachaAction
          {...common}
          action={b.customerEnabled ? "CUSTOMER_DISABLE" : "CUSTOMER_ENABLE"}
          label={
            b.customerEnabled
              ? "Disable customer pulls"
              : "Enable authorized free pulls"
          }
        />
        <GachaAction
          {...common}
          action="CUSTOMER_AUTHORIZE"
          label="Authorize free customer pulls"
          operationKey={randomUUID()}
        />
      </section>
      <GachaSimulator
        configurationId={c.id}
        names={Object.fromEntries(c.prizes.map((p) => [p.id, p.displayName]))}
      />
      <section className="panel form-section">
        <h2>Pull history</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date / pull</th>
                <th>Customer / operator</th>
                <th>Result / configuration</th>
                <th>Physical reservation</th>
                <th>Status / actions</th>
              </tr>
            </thead>
            <tbody>
              {r.pulls.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.createdAt.toISOString()}
                    <div className="muted">{p.id}</div>
                  </td>
                  <td>
                    {p.customerReference}
                    <div className="muted">
                      Operator: {p.actorUser?.name ?? "Customer execution"}
                    </div>
                  </td>
                  <td>
                    {p.prize.displayName}
                    <div>
                      Ticket {p.randomTicket} of [0,{" "}
                      {p.configuration.totalWeight})
                    </div>
                    <Link
                      href={`/admin/gacha/${id}/configurations/${p.configurationId}`}
                    >
                      Configuration v{p.configuration.version}
                    </Link>
                    <details>
                      <summary>Immutable audit</summary>
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {JSON.stringify(p.audit, null, 2)}
                      </pre>
                    </details>
                  </td>
                  <td>
                    {r.locations.find(
                      (l) => l.id === p.reservation?.storageLocationId,
                    )?.path ?? "Unknown"}
                    <div>1 unit · {p.reservation?.status}</div>
                    <Link
                      href={`/admin/merchandise/catalog/${p.prize.merchandiseItemId}/movements`}
                    >
                      Inventory history
                    </Link>
                    {p.reservation?.movementId && (
                      <div>Movement: {p.reservation.movementId}</div>
                    )}
                  </td>
                  <td>
                    {p.status}
                    {p.customerId && (
                      <Link href="/admin/gacha/rewards">
                        Customer fulfillment queue
                      </Link>
                    )}
                    {p.status === "RESERVED" && !p.customerId && (
                      <details>
                        <summary>Finalize award</summary>
                        <p>
                          Cancellation releases the unit to ordinary inventory.
                          It does not reroll or refill this pool.
                        </p>
                        <GachaAction
                          {...common}
                          action="CONSUME"
                          pullId={p.id}
                          label="Record physical handover / dispatch"
                        />
                        <GachaAction
                          {...common}
                          action="CANCEL"
                          pullId={p.id}
                          label="Cancel award and release unit"
                        />
                      </details>
                    )}
                  </td>
                </tr>
              ))}
              {!r.pulls.length && (
                <tr>
                  <td colSpan={5}>
                    No actual pulls. Simulations do not appear here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base={`/admin/gacha/${id}`}
          params={{}}
          {...{
            page: r.page,
            pageCount: r.pageCount,
            total: r.total,
            size: r.size,
          }}
        />
      </section>
      <section className="panel form-section">
        <h2>Recent audit events</h2>
        <ul>
          {r.events.map((e) => (
            <li key={e.id}>
              {e.createdAt.toISOString()} · {e.type} ·{" "}
              {e.actorUser?.name ?? "Customer execution"} · {e.note}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
