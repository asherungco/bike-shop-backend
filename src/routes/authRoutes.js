import { Router } from "express";
import {
  register,
  login,
  me,
  googleLogin
} from "../controllers/authController.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { registerSchema, loginSchema } from "../validators/authSchemas.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post("/register", validateBody(registerSchema), asyncHandler(register));
router.post("/login", validateBody(loginSchema), asyncHandler(login));
router.post("/google", asyncHandler(googleLogin));
router.get("/me", requireAuth, asyncHandler(me));

export default router;
