"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createCatalogCsvService, csvFailure } from "./service";
import { MAX_CSV_BYTES } from "./format";
function service() {
  return createCatalogCsvService(
    db,
    requireInternalUser,
    process.env.BETTER_AUTH_SECRET ?? "",
  );
}
export async function previewCatalogCsv(form: FormData) {
  try {
    await requireInternalUser();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > MAX_CSV_BYTES)
      return { error: "Choose a nonempty UTF-8 CSV file up to 2 MiB." };
    let csv: string;
    try {
      csv = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      return {
        error:
          "This file is not valid UTF-8. Export it as CSV UTF-8 and try again.",
      };
    }
    const preview = await service().preview({
      lineupId: form.get("lineupId"),
      csv,
      policy: {
        updateWatch: form.get("updateWatch") === "on",
        updatePrivateNotes: form.get("updatePrivateNotes") === "on",
      },
    });
    return { preview };
  } catch (error) {
    return { error: csvFailure(error) };
  }
}
export async function importCatalogCsv(input: unknown) {
  try {
    const summary = await service().execute(input);
    revalidatePath("/admin", "layout");
    return { summary };
  } catch (error) {
    return { error: csvFailure(error) };
  }
}
