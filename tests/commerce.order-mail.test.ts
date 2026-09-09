import { describe, expect, it } from "vitest";
import { notifyOrder } from "../src/modules/commerce/notifications";
import { renderCustomerEmail } from "../src/modules/customer-email/templates";
import { customerEmailIdempotencyKey } from "../src/modules/customer-email/resend";
import type { CustomerMailMessage } from "../src/modules/customers/service";

const brand = {
  siteName: "Kokoni",
  siteOrigin: "https://shop.test",
  replyTo: "support@shop.test",
};
const order = {
  number: "KO-2026-0001",
  totalAmount: 8990,
  currency: "EUR",
  contact: { email: "buyer@example.test", phone: "" },
};

describe("transactional order mail", () => {
  it("sends a confirmation to the address captured on the order", async () => {
    const sent: CustomerMailMessage[] = [];
    await notifyOrder(async (m) => void sent.push(m), "ORDER_CONFIRMED", order);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      email: "buyer@example.test",
      purpose: "ORDER_CONFIRMED",
      order: { number: "KO-2026-0001", totalAmount: 8990, currency: "EUR" },
    });
  });

  it("includes carrier and tracking only on the shipped message", async () => {
    const sent: CustomerMailMessage[] = [];
    const notify = async (m: CustomerMailMessage) => void sent.push(m);
    await notifyOrder(notify, "ORDER_SHIPPED", order, {
      carrier: "Colissimo",
      trackingNumber: "6A11111111111",
    });
    const shipped = renderCustomerEmail(brand, sent[0]);
    expect(shipped.text).toContain("Colissimo");
    expect(shipped.text).toContain("6A11111111111");
    expect(shipped.subject).toContain("has shipped");

    const confirmation = renderCustomerEmail(brand, {
      email: order.contact.email,
      purpose: "ORDER_CONFIRMED",
      order: { number: order.number, totalAmount: 8990, currency: "EUR" },
    });
    expect(confirmation.text).not.toContain("Colissimo");
    expect(confirmation.subject).toContain("confirmed");
  });

  /**
   * The payment is already taken and the stock already consumed by the time these run.
   * Propagating a provider failure would surface an error, or roll back a caller, for work
   * that actually succeeded.
   */
  it("never propagates a mail provider failure into the commerce path", async () => {
    await expect(
      notifyOrder(
        async () => {
          throw new Error("provider unreachable");
        },
        "ORDER_CONFIRMED",
        order,
      ),
    ).resolves.toBeUndefined();
  });

  it("sends nothing when no provider is configured or the contact is unusable", async () => {
    const sent: CustomerMailMessage[] = [];
    const notify = async (m: CustomerMailMessage) => void sent.push(m);
    await notifyOrder(undefined, "ORDER_CONFIRMED", order);
    await notifyOrder(notify, "ORDER_CONFIRMED", { ...order, contact: {} });
    await notifyOrder(notify, "ORDER_CONFIRMED", { ...order, contact: null });
    expect(sent).toEqual([]);
  });

  it("keys retries on the order number so a replayed webhook cannot mail twice", () => {
    const message = {
      email: order.contact.email,
      purpose: "ORDER_CONFIRMED" as const,
      order: { number: order.number, totalAmount: 8990, currency: "EUR" },
    };
    const key = customerEmailIdempotencyKey(message);
    expect(key).toMatch(/^customer-order-confirmed:[a-f0-9]{64}$/);
    expect(customerEmailIdempotencyKey(message)).toBe(key);
    // A different purpose for the same order must not collapse into one message.
    expect(
      customerEmailIdempotencyKey({ ...message, purpose: "ORDER_SHIPPED" }),
    ).not.toBe(key);
  });

  it("refuses order values it cannot render safely", () => {
    for (const bad of [
      { number: "bad number!", totalAmount: 100, currency: "EUR" },
      { number: "KO-1", totalAmount: -1, currency: "EUR" },
      { number: "KO-1", totalAmount: 100, currency: "euro" },
    ])
      expect(() =>
        renderCustomerEmail(brand, {
          email: order.contact.email,
          purpose: "ORDER_CONFIRMED",
          order: bad,
        }),
      ).toThrow();
  });
});
