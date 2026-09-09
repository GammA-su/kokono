import type {
  CustomerMailMessage,
  CustomerOrderSummary,
} from "../customers/service";
import type { CustomerEmailConfig } from "./config";
type Message = CustomerMailMessage;
type Branding = Pick<
  CustomerEmailConfig,
  "siteName" | "siteOrigin" | "replyTo"
>;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

/** One branded shell for every transactional message, so styling never diverges per purpose. */
function shell(
  brand: Branding,
  title: string,
  intro: string,
  body: string,
  footer: string,
  action?: { href: string; label: string },
) {
  const support = brand.replyTo ? `Need help? Contact ${brand.replyTo}.` : "";
  const button = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#4936c8" style="border-radius:8px;"><a href="${escapeHtml(action.href)}" style="display:inline-block;padding:16px 22px;border:1px solid #4936c8;border-radius:8px;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;">${escapeHtml(action.label)}</a></td></tr></table>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:0;background:#f2f4fa;color:#182039;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dce0ed;border-radius:16px;">
<tr><td style="padding:28px 28px 20px;background:#10152e;color:#a5dfff;border-radius:16px 16px 0 0;font-size:24px;font-weight:bold;letter-spacing:2px;">${escapeHtml(brand.siteName)}</td></tr>
<tr><td style="padding:28px;"><h1 style="margin:0 0 20px;font-size:26px;line-height:1.25;color:#182039;">${escapeHtml(title)}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(intro)}</p>
${body}${button}
<p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #dce0ed;font-size:14px;line-height:1.6;color:#4d5670;">${escapeHtml(footer)}</p>
${support ? `<p style="font-size:14px;line-height:1.6;">${escapeHtml(support)}</p>` : ""}</td></tr></table></td></tr></table></body></html>`;
  return { html, support };
}
/** Minor-unit integer amounts are never floated; the currency is shown beside the value. */
function amount(value: number, currency: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid order amount for customer email.");
  return `${(value / 100).toFixed(2)} ${currency}`;
}
function orderTemplate(
  brand: Branding,
  order: CustomerOrderSummary,
  shipped: boolean,
) {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(order.number))
    throw new Error("Invalid order number for customer email.");
  if (!/^[A-Z]{3}$/.test(order.currency))
    throw new Error("Invalid order currency for customer email.");
  const title = shipped
    ? `Your order ${order.number} has shipped`
    : `Order ${order.number} confirmed`;
  const intro = shipped
    ? `Your ${brand.siteName} order is on its way.`
    : `Thank you — we have received payment for your ${brand.siteName} order.`;
  const rows: [string, string][] = [
    ["Order", order.number],
    ["Total paid", amount(order.totalAmount, order.currency)],
    ...(shipped && order.carrier ? ([["Carrier", order.carrier]] as [string, string][]) : []),
    ...(shipped && order.trackingNumber
      ? ([["Tracking number", order.trackingNumber]] as [string, string][])
      : []),
  ];
  const body = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px;font-size:15px;line-height:1.6;">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:#4d5670;">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${escapeHtml(value)}</td></tr>`,
    )
    .join("")}</table>`;
  const footer = shipped
    ? "Tracking can take a little time to appear with the carrier. This message is about your order only."
    : "We will email you again when your order is dispatched. This message is about your order only.";
  const { html, support } = shell(brand, title, intro, body, footer, {
    href: new URL("/account/orders", brand.siteOrigin).href,
    label: "View your orders",
  });
  const lines = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  const link = new URL("/account/orders", brand.siteOrigin).href;
  const text = [brand.siteName, title, intro, lines, link, footer, support]
    .filter(Boolean)
    .join("\n\n");
  return { subject: `${brand.siteName} — ${title}`, html, text };
}
export const CustomerOrderConfirmed = (
  brand: Branding,
  order: CustomerOrderSummary,
) => orderTemplate(brand, order, false);
export const CustomerOrderShipped = (
  brand: Branding,
  order: CustomerOrderSummary,
) => orderTemplate(brand, order, true);

function template(brand: Branding, token: string, reset: boolean) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Invalid customer email token.");
  const url = new URL(
    reset ? "/reset-password" : "/verify-email",
    brand.siteOrigin,
  );
  url.hash = new URLSearchParams({ token }).toString();
  const title = reset ? "Reset your password" : "Verify your email address";
  const intro = reset
    ? `We received a request to reset your ${brand.siteName} account password.`
    : `Confirm this email address for your ${brand.siteName} account.`;
  const expiry = reset
    ? "This link expires in one hour and can be used only once."
    : "This link expires in 24 hours and can be used only once.";
  const security = reset
    ? "If you did not request this, ignore this email. Your password will remain unchanged. Never share this link."
    : "If you did not create an account or request verification, ignore this email. Never share this link.";
  const support = brand.replyTo ? `Need help? Contact ${brand.replyTo}.` : "";
  const text = `${brand.siteName}\n\n${title}\n\n${intro}\n\n${url.href}\n\n${expiry}\n\n${security}${support ? `\n\n${support}` : ""}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:0;background:#f2f4fa;color:#182039;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dce0ed;border-radius:16px;">
<tr><td style="padding:28px 28px 20px;background:#10152e;color:#a5dfff;border-radius:16px 16px 0 0;font-size:24px;font-weight:bold;letter-spacing:2px;">${escapeHtml(brand.siteName)}</td></tr>
<tr><td style="padding:28px;"><h1 style="margin:0 0 20px;font-size:26px;line-height:1.25;color:#182039;">${escapeHtml(title)}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#4936c8" style="border-radius:8px;"><a href="${escapeHtml(url.href)}" style="display:inline-block;padding:16px 22px;border:1px solid #4936c8;border-radius:8px;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;">${escapeHtml(title)}</a></td></tr></table>
<p style="margin:24px 0 16px;font-size:14px;line-height:1.6;">${escapeHtml(expiry)}</p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.6;">If the button does not work, copy this link into your browser:</p>
<p style="margin:0 0 24px;font-size:12px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere;"><a href="${escapeHtml(url.href)}" style="color:#4936c8;">${escapeHtml(url.href)}</a></p>
<p style="margin:0;padding-top:20px;border-top:1px solid #dce0ed;font-size:14px;line-height:1.6;color:#4d5670;">${escapeHtml(security)}</p>
${support ? `<p style="font-size:14px;line-height:1.6;">${escapeHtml(support)}</p>` : ""}</td></tr></table></td></tr></table></body></html>`;
  return { subject: `${brand.siteName} — ${title}`, html, text };
}
export const CustomerEmailVerification = (brand: Branding, token: string) =>
  template(brand, token, false);
export const CustomerPasswordReset = (brand: Branding, token: string) =>
  template(brand, token, true);
export function renderCustomerEmail(brand: Branding, message: Message) {
  if (message.purpose === "RESET")
    return CustomerPasswordReset(brand, message.token);
  if (message.purpose === "VERIFY")
    return CustomerEmailVerification(brand, message.token);
  if (message.purpose === "ORDER_CONFIRMED")
    return CustomerOrderConfirmed(brand, message.order);
  if (message.purpose === "ORDER_SHIPPED")
    return CustomerOrderShipped(brand, message.order);
  throw new Error("Invalid customer email purpose.");
}
