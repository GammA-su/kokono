import { z } from "zod";
import { DomainError } from "../shared/errors";
export type FormState = { error?: string; fields?: Record<string, string[]> };
export function formError(error: unknown): FormState {
  if (error instanceof z.ZodError)
    return {
      error: "Check the highlighted fields and source links.",
      fields: z.flattenError(error).fieldErrors as Record<string, string[]>,
    };
  if (error instanceof DomainError) return { error: error.message };
  if ((error as { code?: string })?.code === "P2002")
    return {
      error: "This SKU or source link already exists. Use a unique value.",
    };
  if ((error as { code?: string })?.code === "P2003")
    return { error: "A linked record changed. Refresh and try again." };
  console.error(
    "Admin operation failed",
    error instanceof Error ? error.name : "Unknown error",
  );
  return { error: "Unable to save changes. Please try again." };
}
