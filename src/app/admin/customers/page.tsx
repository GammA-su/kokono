import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { withInternalTransaction } from "@/modules/auth/transaction";
import { Pagination } from "@/components/admin/pagination";
import { changeCustomerStatus } from "./actions";
import { z } from "zod";
export const metadata = { title: "Customers" };
export default async function Customers({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const input = z
    .object({
      q: z.string().trim().max(150).catch(""),
      page: z.coerce.number().int().min(1).catch(1),
    })
    .parse(await searchParams);
  const result = await withInternalTransaction(
    db,
    requireInternalUser,
    async (tx) => {
      const where = input.q
          ? { email: { contains: input.q, mode: "insensitive" as const } }
          : {},
        total = await tx.customer.count({ where }),
        size = 30,
        pageCount = Math.max(1, Math.ceil(total / size)),
        page = Math.min(input.page, pageCount);
      const items = await tx.customer.findMany({
        where,
        skip: (page - 1) * size,
        take: size,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          email: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          _count: { select: { orders: true } },
        },
      });
      return { items, total, size, pageCount, page };
    },
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CUSTOMER ACCOUNTS</p>
          <h1>
            Customers <span className="heading-count">{result.total}</span>
          </h1>
          <p className="muted">
            Customer sessions are separate from internal accounts. Disabling
            revokes sessions and reset links; historical records remain intact.
          </p>
        </div>
      </div>
      <form className="panel form-section field-grid" method="get">
        <label className="field">
          <span>Email</span>
          <input name="q" defaultValue={input.q} />
        </label>
        <button className="button">Search</button>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last login</th>
                <th>Orders</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.email}
                    <br />
                    <small className="muted">{c.id}</small>
                  </td>
                  <td>{c.status}</td>
                  <td>{c.createdAt.toISOString().slice(0, 10)}</td>
                  <td>
                    {c.lastLoginAt
                      ?.toISOString()
                      .slice(0, 16)
                      .replace("T", " ") ?? "Never"}
                  </td>
                  <td>{c._count.orders}</td>
                  <td>
                    <form action={changeCustomerStatus}>
                      <input type="hidden" name="id" value={c.id} />
                      <input
                        type="hidden"
                        name="disabled"
                        value={String(c.status !== "DISABLED")}
                      />
                      <button className="button secondary">
                        {c.status === "DISABLED"
                          ? "Re-enable account"
                          : "Disable account"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/customers"
          params={input}
          page={result.page}
          pageCount={result.pageCount}
          total={result.total}
          size={result.size}
        />
      </section>
      <p className="muted">
        Customer-linked gacha pulls and rewards are not implemented yet; counts
        will appear when ownership is available.
      </p>
    </>
  );
}
