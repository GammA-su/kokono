import type { DatePrecision } from "../../generated/prisma/enums";
export function partialDateInput(
  date: Date | null,
  precision: DatePrecision | null,
) {
  if (!date || !precision) return "";
  return date
    .toISOString()
    .slice(0, precision === "YEAR" ? 4 : precision === "MONTH" ? 7 : 10);
}
