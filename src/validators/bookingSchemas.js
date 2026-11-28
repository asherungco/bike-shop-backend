import { z } from "zod";

export const bookingSchema = z.object({
  slot_id: z.string().uuid(),
  bike_id: z.string().uuid().nullable().optional(),
  bike_description: z.string().trim().min(3).max(180),
  problem_description: z.string().trim().min(10).max(1000)
});

export const bookingStatusSchema = z.object({
  status: z.enum([
    "confirmed",
    "in_repair",
    "ready_for_pickup",
    "completed",
    "cancelled"
  ]),
  final_cost_centavos: z.number().int().min(0).optional()
});

export const bookingPaymentSchema = z.object({
  payment_status: z.literal("paid")
});

// Kept for compatibility with older integrations; the customer flow now uses bookingSchema.
export const bookingHoldSchema = z.object({
  slot_id: z.string().uuid(),
  bike_id: z.string().uuid().nullable().optional()
});
