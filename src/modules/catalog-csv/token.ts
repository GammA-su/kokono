import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../shared/errors";
import { MAX_IMPORT_ROWS } from "./format";

export const importPolicySchema = z
  .object({
    updatePrivateNotes: z.boolean().default(false),
    updateWatch: z.boolean().default(false),
  })
  .strict();
export type ImportPolicy = z.infer<typeof importPolicySchema>;
export const importSnapshotSchema = z
  .object({
    actorId: z.string(),
    nonce: z.uuid(),
    lineupId: z.uuid(),
    expires: z.number(),
    csv: z.string(),
    policy: importPolicySchema,
    rows: z
      .array(
        z.object({
          createId: z.uuid(),
          candidates: z
            .array(z.object({ id: z.uuid(), revision: z.string() }))
            .max(100),
        }),
      )
      .max(MAX_IMPORT_ROWS),
  })
  .strict();
export type ImportSnapshot = z.infer<typeof importSnapshotSchema>;
/** Same actor-bound, expiring HMAC convention as the existing bulk review; separate signing namespace. */
export function importTokenCodec(secret: string) {
  if (secret.length < 32)
    throw new Error("A strong CSV review signing secret is required.");
  const sign = (payload: string) =>
    createHmac("sha256", secret).update(`catalog-csv:${payload}`).digest();
  const invalid = () =>
    new DomainError(
      "CSV_REVIEW",
      "CSV review expired or changed. Upload and review the file again.",
    );
  return {
    sign(value: ImportSnapshot) {
      const payload = Buffer.from(
        JSON.stringify(importSnapshotSchema.parse(value)),
      ).toString("base64url");
      if (payload.length > 5_400_000)
        throw new DomainError(
          "CSV_SIZE",
          "This file and its duplicate matches are too large for one review. Split the CSV into smaller files.",
        );
      return `${payload}.${sign(payload).toString("base64url")}`;
    },
    verify(token: string, actorId: string) {
      if (token.length > 5_500_000) throw invalid();
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra) throw invalid();
      const expected = sign(payload),
        received = Buffer.from(signature, "base64url");
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw invalid();
      let result: ImportSnapshot;
      try {
        result = importSnapshotSchema.parse(
          JSON.parse(Buffer.from(payload, "base64url").toString()),
        );
      } catch {
        throw invalid();
      }
      if (result.actorId !== actorId || result.expires < Date.now())
        throw invalid();
      return result;
    },
  };
}
