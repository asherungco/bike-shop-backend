import { z } from "zod";

const uuid = z.string().uuid();
export const posSaleSchema = z.object({
  items: z.array(z.object({ product_id: uuid, quantity: z.number().int().min(1).max(100) })).min(1).max(50),
  customer_id: uuid,
  fulfillment_type: z.enum(["store_pickup", "delivery"]).default("store_pickup"),
  notes: z.string().max(500).optional().default("")
});
export const stockAdjustmentSchema = z.object({
  product_id: uuid,
  new_qty: z.number().int().min(0),
  reason: z.string().trim().min(3).max(250)
});
export const orderStatusSchema = z.object({ status: z.enum(["processing", "ready", "completed", "cancelled"]) });
