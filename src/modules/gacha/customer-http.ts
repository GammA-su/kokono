import { claimGachaReward } from "./fulfillment";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { boundedBody, commerceJson } from "../commerce/http";
import { customerGateway } from "../customers/http";
import { customerRateLimit } from "../customers/service";
import { DomainError } from "../shared/errors";
import { createCustomerGachaService } from "./customer-service";

export function createCustomerGachaHandler(db: PrismaClient) {
  const service = createCustomerGachaService(db);
  return async (request: Request, path: string[]) => {
    try {
      const token = customerGateway(request),
        route = path.join("/"),
        query = new URL(request.url).searchParams;
      if (request.method === "GET") {
        if (/^banners\/[^/]+\/eligibility$/.test(route))
          return commerceJson(await service.eligibility(token, path[1]));
        if (/^pulls\/[^/]+$/.test(route))
          return commerceJson(await service.recover(token, path[1]));
        if (/^requests\/[^/]+$/.test(route))
          return commerceJson(await service.recover(token, path[1], true));
        if (/^rewards\/[^/]+$/.test(route))
          return commerceJson(await service.reward(token, path[1]));
        if (route === "pulls" || route === "rewards")
          return commerceJson(
            await service.history(
              token,
              query.get("page"),
              query.get("status"),
            ),
          );
      }
      if (request.method === "POST" && /^rewards\/[^/]+\/claim$/.test(route)) {
        const client = request.headers.get("x-customer-client") ?? "";
        if (!/^[a-f0-9]{64}$/.test(client))
          throw new DomainError("FORBIDDEN", "Invalid gateway request.");
        await customerRateLimit(db, `gacha-claim-ip:${client}`, 60, 60);
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new DomainError("INVALID_REQUEST", "JSON is required.");
        const raw = z
          .object({ operationKey: z.uuid(), address: z.unknown() })
          .strict()
          .parse(JSON.parse(await boundedBody(request, 4096)));
        return commerceJson(
          await claimGachaReward(db, token, { ...raw, rewardId: path[1] }),
        );
      }
      if (request.method === "POST" && /^banners\/[^/]+\/pulls$/.test(route)) {
        const client = request.headers.get("x-customer-client") ?? "";
        if (!/^[a-f0-9]{64}$/.test(client))
          throw new DomainError("FORBIDDEN", "Invalid gateway request.");
        await customerRateLimit(db, `gacha-ip:${client}`, 60, 60);
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new DomainError("INVALID_REQUEST", "JSON is required.");
        const input = z
          .object({
            configurationId: z.uuid(),
            requestKey: z.uuid(),
            count: z.literal(1),
          })
          .strict()
          .parse(JSON.parse(await boundedBody(request, 4096)));
        return commerceJson(
          await service.pull(token, { ...input, bannerId: path[1] }),
        );
      }
      throw new DomainError("NOT_FOUND", "Gacha endpoint not found.");
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return commerceJson(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Check the submitted gacha request fields.",
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
                  : 409,
        );
      return commerceJson(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message:
              "Unable to confirm this request. Recover or retry the same request; do not start another pull.",
          },
        },
        503,
      );
    }
  };
}
