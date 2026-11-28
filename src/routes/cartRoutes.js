import { Router } from "express";
import { requireAuth, requireCustomer } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { addCartItemSchema, updateCartItemSchema } from "../validators/orderSchemas.js";
import {
  getCart, addCartItem, updateCartItem, removeCartItem, clearCart
} from "../controllers/cartController.js";

const router = Router();
router.use(requireAuth, requireCustomer);

router.get("/", asyncHandler(getCart));
router.post("/items", validateBody(addCartItemSchema), asyncHandler(addCartItem));
router.patch("/items/:itemId", validateBody(updateCartItemSchema), asyncHandler(updateCartItem));
router.delete("/items/:itemId", asyncHandler(removeCartItem));
router.delete("/", asyncHandler(clearCart));

export default router;
