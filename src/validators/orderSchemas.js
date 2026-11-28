import { z } from "zod";

const uuid = z.string().uuid();

export const addCartItemSchema = z.object({
  product_id: uuid,
  quantity: z.number().int().min(1).max(100)
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(100)
});

export const checkoutSchema = z.object({
  fulfillment_type: z.enum(["delivery", "store_pickup"]).default("delivery"),
  shipping_name: z.string().trim().min(2).max(120).optional(),
  shipping_phone: z.string().trim().min(7).max(30).optional(),
  shipping_address: z.string().trim().min(5).max(300).optional(),
  shipping_city: z.string().trim().min(2).max(100).optional(),
  shipping_fee_centavos: z.number().int().min(0).default(0),
  idempotency_key: z.string().trim().min(8).max(120).optional()
}).superRefine((value, ctx) => {
  if (value.fulfillment_type === "delivery") {
    for (const key of ["shipping_name", "shipping_phone", "shipping_address", "shipping_city"]) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required for delivery.`
        });
      }
    }
  }
  if (value.fulfillment_type === "store_pickup" && value.shipping_fee_centavos !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shipping_fee_centavos"],
      message: "Shipping fee must be zero for store pickup."
    });
  }
});
