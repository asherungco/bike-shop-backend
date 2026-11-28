import { Router } from "express";
import { listCategories, createCategory } from "../controllers/categoryController.js";
import { requireAuth, allowRoles } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { z } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.get("/", asyncHandler(listCategories));
router.post("/", requireAuth, allowRoles("admin"), validateBody(z.object({ name: z.string().trim().min(2).max(80) })), asyncHandler(createCategory));
export default router;
