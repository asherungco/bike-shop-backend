import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

function handleCheckoutError(error) {
  console.error("CHECKOUT RPC ERROR:", error);
  const message = String(error?.message || "");

  if (message.includes("CART_EMPTY")) throw new AppError(400, "Your cart is empty.");
  if (message.includes("INSUFFICIENT_STOCK")) throw new AppError(409, "One or more products no longer have enough stock.");
  if (message.includes("PRODUCT_UNAVAILABLE")) throw new AppError(409, "One or more products are no longer available.");
  if (message.includes("SHIPPING_DETAILS_REQUIRED")) throw new AppError(400, "Name, phone, address, and city are required for delivery.");
  if (message.includes("INVALID_FULFILLMENT") || message.includes("INVALID_SHIPPING_FEE") || message.includes("PICKUP_SHIPPING_FEE_MUST_BE_ZERO")) {
    throw new AppError(400, "Invalid fulfillment or shipping details.");
  }
  if (message.includes("CUSTOMER_ONLY")) throw new AppError(403, "Only customer accounts can check out.");
  throw new AppError(400, "Could not create your order. Please review your checkout details.");
}

export async function checkout(req, res) {
  const body = req.validatedBody;
  const { data, error } = await supabase.rpc("create_online_order", {
    p_user_id: req.user.id,
    p_fulfillment_type: body.fulfillment_type,
    p_shipping_name: body.shipping_name ?? null,
    p_shipping_phone: body.shipping_phone ?? null,
    p_shipping_address: body.shipping_address ?? null,
    p_shipping_city: body.shipping_city ?? null,
    p_shipping_fee_centavos: body.shipping_fee_centavos,
    p_idempotency_key: body.idempotency_key ?? null
  });

  if (error) handleCheckoutError(error);

  res.status(data?.reused ? 200 : 201).json({
    success: true,
    message: data?.reused ? "Existing checkout order returned." : "Order created. Continue to payment.",
    data
  });
}

export async function listCustomerOrders(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "20", 10)));
  let query = supabase
    .from("orders")
    .select("*,order_items(id,product_id,product_name,unit_price_centavos,quantity),payments(id,provider,status,amount_centavos,currency,checkout_url)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (req.user.role === "customer") query = query.eq("user_id", req.user.id);
  if (req.query.status) query = query.eq("status", req.query.status);

  const { data, error, count } = await query;
  if (error) {
    console.error("LIST CUSTOMER ORDERS ERROR:", error);
    throw new AppError(500, "Could not retrieve orders.");
  }

  res.json({
    success: true,
    data,
    pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) }
  });
}

export async function getOrder(req, res) {
  let query = supabase
    .from("orders")
    .select("*,order_items(id,product_id,product_name,unit_price_centavos,quantity),payments(id,provider,status,amount_centavos,currency,checkout_url),order_status_history(id,from_status,to_status,actor_role,created_at)")
    .eq("id", req.params.id);

  if (req.user.role === "customer") query = query.eq("user_id", req.user.id);

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error("GET ORDER ERROR:", error);
    throw new AppError(500, "Could not retrieve order.");
  }
  if (!data) throw new AppError(404, "Order not found.");

  res.json({ success: true, data });
}
