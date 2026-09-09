import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createCatalogQueries } from "@/modules/catalog/queries";
import { csvColumns, csvRecord } from "@/modules/catalog-csv/format";
import { csvHeader, exportItemRecord } from "@/modules/catalog-csv/export";
import { DomainError } from "@/modules/shared/errors";

export async function GET(request: Request) {
  try {
    const actor = await requireInternalUser();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const headers = {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="merchandise-catalog.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (params.template === "1")
      return new Response("\uFEFF" + csvRecord([...csvColumns]), { headers });
    // Capture request identity before streaming; each query still rechecks membership in its transaction.
    const queries = createCatalogQueries(db, async () => actor);
    const filters =
      params.scope === "lineup"
        ? { lineup: z.uuid().parse(params.lineup), archived: "true" }
        : params;
    const ids = await queries.matchingIds(filters, 100001);
    if (ids.length > 100000)
      return Response.json(
        {
          error:
            "More than 100,000 matches. Narrow the catalog filters before exporting.",
        },
        { status: 422 },
      );
    let offset = -1;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (offset === -1) {
            controller.enqueue(encoder.encode(csvHeader));
            offset = 0;
            return;
          }
          if (offset >= ids.length) {
            controller.close();
            return;
          }
          const items = await queries.exportRecords(
            ids.slice(offset, offset + 500),
          );
          offset += 500;
          controller.enqueue(
            encoder.encode(items.map(exportItemRecord).join("")),
          );
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, { headers });
  } catch (error) {
    const status =
      error instanceof DomainError && error.code === "UNAUTHENTICATED"
        ? 401
        : error instanceof DomainError && error.code === "FORBIDDEN"
          ? 403
          : 400;
    return Response.json(
      {
        error:
          status === 400
            ? "Invalid catalog export request."
            : "Internal access required.",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
