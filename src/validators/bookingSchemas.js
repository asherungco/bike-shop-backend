import { z } from "zod";

export const bookingHoldSchema = z.object({
  slot_id: z.string().uuid(),
  bike_id: z.string().uuid().nullable().optional()
});

export const bookingStatusSchema = z.object({
  status: z.enum(["confirmed", "cancelled"])
});
