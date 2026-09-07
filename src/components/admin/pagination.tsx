import Link from "next/link";

export function pageHref(
  base: string,
  params: Record<string, string | number | undefined>,
  page: number,
) {
  const query = new URLSearchParams();
  const values: Record<string, string | number | undefined> = {
    ...params,
    page,
  };
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") query.set(key, String(value));
  return `${base}?${query}`;
}
export function Pagination({
  base,
  params,
  page,
  pageCount,
  total,
  size,
}: {
  base: string;
  params: Record<string, string | number | undefined>;
  page: number;
  pageCount: number;
  total: number;
  size: number;
}) {
  return (
    <div className="pagination">
      <span>
        {total
          ? `${((page - 1) * size + 1).toLocaleString()}–${Math.min(page * size, total).toLocaleString()} of ${total.toLocaleString()}`
          : "0 results"}
      </span>
      <nav aria-label="Pagination">
        <span className="page-info">
          Page {page} of {pageCount}
        </span>
        {page > 1 ? (
          <Link
            className="button small"
            href={pageHref(base, params, page - 1)}
          >
            Previous
          </Link>
        ) : (
          <span className="button small disabled" aria-disabled="true">
            Previous
          </span>
        )}
        {page < pageCount ? (
          <Link
            className="button small"
            href={pageHref(base, params, page + 1)}
          >
            Next
          </Link>
        ) : (
          <span className="button small disabled" aria-disabled="true">
            Next
          </span>
        )}
      </nav>
    </div>
  );
}
