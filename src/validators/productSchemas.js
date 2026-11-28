
import { z } from "zod";

const productFields = {
  category_id: z.number().int().positive().nullable().optional(),
  sku: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(5000),
  kind: z.enum(["bike", "part", "accessory"]),
  price_centavos: z.number().int().nonnegative(),
  stock_qty: z.number().int().nonnegative(),
  requires_assembly: z.boolean(),
  is_active: z.boolean(),
  image_url: z.string().url().nullable().optional()
};

export const createProductSchema = z.object({
  ...productFields,
  description: z.string().max(5000).default(""),
  stock_qty: z.number().int().nonnegative().default(0),
  requires_assembly: z.boolean().default(false),
  is_active: z.boolean().default(true)
});

export const updateProductSchema = z.object(productFields).partial();
