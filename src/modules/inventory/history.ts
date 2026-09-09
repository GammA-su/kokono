import { z } from "zod";
import { MovementType } from "../../generated/prisma/enums";

export const movementFilterSchema = z.object({
  type: z.enum(MovementType).optional().catch(undefined),
  location: z.uuid().optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  page: z.coerce.number().int().positive().max(1_000_000).catch(1),
  size: z.coerce
    .number()
    .refine((value) => [25, 50, 100].includes(value))
    .catch(25),
});
