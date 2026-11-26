import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

export async function listProducts(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "12", 10)));
  const from = (page - 1) * limit;

  let query = supabase.from("products")
    .select("id,category_id,sku,name,description,kind,price_centavos,stock_qty,requires_assembly,is_active,image_url,created_at", { count: "exact" })
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  if (req.query.kind) query = query.eq("kind", req.query.kind);
  if (req.query.category_id) query = query.eq("category_id", Number(req.query.category_id));
  if (req.query.search) query = query.ilike("name", `%${String(req.query.search).replace(/[%_]/g, "")}%`);

  const { data, error, count } = await query;
 if (error) {
  console.error("SUPABASE PRODUCT ERROR:", error);
  throw new AppError(500, "Could not retrieve products.");
}

  res.json({
    success: true,
    data,
    pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) }
  });
}

export async function getProduct(req, res) {
  const { data, error } = await supabase.from("products")
    .select("id,category_id,sku,name,description,kind,price_centavos,stock_qty,requires_assembly,is_active,image_url,created_at")
    .eq("id", req.params.id).eq("is_active", true).maybeSingle();

  if (error) throw new AppError(500, "Could not retrieve product.");
  if (!data) throw new AppError(404, "Product not found.");
  res.json({ success: true, data });
}

export async function createProduct(req, res) {
  const { data, error } = await supabase.from("products")
    .insert(req.validatedBody).select().single();

  if (error) {
    if (error.code === "23505") throw new AppError(409, "SKU already exists.");
    throw new AppError(400, error.message);
  }
  res.status(201).json({ success: true, data });
}

export async function updateProduct(req, res) {
  const { data, error } = await supabase.from("products")
    .update(req.validatedBody).eq("id", req.params.id).select().maybeSingle();

  if (error) throw new AppError(400, error.message);
  if (!data) throw new AppError(404, "Product not found.");
  res.json({ success: true, data });
}

export async function deactivateProduct(req, res) {
  const { data, error } = await supabase.from("products")
    .update({ is_active: false }).eq("id", req.params.id).select("id,name,is_active").maybeSingle();

  if (error) throw new AppError(400, error.message);
  if (!data) throw new AppError(404, "Product not found.");
  res.json({ success: true, message: "Product deactivated.", data });
}
