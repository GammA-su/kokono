import Link from "next/link";
import { publicationQueries } from "@/lib/admin";
import { PublishItemButton } from "@/components/admin/publish-item-button";
import { ActionForm, Field } from "@/components/admin/action-form";
import { Pagination } from "@/components/admin/pagination";
import { saveCategoryMapping } from "./actions";
export const metadata = { title: "Store publication readiness" };
export default async function Publication({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams,
    report = await publicationQueries.report(query),
    config = await publicationQueries.configuration();
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>Store publication</h1>
          <p>
            Review listing readiness and map internal categories to public
            navigation.
          </p>
        </div>
      </div>
      {query.mapped === "1" && (
        <p className="alert" role="status">
          Category mapping saved.
        </p>
      )}
      <section className="panel form-section">
        <h2>Listing readiness</h2>
        <p className="muted">
          Publication flags and historical records are retained. Listings with
          missing category mappings or no approved selected managed images are
          excluded from the public API. Missing or unreadable files need
          remediation. Review each affected listing; this report does not
          publish or modify records.
        </p>
        <p>
          Open on Store is available on item pages when the public website
          connection is enabled.
        </p>
      </section>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Merchandise</th>
                <th>Stored state</th>
                <th>Policy check</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/admin/merchandise/catalog/${item.id}`}>
                      {item.name}
                    </Link>
                  </td>
                  <td>{item.published ? "Published" : "Draft"}</td>
                  <td>
                    {item.issues.length ? (
                      <span className="field-error">
                        {item.issues.join(" ")}
                      </span>
                    ) : (
                      "Ready under current policy"
                    )}
                  </td>
                  <td>
                    <PublishItemButton itemId={item.id} />
                  </td>
                </tr>
              ))}
              {!report.items.length && (
                <tr>
                  <td colSpan={4}>
                    No listings configured. Open a catalog item to start
                    publication review.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/publication"
          params={{}}
          page={report.page}
          pageCount={report.pageCount}
          total={report.total}
          size={report.size}
        />
      </section>
      <section className="panel form-section">
        <h2>Public category defaults</h2>
        <p className="muted">
          A listing override takes priority. Unmapped items need a deliberate
          mapping before publication. Changing a default affects existing
          listings using that default.
        </p>
        {config.categories.map((category) => (
          <details key={category.id}>
            <summary>
              {category.name} →{" "}
              {config.publicCategories.find(
                (entry) => entry.id === category.publicCategoryId,
              )?.name ?? "Unmapped"}
            </summary>
            <ActionForm
              action={saveCategoryMapping}
              submitLabel="Save category mapping"
            >
              <input type="hidden" name="categoryId" value={category.id} />
              <input
                type="hidden"
                name="expectedPublicCategoryId"
                value={category.publicCategoryId ?? ""}
              />
              <Field name="publicCategoryId" label="Public category">
                <select
                  name="publicCategoryId"
                  aria-label={`${category.name} public category`}
                  defaultValue={category.publicCategoryId ?? ""}
                >
                  <option value="">Unmapped</option>
                  {config.publicCategories.map((entry) => (
                    <option value={entry.id} key={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
            </ActionForm>
          </details>
        ))}
      </section>
    </>
  );
}
