import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { candidateSchema } from "./types";
import { DomainError } from "../shared/errors";
const schema = z
  .object({
    stage: z.enum(["extracted", "reviewed"]),
    actorId: z.string(),
    lineupId: z.uuid(),
    franchiseId: z.uuid(),
    expires: z.number(),
    original: z.array(candidateSchema).max(50),
    rows: z.array(candidateSchema).max(50),
    duplicateFingerprint: z.string(),
  })
  .strict();
export type ReviewSnapshot = z.infer<typeof schema>;
export function reviewTokens(secret: string) {
  if (secret.length < 32)
    throw new Error("A strong assisted import signing secret is required.");
  const signature = (payload: string) =>
    createHmac("sha256", secret)
      .update(`assisted-import-v1:${payload}`)
      .digest();
  const invalid = () =>
    new DomainError(
      "IMPORT_REVIEW",
      "This import review expired or changed. Extract and review the source again.",
    );
  return {
    sign(value: ReviewSnapshot) {
      const payload = Buffer.from(JSON.stringify(schema.parse(value))).toString(
        "base64url",
      );
      if (payload.length > 2000000)
        throw new DomainError(
          "IMPORT_SIZE",
          "This source is too large for one review. Use a smaller page.",
        );
      return `${payload}.${signature(payload).toString("base64url")}`;
    },
    verify(token: string, actorId: string) {
      if (token.length > 2100000) throw invalid();
      const [payload, mac, extra] = token.split(".");
      if (!payload || !mac || extra) throw invalid();
      const received = Buffer.from(mac, "base64url"),
        expected = signature(payload);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw invalid();
      let value: ReviewSnapshot;
      try {
        value = schema.parse(
          JSON.parse(Buffer.from(payload, "base64url").toString()),
        );
      } catch {
        throw invalid();
      }
      if (value.actorId !== actorId || value.expires < Date.now())
        throw invalid();
      return value;
    },
  };
}
