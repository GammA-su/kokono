/** Isolated fixture helper used only by audit-scale.ts; no HTTP or provider bypass is installed in the app. */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../src/generated/prisma/client";
import { createCommerceService } from "../src/modules/commerce/service";
import { createCustomerService, requireCustomer } from "../src/modules/customers/service";
import { createGachaService } from "../src/modules/gacha/service";
import { createCustomerGachaService, createGachaCustomerAdmin } from "../src/modules/gacha/customer-service";
import { publicGachaOdds } from "../src/modules/gacha/queries";
import { getPublishedListings, getPublicListing, resolvePublicListings } from "../src/modules/publication/queries";
import { applyInventoryOperation, reconcileInventory } from "../src/modules/inventory/operations";

export async function prepareOperationalLoad(db: PrismaClient, actorId: string, locationId: string) {
  process.env.GACHA_DRAWS_ENABLED = "true";
  process.env.GACHA_CUSTOMER_EXECUTION_ENABLED = "true";
  // Pin the verification policy: this fixture measures query cost, not the verification gate,
  // and CUSTOMER_VERIFICATION_POLICY takes precedence over the older boolean. Leaving it to
  // ambient configuration makes the load run depend on the operator's chosen policy.
  process.env.CUSTOMER_REQUIRE_VERIFIED_EMAIL = "false";
  process.env.CUSTOMER_VERIFICATION_POLICY = "off";
  const auth = createCustomerService(db), commerce = createCommerceService(db), gacha = createCustomerGachaService(db);
  const admin = createGachaCustomerAdmin(db, async () => ({ id: actorId }));
  const people: (Awaited<ReturnType<typeof auth.register>> & { email: string; password: string; owner: string })[] = [];
  for (let i = 0; i < 40; i++) {
    const email = `${randomUUID()}@example.test`, password = randomUUID();
    const user = await auth.register({ email, password, displayName: "Synthetic load customer" });
    people.push({ ...user, email, password, owner: (await requireCustomer(db, user.token)).commerceKey });
  }
  const listings = await db.saleListing.findMany({ orderBy: { id: "asc" }, take: 1100, select: { id: true, slug: true, merchandiseItemId: true } });
  const input = (id: string) => ({ lines: [{ listingId: id, quantity: 1 }], contact: { email: "load@example.test" }, shippingAddress: { name: "Load customer", line1: "1 rue Test", city: "Paris", postalCode: "75001", country: "FR" } });
  console.log("Creating 1,000 real synthetic orders/reservations through domain services...");
  for (let i = 0; i < 1000; i++) {
    const person = people[i % people.length];
    const quote = await commerce.quote(person.owner, input(listings[i].id));
    const order = await commerce.checkout(person.owner, { quoteId: quote.id, operationKey: randomUUID(), accepted: true }, person.token);
    if (order.kind !== "order") throw new Error("Fixture quote changed");
    // Respect the real per-customer open-checkout limit; retain cancelled order/reservation history.
    await commerce.cancel(person.owner, order.order.id);
    if (i % 250 === 249) console.log(`Created ${i + 1} fixture orders`);
  }
  const prize = listings[1099];
  await applyInventoryOperation(db, { merchandiseItemId: prize.merchandiseItemId, destinationLocationId: locationId, quantityDelta: 2000, movementType: "PURCHASE", operationKey: randomUUID() }, actorId);
  const banner = await createGachaService(db, async () => ({ id: actorId })).configure({ name: "Isolated load banner", slug: "isolated-load", active: true, terms: "Controlled no-charge test", termsVersion: "test-v1", prizes: [{ merchandiseItemId: prize.merchandiseItemId, displayName: "Load prize", tier: "COMMON", weight: 1, allocation: 2000 }] });
  await admin.enable({ bannerId: banner.id, enabled: true, reason: "Isolated load test" });
  for (const person of people) {
    await admin.authorize({ bannerId: banner.id, customerId: person.customer.id, operationKey: randomUUID(), maxPulls: 100, expiresAt: new Date(Date.now() + 86400000).toISOString(), reason: "Isolated load test" });
    for (let i = 0; i < 10; i++) await gacha.pull(person.token, { bannerId: banner.id, configurationId: banner.configurationId, requestKey: randomUUID(), count: 1 });
  }
  return async () => {
    const samples: { operation: string; ms: number; error?: string }[] = [];
    const tasks: { operation: string; run: () => Promise<unknown> }[] = [];
    for (let i = 0; i < 10; i++) {
      const person = people[i], listing = listings[1000 + i];
      tasks.push(
        { operation: "list", run: () => getPublishedListings(db, { page: i + 1 }) },
        { operation: "detail", run: () => getPublicListing(db, listing.slug) },
        { operation: "cart", run: () => resolvePublicListings(db, { listingIds: [listing.id] }) },
        { operation: "login", run: () => auth.login({ email: person.email, password: person.password }) },
        { operation: "quote-reserve-cancel", run: async () => {
          const quote = await commerce.quote(person.owner, input(listing.id));
          const order = await commerce.checkout(person.owner, { quoteId: quote.id, operationKey: randomUUID(), accepted: true }, person.token);
          if (order.kind !== "order") throw new Error("Quote changed");
          await commerce.cancel(person.owner, order.order.id);
        } },
        { operation: "popular-odds", run: () => publicGachaOdds(db, "isolated-load") },
        { operation: "pull", run: () => gacha.pull(person.token, { bannerId: banner.id, configurationId: banner.configurationId, requestKey: randomUUID(), count: 1 }) },
      );
    }
    let cursor = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++], start = performance.now();
        try { await task.run(); samples.push({ operation: task.operation, ms: Math.round(performance.now() - start) }); }
        catch (error) { samples.push({ operation: task.operation, ms: Math.round(performance.now() - start), error: error instanceof Error ? error.message : "Failed" }); }
      }
    }));
    const mismatches = await reconcileInventory(db, prize.merchandiseItemId);
    return { concurrency: 12, poolSize: 10, initialOrders: 1000, initialReservations: 3000, initialRewards: 400,
      evidenceScope: "Real domain/DB mixed load, no provider calls. HTTP/proxy/TLS capacity is separate.", samples,
      inventoryMismatchCount: mismatches.length };
  };
}
