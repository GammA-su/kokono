import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { boundedBody, commerceJson } from "../commerce/http";
import { DomainError } from "../shared/errors";
import {
  createCustomerService,
  customerRateLimit,
  type CustomerMail,
} from "./service";

export function customerGateway(request: Request) {
  const expected = process.env.COMMERCE_GATEWAY_SECRET ?? "",
    actual = request.headers.get("x-commerce-gateway-key") ?? "";
  if (
    expected.length < 32 ||
    actual.length !== expected.length ||
    Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    throw new DomainError("UNAUTHORIZED", "Customer access is required.");
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !==
      new URL(process.env.STOREFRONT_BASE_URL!).origin
  )
    throw new DomainError("FORBIDDEN", "Request origin is not allowed.");
  return request.headers.get("x-customer-session") ?? "";
}
export function customerError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return commerceJson(
      {
        error: {
          code: "INVALID_REQUEST",
          message:
            "Check the submitted fields. Passwords require 12–1024 characters.",
        },
      },
      400,
    );
  if (error instanceof DomainError)
    return commerceJson(
      { error: { code: error.code, message: error.message } },
      error.code === "UNAUTHORIZED" || error.code === "INVALID_CREDENTIALS"
        ? 401
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "RATE_LIMITED"
              ? 429
              : 409,
    );
  return commerceJson(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message:
          "Customer accounts are temporarily unavailable. Please try again.",
      },
    },
    503,
  );
}
export function createCustomerHandler(
  db: PrismaClient,
  deliver?: CustomerMail,
) {
  const service = createCustomerService(db, deliver);
  return async (request: Request, path: string[]) => {
    try {
      const token = customerGateway(request),
        route = path.join("/"),
        query = new URL(request.url).searchParams;
      if (request.method === "GET") {
        if (route === "auth/session")
          return commerceJson(await service.session(token));
        if (route === "customer/addresses")
          return commerceJson({ items: await service.addresses(token) });
        if (route === "customer/orders")
          return commerceJson(await service.orders(token, query.get("page")));
      }
      if (request.method !== "POST")
        throw new DomainError("NOT_FOUND", "Not found.");
      // Gateway derives this keyed identity from the TCP peer; never accept browser-forwarded IPs.
      const client = request.headers.get("x-customer-client") ?? "unknown";
      if (!/^[a-f0-9]{64}$/.test(client))
        throw new DomainError("FORBIDDEN", "Invalid gateway request.");
      await customerRateLimit(db, `customer-ip:${client}`, 60);
      if (route.startsWith("auth/"))
        await customerRateLimit(
          db,
          `${route}:${client}`,
          route === "auth/register" ? 10 : 20,
        );
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new DomainError("INVALID_REQUEST", "JSON is required.");
      const input = JSON.parse(await boundedBody(request, 16384));
      if (route === "auth/register" || route === "auth/login") {
        const result =
          route === "auth/register"
            ? await service.register(input, token)
            : await service.login(input, token);
        const response = commerceJson({
          authenticated: true,
          customer: result.customer,
          emailDeliveryAvailable: !!deliver,
        });
        // Server-to-server transport only. Gateway turns this into its host-only HttpOnly cookie.
        response.headers.set("x-customer-session", result.token);
        return response;
      }
      if (route === "auth/logout") {
        z.object({}).strict().parse(input);
        await service.logout(token);
        const response = commerceJson({
          authenticated: false,
          customer: null,
          emailDeliveryAvailable: !!deliver,
        });
        response.headers.set("x-customer-session", "clear");
        return response;
      }
      if (route === "auth/forgot-password")
        return commerceJson(await service.requestReset(input));
      if (route === "auth/reset-password") {
        const response = commerceJson(await service.redeem("RESET", input));
        response.headers.set("x-customer-session", "clear");
        return response;
      }
      if (route === "auth/verify-email")
        return commerceJson(await service.redeem("VERIFY", input));
      if (route === "auth/request-verification") {
        z.object({}).strict().parse(input);
        return commerceJson(await service.requestVerification(token));
      }
      if (route === "customer/profile")
        return commerceJson(await service.profile(token, input));
      if (route === "customer/addresses")
        return commerceJson(await service.saveAddress(token, input));
      if (/^customer\/addresses\/[0-9a-f-]{36}\/delete$/i.test(route)) {
        z.object({}).strict().parse(input);
        return commerceJson(await service.deleteAddress(token, path[2]));
      }
      throw new DomainError("NOT_FOUND", "Not found.");
    } catch (e) {
      return customerError(e);
    }
  };
}
