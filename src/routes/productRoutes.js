import { Router } from "express";
import { listProducts, getProduct, createProduct, updateProduct, deactivateProduct } from "../controllers/productController.js";
import { requireAuth, allowRoles } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { createProductSchema, updateProductSchema } from "../validators/productSchemas.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.get("/", asyncHandler(listProducts));
router.get("/:id", asyncHandler(getProduct));
router.post("/", requireAuth, allowRoles("admin"), validateBody(createProductSchema), asyncHandler(createProduct));
router.patch("/:id", requireAuth, allowRoles("admin"), validateBody(updateProductSchema), asyncHandler(updateProduct));
router.delete("/:id", requireAuth, allowRoles("admin"), asyncHandler(deactivateProduct));
export default router;
