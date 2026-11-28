import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

async function withAvailableStock(products) {
  const productIds = (products || []).map((product) => product.id);
  if (!productIds.length) return products || [];

  const { data: pendingOrders, error: ordersError } = await supabase
    .from("orders")
    .select("id")
    .eq("sales_channel", "online")
    .eq("status", "pending_payment")
    .gt("expires_at", new Date().toISOString());

  if (ordersError) throw new AppError(500, "Could not calculate available product stock.");

  const orderIds = (pendingOrders || []).map((order) => order.id);
  if (!orderIds.length) {
    return products.map((product) => ({
      ...product,
      physical_stock_qty: product.stock_qty,
      stock_qty: product.stock_qty
    }));
  }

  const { data: reservations, error: reservationsError } = await supabase
    .from("order_items")
    .select("product_id,quantity")
    .in("product_id", productIds)
    .in("order_id", orderIds);

  if (reservationsError) throw new AppError(500, "Could not calculate available product stock.");

  const reservedByProduct = new Map();
  for (const reservation of reservations || []) {
    reservedByProduct.set(
      reservation.product_id,
      (reservedByProduct.get(reservation.product_id) || 0) + Number(reservation.quantity || 0)
    );
  }

  return products.map((product) => {
    const physicalStock = Number(product.stock_qty || 0);
    const reservedStock = reservedByProduct.get(product.id) || 0;
    return {
      ...product,
      physical_stock_qty: physicalStock,
      stock_qty: Math.max(0, physicalStock - reservedStock)
    };
  });
}

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

  const productsWithAvailableStock = await withAvailableStock(data || []);

  res.json({
    success: true,
    data: productsWithAvailableStock,
    pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) }
  });
}

export async function getProduct(req, res) {
  const { data, error } = await supabase.from("products")
    .select("id,category_id,sku,name,description,kind,price_centavos,stock_qty,requires_assembly,is_active,image_url,created_at")
    .eq("id", req.params.id).eq("is_active", true).maybeSingle();

  if (error) throw new AppError(500, "Could not retrieve product.");
  if (!data) throw new AppError(404, "Product not found.");
  const [productWithAvailableStock] = await withAvailableStock([data]);
  res.json({ success: true, data: productWithAvailableStock });
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
