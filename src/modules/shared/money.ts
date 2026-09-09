/**
 * Amounts are integers in the currency's minor units. Formatting uses each currency's own
 * exponent, so JPY 1650 reads as ¥1,650 while EUR 2500 reads as €25.00. Never convert
 * between currencies: an MSRP, a purchase cost and a selling price stay in what was recorded.
 */
export function formatMoney(
  amount: number | bigint,
  currency: string,
  locale = "en-GB",
) {
  try {
    // narrowSymbol keeps ¥1,650 rather than the locale's JP¥ disambiguation.
    const format = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    });
    const exponent = format.resolvedOptions().maximumFractionDigits ?? 2;
    if (typeof amount === "bigint") {
      const factor = 10n ** BigInt(exponent);
      const absolute = amount < 0n ? -amount : amount;
      const parts = format
        .formatToParts(absolute / factor)
        .map((part) =>
          part.type === "fraction"
            ? (absolute % factor).toString().padStart(exponent, "0")
            : part.value,
        )
        .join("");
      return amount < 0n ? `-${parts}` : parts;
    }
    return format.format(amount / 10 ** exponent);
  } catch {
    // An unknown code is still shown truthfully rather than silently dropped.
    return `${amount.toLocaleString(locale)} ${currency}`;
  }
}
export function formatOptionalMoney(
  amount: number | null,
  currency: string | null,
  locale = "en-GB",
) {
  return amount === null || currency === null
    ? null
    : formatMoney(amount, currency, locale);
}

/** Decimal form input to exact integer minor units; never rounds or converts currency. */
export function parseMoneyInput(value: string, currency: string): number {
  const digits =
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > digits)
    throw new Error(
      `Enter a nonnegative ${currency} price with at most ${digits} decimal places.`,
    );
  const amount =
    Number(match[1]) * 10 ** digits +
    Number((match[2] ?? "").padEnd(digits, "0"));
  if (!Number.isSafeInteger(amount) || amount > 2_147_483_647)
    throw new Error("Price is too large.");
  return amount;
}
export function moneyInputValue(amount: number | bigint, currency: string) {
  const digits =
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  if (typeof amount === "bigint") {
    const factor = 10n ** BigInt(digits),
      absolute = amount < 0n ? -amount : amount;
    return `${amount < 0n ? "-" : ""}${absolute / factor}${digits ? `.${String(absolute % factor).padStart(digits, "0")}` : ""}`;
  }
  return (amount / 10 ** digits).toFixed(digits);
}

/** Currency exponent used by exact cross-currency costing arithmetic. */
export function currencyMinorDigits(currency: string) {
  return (
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2
  );
}
