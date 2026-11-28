
import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

const fail = (error, fallback) => {
  if (!error) return;

  console.error("SUPABASE ERROR:", error);

  const message = String(error.message || "");

  if (message.includes("INSUFFICIENT_STOCK")) {
    throw new AppError(409, "Insufficient stock for one or more items.");
  }

  if (message.includes("PRODUCT_NOT_FOUND")) {
    throw new AppError(404, "A selected product was not found or is inactive.");
  }

  if (message.includes("INVALID_ORDER_TRANSITION")) {
    throw new AppError(409, "That order status change is not allowed.");
  }

  throw new AppError(400, fallback);
};

export async function createPosSale(req, res) {
  const { data, error } = await supabase.rpc("create_pos_sale", {
    p_actor_id: req.user.id,
    p_customer_id: req.validatedBody.customer_id ?? null,
    p_items: req.validatedBody.items,
    p_fulfillment_type: req.validatedBody.fulfillment_type,
    p_notes: req.validatedBody.notes
  });

  if (error) {
    console.error("POS RPC ERROR:", error);
    fail(error, "Could not complete POS sale.");
  }

  res.status(201).json({
    success: true,
    message: "POS sale completed.",
    data
  });
}

export async function listOrders(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "20", 10)));

  let query = supabase
    .from("orders")
    .select("*,order_items(id,product_id,product_name,unit_price_centavos,quantity),payments(id,provider,status,amount_centavos,currency),users!orders_user_id_fkey(id,full_name,email)", {
      count: "exact"
    })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (req.query.status) query = query.eq("status", req.query.status);
  if (req.user.role === "customer") query = query.eq("user_id", req.user.id);

  const { data, error, count } = await query;

  if (error) {
    console.error("LIST ORDERS ERROR:", error);
    throw new AppError(500, "Could not retrieve orders.");
  }

  res.json({
    success: true,
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      pages: Math.ceil((count ?? 0) / limit)
    }
  });
}

export async function updateOrderStatus(req, res) {
  const { data, error } = await supabase.rpc("set_order_status", {
    p_order_id: req.params.id,
    p_actor_id: req.user.id,
    p_actor_role: req.user.role,
    p_new_status: req.validatedBody.status
  });

  if (error) {
    console.error("UPDATE ORDER STATUS ERROR:", error);
    fail(error, "Could not update order status.");
  }

  if (!data) throw new AppError(404, "Order not found.");

  res.json({ success: true, data });
}

export async function listInventory(req, res) {
  const { data, error } = await supabase
    .from("products")
    .select("id,sku,name,kind,stock_qty,price_centavos,is_active,category_id")
    .order("name", { ascending: true });

  if (error) {
    console.error("LIST INVENTORY ERROR:", error);
    throw new AppError(500, "Could not retrieve inventory.");
  }

  res.json({
    success: true,
    data,
    summary: {
      products: data.length,
      low_stock: data.filter(p => p.stock_qty <= 5 && p.is_active).length,
      out_of_stock: data.filter(p => p.stock_qty === 0 && p.is_active).length
    }
  });
}

export async function adjustStock(req, res) {
  const { data, error } = await supabase.rpc("adjust_product_stock", {
    p_product_id: req.validatedBody.product_id,
    p_new_qty: req.validatedBody.new_qty,
    p_reason: req.validatedBody.reason,
    p_actor_id: req.user.id
  });

  if (error) {
    console.error("ADJUST STOCK ERROR:", error);
    throw new AppError(400, "Stock adjustment failed. Check the product and adjustment details.");
  }

  res.json({
    success: true,
    message: "Stock updated and adjustment recorded.",
    data
  });
}

export async function listCustomers(_req, res) {
  const { data, error } = await supabase
    .from("users")
    .select("id,full_name,email")
    .eq("role", "customer")
    .order("full_name", { ascending: true });

  if (error) {
    console.error("LIST POS CUSTOMERS ERROR:", error);
    throw new AppError(500, "Could not retrieve customers for the POS sale.");
  }

  res.json({ success: true, data });
}

export async function markOrderRefundCompleted(req, res) {
  const { data, error } = await supabase.rpc("mark_order_refund_completed", {
    p_payment_id: req.params.paymentId,
    p_actor_id: req.user.id,
    p_actor_role: req.user.role
  });

  if (error) {
    console.error("MARK ORDER REFUND COMPLETED ERROR:", error);
    if (String(error.message || "").includes("REFUND_NOT_PENDING")) {
      throw new AppError(409, "This payment does not have a pending refund.");
    }
    throw new AppError(400, "Could not mark the refund as completed.");
  }

  res.json({ success: true, message: "Refund marked as completed.", data });
}
