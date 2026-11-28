import { Router } from "express";
import { requireAuth, allowRoles } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { checkoutSchema } from "../validators/orderSchemas.js";
import { checkout, listCustomerOrders, getOrder } from "../controllers/orderController.js";

const router = Router();
router.use(requireAuth);

router.post("/checkout", allowRoles("customer"), validateBody(checkoutSchema), asyncHandler(checkout));
router.get("/", allowRoles("customer", "admin", "mechanic"), asyncHandler(listCustomerOrders));
router.get("/:id", allowRoles("customer", "admin", "mechanic"), asyncHandler(getOrder));

export default router;
