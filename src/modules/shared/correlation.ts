import { randomUUID } from "node:crypto";

/**
 * Request correlation.
 *
 * A customer who hits an unexpected failure needs something they can quote to support, and an
 * operator needs to find that exact request in the logs. A stack trace does both jobs badly: it
 * leaks internals to the customer and is not searchable by the customer at all.
 *
 * So one opaque identifier travels with the request: generated at the storefront edge, forwarded
 * to this service, written to the log next to the real error, and shown to the customer only when
 * something genuinely unexpected happened.
 */
const REFERENCE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The caller's id is honoured only when it is a plain bounded token, so a forged header cannot
 * inject log-forging characters, newlines or unbounded content into the log stream. Anything
 * else is replaced rather than rejected: correlation is a diagnostic aid and must never be the
 * reason a request fails.
 */
export function correlationId(headers: Headers): string {
  const supplied = headers.get("x-request-id");
  return supplied && REFERENCE.test(supplied) ? supplied : randomUUID();
}

/**
 * Records an unexpected failure against its reference and returns that reference.
 *
 * Only the error's own message and name are logged — never the request body, headers, tokens or
 * customer identity — and nothing is returned to the caller except the opaque reference itself.
 */
export function recordFailure(
  reference: string,
  scope: string,
  error: unknown,
): string {
  console.error(
    JSON.stringify({
      event: "unhandled-request-failure",
      reference,
      scope,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "non-error thrown",
    }),
  );
  return reference;
}
