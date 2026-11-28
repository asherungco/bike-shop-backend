import { Router } from "express";
import { requireAuth, allowRoles } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { posSaleSchema, stockAdjustmentSchema, orderStatusSchema } from "../validators/operationsSchemas.js";
import { createPosSale, listOrders, updateOrderStatus, listInventory, adjustStock, listCustomers } from "../controllers/operationsController.js";

const router = Router();
router.use(requireAuth);
router.get("/orders", allowRoles("admin", "employee", "mechanic"), asyncHandler(listOrders));
router.get("/customers", allowRoles("admin", "employee", "mechanic"), asyncHandler(listCustomers));
router.patch("/orders/:id/status", allowRoles("admin", "employee", "mechanic"), validateBody(orderStatusSchema), asyncHandler(updateOrderStatus));
router.post("/pos/sales", allowRoles("admin", "employee", "mechanic"), validateBody(posSaleSchema), asyncHandler(createPosSale));
router.get("/inventory", allowRoles("admin", "employee", "mechanic"), asyncHandler(listInventory));
router.patch("/inventory/adjust", allowRoles("admin"), validateBody(stockAdjustmentSchema), asyncHandler(adjustStock));
export default router;
