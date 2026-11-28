import { Router } from "express";
import { requireAuth, requireCustomer } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  createMayaCheckout,
  handleMayaWebhook
} from "../controllers/paymentController.js";

const router = Router();

router.post("/webhook", asyncHandler(handleMayaWebhook));

router.post(
  "/orders/:orderId/checkout",
  requireAuth,
  requireCustomer,
  asyncHandler(createMayaCheckout)
);

export default router;
