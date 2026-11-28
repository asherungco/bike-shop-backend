
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

const mayaUrl = (path) =>
  `${env.MAYA_BASE_URL.replace(/\/+$/, "")}${path}`;

const basicAuth = (key) =>
  `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

const clientOrigin = env.CLIENT_ORIGIN
  .split(",")[0]  
  .trim()
  .replace(/\/+$/, "");

async function mayaRequest(path, key, options = {}) {
  const response = await fetch(mayaUrl(path), {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: basicAuth(key),
      ...(options.headers || {})
    }
  });

  const raw = await response.text();

  let data = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      `Maya API returned HTTP ${response.status}`;

    throw new AppError(502, `Maya payment request failed: ${message}`);
  }

  return data;
}

export const createMayaCheckout = async (req, res) => {
  const { orderId } = req.params;

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (orderError) {
    throw new AppError(500, "Could not load your order.");
  }

  if (!order) {
    throw new AppError(404, "Order not found.");
  }

  if (order.sales_channel !== "online") {
    throw new AppError(400, "Only online orders can use Maya Checkout.");
  }

  if (order.status !== "pending_payment") {
    throw new AppError(400, "This order is not waiting for payment.");
  }

  if (
    !order.expires_at ||
    new Date(order.expires_at).getTime() <= Date.now()
  ) {
    throw new AppError(
      400,
      "This order has expired. Please create a new order."
    );
  }

  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select("product_name, unit_price_centavos, quantity")
    .eq("order_id", order.id);

  if (itemsError) {
    throw new AppError(500, "Could not load order items.");
  }

  if (!items || items.length === 0) {
    throw new AppError(400, "This order has no items.");
  }

  const amount = Number(order.total_centavos);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError(400, "Order total is invalid for payment.");
  }

  const payload = {
    totalAmount: {
      value: Number((amount / 100).toFixed(2)),
      currency: "PHP"
    },
    items: items.map((item) => {
      const price = Number(item.unit_price_centavos);
      const quantity = Number(item.quantity);

      if (
        !Number.isSafeInteger(price) ||
        price <= 0 ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        throw new AppError(400, "An order item has invalid pricing.");
      }

      return {
        name: item.product_name,
        quantity,
        code: "BIKE-SHOP-ITEM",
        description: item.product_name,
        amount: {
          value: Number((price / 100).toFixed(2)),
          currency: "PHP"
        },
        totalAmount: {
          value: Number(((price * quantity) / 100).toFixed(2)),
          currency: "PHP"
        }
      };
    }),
    redirectUrl: {
      success: `${clientOrigin}/payment/result?orderId=${encodeURIComponent(order.id)}&status=success`,
      failure: `${clientOrigin}/payment/result?orderId=${encodeURIComponent(order.id)}&status=failure`,
      cancel: `${clientOrigin}/payment/result?orderId=${encodeURIComponent(order.id)}&status=cancelled`
    },
    requestReferenceNumber: order.id
  };

  const maya = await mayaRequest(
    "/checkout/v1/checkouts",
    env.MAYA_PUBLIC_KEY,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );

  const paymentId = maya.checkoutId || maya.id;
  const checkoutUrl = maya.redirectUrl;

  if (!paymentId || !checkoutUrl) {
    throw new AppError(
      502,
      "Maya did not return a checkout ID and checkout URL."
    );
  }

  let parsedCheckoutUrl;

  try {
    parsedCheckoutUrl = new URL(checkoutUrl);
  } catch {
    throw new AppError(502, "Maya returned an invalid checkout URL.");
  }

  const allowedHosts = [
    "payments-web-sandbox.paymaya.com",
    "payments-web-sandbox.maya.ph",
    "payments.maya.ph"
  ];

  if (
    parsedCheckoutUrl.protocol !== "https:" ||
    !allowedHosts.includes(parsedCheckoutUrl.hostname)
  ) {
    throw new AppError(
      502,
      "Maya returned an unexpected checkout URL."
    );
  }

  const { error: insertError } = await supabase
    .from("payments")
    .insert({
      order_id: order.id,
      provider: "maya",
      provider_ref: paymentId,
      checkout_url: checkoutUrl,
      status: "pending",
      amount_centavos: amount,
      currency: "PHP",
      amount_mismatch: false
    });

  if (insertError) {
    throw new AppError(
      500,
      "Maya created the checkout session, but the payment record could not be saved."
    );
  }

  return res.status(201).json({
    success: true,
    message: "Maya checkout session created.",
    data: {
      order_id: order.id,
      payment_id: paymentId,
      checkout_url: checkoutUrl,
      amount_centavos: amount,
      currency: "PHP",
      reused: false
    }
  });
};

export const handleMayaWebhook = async (req, res) => {
  const incoming = req.body || {};
  const paymentId = incoming.id;

  if (!paymentId) {
    return res.status(400).json({
      success: false,
      message: "Missing Maya payment ID."
    });
  }

  let verified;

  try {
    verified = await mayaRequest(
      `/payments/v1/payments/${encodeURIComponent(paymentId)}`,
      env.MAYA_SECRET_KEY,
      { method: "GET" }
    );
  } catch (error) {
    console.error("Maya webhook verification failed:", error.message);
    return res.status(502).json({
      success: false,
      message: "Could not verify Maya payment notification."
    });
  }

  const status = verified.paymentStatus;
  const acceptedStatuses = new Set([
    "PAYMENT_SUCCESS",
    "PAYMENT_FAILED",
    "PAYMENT_EXPIRED",
    "PAYMENT_CANCELLED"
  ]);

  if (!acceptedStatuses.has(status)) {
    return res.status(200).json({
      success: true,
      message: "Maya event received; no order action required.",
      payment_status: status || "unknown"
    });
  }

  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .select("id, order_id, amount_centavos, status")
    .eq("provider", "maya")
    .eq("provider_ref", paymentId)
    .maybeSingle();

  if (paymentError) {
    return res.status(500).json({
      success: false,
      message: "Could not find local payment record."
    });
  }

  if (!payment) {
    return res.status(404).json({
      success: false,
      message: "Payment record not found."
    });
  }

  const referenceMatches = verified.requestReferenceNumber === payment.order_id;
  const verifiedAmount = Math.round(Number(verified.totalAmount?.value) * 100);
  const amountMatches =
    Number.isFinite(verifiedAmount) &&
    verifiedAmount === Number(payment.amount_centavos);

  const eventId = `${paymentId}:${status}`;
  const { error: eventError } = await supabase
    .from("webhook_events")
    .upsert(
      {
        provider: "maya",
        event_id: eventId,
        event_type: status,
        payload: verified
      },
      {
        onConflict: "provider,event_id",
        ignoreDuplicates: true
      }
    );

  if (eventError) {
    return res.status(500).json({
      success: false,
      message: "Could not record Maya webhook event."
    });
  }

  if (!referenceMatches || !amountMatches) {
    await supabase
      .from("payments")
      .update({ amount_mismatch: true })
      .eq("id", payment.id);

    console.error("Maya payment mismatch", {
      paymentId,
      referenceMatches,
      amountMatches,
      verifiedAmount,
      expected: payment.amount_centavos
    });

    return res.status(200).json({
      success: true,
      message: "Payment received but flagged for manual reconciliation."
    });
  }

  if (status === "PAYMENT_SUCCESS") {
    const { data: finalized, error: finalizeError } = await supabase.rpc(
      "finalize_online_order_payment",
      { p_order_id: payment.order_id }
    );

    if (finalizeError || !finalized?.accepted) {
      console.error("Maya payment finalization failed:", finalizeError || finalized);
      return res.status(409).json({
        success: false,
        message: "Payment was verified, but the order could not be finalized. Manual review is required."
      });
    }

    const { error: updatePaymentError } = await supabase
      .from("payments")
      .update({ status: "paid", amount_mismatch: false })
      .eq("id", payment.id);

    if (updatePaymentError) {
      return res.status(500).json({
        success: false,
        message: "Payment was verified and the order was updated, but the payment record could not be updated."
      });
    }
  } else {
    const targetStatus =
      status === "PAYMENT_EXPIRED" ? "expired" : "cancelled";

    const { data: failedOrder, error: failOrderError } = await supabase.rpc(
      "mark_online_order_payment_failed",
      {
        p_order_id: payment.order_id,
        p_target_status: targetStatus
      }
    );

    if (failOrderError) {
      console.error("Maya failed-payment order update error:", failOrderError);
      return res.status(500).json({
        success: false,
        message: "Could not update the order after the failed payment."
      });
    }

    // Never overwrite a successful payment if a late failure event arrives.
    if (failedOrder?.status !== "paid") {
      const localStatus = status === "PAYMENT_EXPIRED" ? "expired" : "failed";
      const { error: updatePaymentError } = await supabase
        .from("payments")
        .update({ status: localStatus, amount_mismatch: false })
        .eq("id", payment.id);

      if (updatePaymentError) {
        return res.status(500).json({
          success: false,
          message: "Could not update payment status."
        });
      }
    }
  }

  await supabase
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("provider", "maya")
    .eq("event_id", eventId);

  return res.status(200).json({
    success: true,
    message: "Maya webhook processed.",
    payment_status: status
  });
};
