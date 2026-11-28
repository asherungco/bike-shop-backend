import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

async function getOrCreateCart(userId) {
  const { data, error } = await supabase
    .from("carts")
    .upsert({ user_id: userId }, { onConflict: "user_id" })
    .select("id")
    .single();

  if (error) {
    console.error("GET OR CREATE CART ERROR:", error);
    throw new AppError(500, "Could not open your cart.");
  }
  return data.id;
}

async function loadCart(userId) {
  const { data: cart, error: cartError } = await supabase
    .from("carts")
    .select("id,user_id,updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (cartError) {
    console.error("LOAD CART ERROR:", cartError);
    throw new AppError(500, "Could not retrieve your cart.");
  }

  if (!cart) {
    return { id: null, items: [], item_count: 0, subtotal_centavos: 0, currency: "PHP" };
  }

  const { data: items, error: itemsError } = await supabase
    .from("cart_items")
    .select("id,product_id,quantity,products(id,sku,name,kind,price_centavos,stock_qty,is_active,image_url)")
    .eq("cart_id", cart.id)
    .order("id", { ascending: true });

  if (itemsError) {
    console.error("LOAD CART ITEMS ERROR:", itemsError);
    throw new AppError(500, "Could not retrieve cart items.");
  }

  const safeItems = (items || []).map((item) => ({
    id: item.id,
    product_id: item.product_id,
    quantity: item.quantity,
    product: item.products,
    line_total_centavos: (item.products?.price_centavos || 0) * item.quantity
  }));

  return {
    id: cart.id,
    items: safeItems,
    item_count: safeItems.reduce((sum, item) => sum + item.quantity, 0),
    subtotal_centavos: safeItems.reduce((sum, item) => sum + item.line_total_centavos, 0),
    currency: "PHP",
    updated_at: cart.updated_at
  };
}

export async function getCart(req, res) {
  res.json({ success: true, data: await loadCart(req.user.id) });
}

export async function addCartItem(req, res) {
  const { product_id, quantity } = req.validatedBody;
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id,stock_qty,is_active")
    .eq("id", product_id)
    .maybeSingle();

  if (productError) {
    console.error("CHECK CART PRODUCT ERROR:", productError);
    throw new AppError(500, "Could not check product availability.");
  }
  if (!product || !product.is_active) throw new AppError(404, "Product not found or inactive.");
  if (product.stock_qty < quantity) throw new AppError(409, "Not enough stock for that quantity.");

  const cartId = await getOrCreateCart(req.user.id);
  const { data: existing, error: existingError } = await supabase
    .from("cart_items")
    .select("id,quantity")
    .eq("cart_id", cartId)
    .eq("product_id", product_id)
    .maybeSingle();

  if (existingError) {
    console.error("CHECK EXISTING CART ITEM ERROR:", existingError);
    throw new AppError(500, "Could not update your cart.");
  }

  const nextQuantity = (existing?.quantity || 0) + quantity;
  if (nextQuantity > product.stock_qty) {
    throw new AppError(409, "Cart quantity exceeds available stock.");
  }

  const query = existing
    ? supabase.from("cart_items").update({ quantity: nextQuantity }).eq("id", existing.id)
    : supabase.from("cart_items").insert({ cart_id: cartId, product_id, quantity: nextQuantity });

  const { error } = await query;
  if (error) {
    console.error("ADD CART ITEM ERROR:", error);
    throw new AppError(400, "Could not add this product to your cart.");
  }

  await supabase.from("carts").update({ updated_at: new Date().toISOString() }).eq("id", cartId);
  res.status(201).json({ success: true, message: "Product added to cart.", data: await loadCart(req.user.id) });
}

export async function updateCartItem(req, res) {
  const { quantity } = req.validatedBody;
  const { data: cart, error: cartError } = await supabase
    .from("carts").select("id").eq("user_id", req.user.id).maybeSingle();

  if (cartError) throw new AppError(500, "Could not retrieve your cart.");
  if (!cart) throw new AppError(404, "Cart item not found.");

  const { data: item, error: itemError } = await supabase
    .from("cart_items").select("id,product_id,cart_id")
    .eq("id", req.params.itemId).eq("cart_id", cart.id).maybeSingle();

  if (itemError) throw new AppError(500, "Could not retrieve cart item.");
  if (!item) throw new AppError(404, "Cart item not found.");

  const { data: product, error: productError } = await supabase
    .from("products").select("stock_qty,is_active").eq("id", item.product_id).maybeSingle();

  if (productError) throw new AppError(500, "Could not check product stock.");
  if (!product || !product.is_active) throw new AppError(404, "Product is no longer available.");
  if (quantity > product.stock_qty) throw new AppError(409, "Requested quantity exceeds available stock.");

  const { error } = await supabase.from("cart_items").update({ quantity }).eq("id", item.id);
  if (error) {
    console.error("UPDATE CART ITEM ERROR:", error);
    throw new AppError(400, "Could not update cart item.");
  }

  await supabase.from("carts").update({ updated_at: new Date().toISOString() }).eq("id", cart.id);
  res.json({ success: true, message: "Cart updated.", data: await loadCart(req.user.id) });
}

export async function removeCartItem(req, res) {
  const { data: cart, error: cartError } = await supabase
    .from("carts").select("id").eq("user_id", req.user.id).maybeSingle();

  if (cartError) throw new AppError(500, "Could not retrieve your cart.");
  if (!cart) throw new AppError(404, "Cart item not found.");

  const { data: item, error: itemError } = await supabase
    .from("cart_items").select("id")
    .eq("id", req.params.itemId).eq("cart_id", cart.id).maybeSingle();

  if (itemError) throw new AppError(500, "Could not retrieve cart item.");
  if (!item) throw new AppError(404, "Cart item not found.");

  const { error } = await supabase.from("cart_items").delete().eq("id", item.id);
  if (error) {
    console.error("REMOVE CART ITEM ERROR:", error);
    throw new AppError(400, "Could not remove cart item.");
  }

  await supabase.from("carts").update({ updated_at: new Date().toISOString() }).eq("id", cart.id);
  res.json({ success: true, message: "Product removed from cart.", data: await loadCart(req.user.id) });
}

export async function clearCart(req, res) {
  const { data: cart, error: cartError } = await supabase
    .from("carts").select("id").eq("user_id", req.user.id).maybeSingle();

  if (cartError) throw new AppError(500, "Could not retrieve your cart.");
  if (cart) {
    const { error } = await supabase.from("cart_items").delete().eq("cart_id", cart.id);
    if (error) {
      console.error("CLEAR CART ERROR:", error);
      throw new AppError(400, "Could not clear your cart.");
    }
    await supabase.from("carts").update({ updated_at: new Date().toISOString() }).eq("id", cart.id);
  }

  res.json({ success: true, message: "Cart cleared.", data: await loadCart(req.user.id) });
}
