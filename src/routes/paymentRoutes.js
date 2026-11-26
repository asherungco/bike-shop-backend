import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { createMayaCheckout, handleMayaWebhook } from "../controllers/paymentController.js";

const router = Router();

// Maya calls this endpoint directly; payment is independently verified with Maya's API.
router.post("/webhook", asyncHandler(handleMayaWebhook));

// Authenticated customer starts checkout for one of their pending online orders.
router.post("/orders/:orderId/checkout", requireAuth, asyncHandler(createMayaCheckout));

export default router;
