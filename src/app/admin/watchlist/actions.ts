"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createWatchlistCommands } from "@/modules/watchlist/commands";
import { formError, type FormState } from "@/modules/lineups/action-state";

export type WatchState = FormState & { message?: string; version?: string };
export async function updateWatch(
  _state: WatchState,
  form: FormData,
): Promise<WatchState> {
  try {
    const input: Record<string, unknown> = Object.fromEntries(
      [...form.entries()].filter(([key]) => !key.startsWith("$ACTION_")),
    );
    if (input.action === "save") input.enabled = form.get("enabled") === "on";
    const result = await createWatchlistCommands(
      db,
      requireInternalUser,
    ).execute(input);
    revalidatePath("/admin", "layout");
    return {
      message:
        input.action === "checked"
          ? "Marked checked."
          : input.action === "disable"
            ? "Watch disabled."
            : "Watch saved.",
      ...("updatedAt" in result
        ? { version: result.updatedAt.toISOString() }
        : {}),
    };
  } catch (error) {
    if (error instanceof z.ZodError)
      return {
        error: error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" "),
        version: _state.version,
      };
    return { ...formError(error), version: _state.version };
  }
}
