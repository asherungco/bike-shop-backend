import { Router } from "express";
import { requireAuth, requireCustomer, allowRoles } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { checkoutSchema } from "../validators/orderSchemas.js";
import {
  checkout,
  listCustomerOrders,
  getOrder
} from "../controllers/orderController.js";

const router = Router();

router.use(requireAuth);

router.post(
  "/checkout",
  requireCustomer,
  validateBody(checkoutSchema),
  asyncHandler(checkout)
);

router.get(
  "/",
  allowRoles("customer", "admin", "employee", "mechanic"),
  asyncHandler(listCustomerOrders)
);

router.get(
  "/:id",
  allowRoles("customer", "admin", "employee", "mechanic"),
  asyncHandler(getOrder)
);

export default router;
