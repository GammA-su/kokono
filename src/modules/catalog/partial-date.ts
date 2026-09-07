import { DatePrecision } from "../../generated/prisma/enums";
import { DomainError } from "../shared/errors";

export type PartialDate = { date: Date; precision: DatePrecision };

export function parsePartialDate(input: string): PartialDate {
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(input)) {
    throw new DomainError("INVALID_DATE", "Use YYYY, YYYY-MM, or YYYY-MM-DD.");
  }
  const parts = input.split("-").map(Number);
  const [year, month = 1, day = 1] = parts;
  if (year < 1 || year > 9999) throw new DomainError("INVALID_DATE", "Year must be between 1 and 9999.");
  const date = new Date(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new DomainError("INVALID_DATE", "Invalid calendar date.");
  }
  return { date, precision: parts.length === 1 ? DatePrecision.YEAR : parts.length === 2 ? DatePrecision.MONTH : DatePrecision.DAY };
}

export function formatPartialDate(date: Date | null, precision: DatePrecision | null, locale = "en-GB"): string | null {
  if (!date && !precision) return null;
  if (!date || !precision || Number.isNaN(date.valueOf())) {
    throw new DomainError("INVALID_DATE", "A date and its precision must be provided together.");
  }
  const options: Intl.DateTimeFormatOptions = { year: "numeric", timeZone: "UTC" };
  if (precision !== DatePrecision.YEAR) options.month = "long";
  if (precision === DatePrecision.DAY) options.day = "numeric";
  return new Intl.DateTimeFormat(locale, options).format(date);
}
