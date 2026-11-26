import { z } from "zod";

export const recommendationSchema = z.object({
  needs: z.string().trim().min(5).max(1000),
  budget_centavos: z.number().int().positive().optional(),
  preferred_kind: z.string().trim().min(1).max(50).optional()
}).strict();
