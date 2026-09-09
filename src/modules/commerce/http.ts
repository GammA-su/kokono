import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { DomainError } from "../shared/errors";
import { checkoutPolicy } from "./policy";
import { createCommerceService } from "./service";
import { createPaymentService } from "./payments";
import { paymentConfiguration, stripeProvider } from "./stripe";
import { requireCustomer } from "../customers/service";
import { randomUUID } from "node:crypto";
import { correlationId, recordFailure } from "../shared/correlation";

const headers = {
  "Cache-Control": "no-store",
  "CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
export function commerceJson(
  value: unknown,
  status = 200,
  extra?: Record<string, string>,
) {
  return Response.json(value, {
    status,
    headers: extra ? { ...headers, ...extra } : headers,
  });
}
export async function boundedBody(request: Request, limit = 32768) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new DomainError("INVALID_REQUEST", "Request is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
function gateway(request: Request) {
  const expected = process.env.COMMERCE_GATEWAY_SECRET,
    actual = request.headers.get("x-commerce-gateway-key");
  if (
    !expected || expected.length < 32 ||
    !actual ||
    Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    throw new DomainError("UNAUTHORIZED", "Guest access is required.");
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !==
      new URL(process.env.STOREFRONT_BASE_URL!).origin
  )
    throw new DomainError("FORBIDDEN", "Request origin is not allowed.");
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}
export function createCommerceHandler(database: PrismaClient) {
  const service = createCommerceService(database);
  return async (request: Request, path: string[]) => {
    // One id per request, honouring the storefront's if it supplied one, so a customer's
    // reference points at the same request in both applications' logs.
    const reference = correlationId(request.headers);
    try {
      let token = gateway(request);
      const customerSession = request.headers.get("x-customer-session") ?? "",
        route = path.join("/");
      if (request.method === "GET" && route === "config") {
        const policy = checkoutPolicy();
        return commerceJson({
          payment: paymentConfiguration(),
          policy: {
            currency: policy.currency,
            zone: policy.zone,
            supportedCountries: policy.supportedCountries,
            deliveryMethod: policy.deliveryMethod,
            shippingAmount: policy.shippingAmount,
            freeShippingThreshold: policy.freeShippingThreshold,
            defaultVatRateBps: policy.defaultVatRateBps,
            taxInclusion: "INCLUDED",
          },
        });
      }
      const legacyRead =
        request.method === "GET" && /^orders\/[0-9a-f-]{36}$/i.test(route);
      if ((route !== "config" && !legacyRead) || customerSession) {
        const customer = await requireCustomer(
          database,
          customerSession,
          route === "checkout" ? "CHECKOUT" : false,
        );
        token = customer.commerceKey;
      }
      if (legacyRead) return commerceJson(await service.get(token, path[1]));
      if (request.method !== "POST")
        return commerceJson(
          { error: { code: "NOT_FOUND", message: "Not found." } },
          404,
        );
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new DomainError("INVALID_REQUEST", "JSON is required.");
      const input = JSON.parse(await boundedBody(request));
      if (route === "quote")
        return commerceJson(await service.quote(token, input));
      if (route === "checkout") {
        if (!paymentConfiguration().enabled)
          throw new DomainError(
            "CHECKOUT_DISABLED",
            "Stripe test checkout is not configured.",
          );
        return commerceJson(
          await service.checkout(token, input, customerSession),
        );
      }
      if (/^orders\/[0-9a-f-]{36}\/(payment|cancel)$/i.test(route)) {
        z.object({}).strict().parse(input);
        if (path[2] === "cancel")
          return commerceJson(await service.cancel(token, path[1]));
        return commerceJson(
          await createPaymentService(database, stripeProvider()).start(
            token,
            path[1],
          ),
        );
      }
      return commerceJson(
        { error: { code: "NOT_FOUND", message: "Not found." } },
        404,
      );
    } catch (error) {
      return commerceError(error, reference);
    }
  };
}
export function commerceError(error: unknown, reference?: string) {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return commerceJson(
      {
        error: {
          code: "INVALID_REQUEST",
          message:
            error instanceof z.ZodError
              ? error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join(" ")
              : "Invalid JSON.",
        },
      },
      400,
    );
  if (error instanceof DomainError)
    return commerceJson(
      { error: { code: error.code, message: error.message } },
      error.code === "UNAUTHORIZED"
        ? 401
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "RATE_LIMITED"
              ? 429
              : error.code === "CHECKOUT_DISABLED"
                ? 503
                : 409,
    );
  // Only genuinely unexpected failures carry a reference. Domain errors above are expected,
  // already say what went wrong, and would only be made noisier by an opaque identifier.
  // The reference is safe to show: it is an opaque id, not a stack trace or an internal message.
  const id = reference ?? randomUUID();
  recordFailure(id, "commerce", error);
  return commerceJson(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message:
          "Checkout is temporarily unavailable. Retry the same operation or refresh your order.",
        reference: id,
      },
    },
    503,
    { "X-Request-Id": id },
  );
}
