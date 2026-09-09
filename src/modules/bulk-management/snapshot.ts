import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bulkActionSchema, MAX_BULK_ITEMS } from "./selection";
import { DomainError } from "../shared/errors";

const snapshotSchema = z
  .object({
    actorId: z.string(),
    action: bulkActionSchema,
    nonce: z.uuid(),
    expires: z.number(),
    items: z
      .array(
        z.object({
          id: z.uuid(),
          updatedAt: z.string(),
          listingUpdatedAt: z.string().nullable(),
        }),
      )
      .min(1)
      .max(MAX_BULK_ITEMS),
  })
  .strict();
export type BulkSnapshot = z.infer<typeof snapshotSchema>;
export function snapshotCodec(secret: string) {
  if (secret.length < 32)
    throw new Error("A strong bulk selection signing secret is required.");
  const signature = (payload: string) =>
    createHmac("sha256", secret).update(`merchandise-bulk:${payload}`).digest();
  return {
    sign(snapshot: BulkSnapshot) {
      const payload = Buffer.from(
        JSON.stringify(snapshotSchema.parse(snapshot)),
      ).toString("base64url");
      return `${payload}.${signature(payload).toString("base64url")}`;
    },
    verify(token: string, actorId: string) {
      const invalid = () =>
        new DomainError(
          "INVALID_SELECTION",
          "Selection expired or changed. Review the selection again.",
        );
      if (token.length > 300_000) throw invalid();
      const [payload, mac, extra] = token.split(".");
      if (!payload || !mac || extra) throw invalid();
      const received = Buffer.from(mac, "base64url");
      const expected = signature(payload);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw invalid();
      let snapshot: BulkSnapshot;
      try {
        snapshot = snapshotSchema.parse(
          JSON.parse(Buffer.from(payload, "base64url").toString()),
        );
      } catch {
        throw invalid();
      }
      if (snapshot.actorId !== actorId || snapshot.expires < Date.now())
        throw invalid();
      return snapshot;
    },
  };
}
