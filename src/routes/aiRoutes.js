
import { Router } from "express";
import { validateBody } from "../middleware/validate.js";
import { getRecommendations } from "../controllers/aiController.js";
import { recommendationSchema } from "../validators/aiSchemas.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.post(
  "/recommendations",
  validateBody(recommendationSchema),
  asyncHandler(getRecommendations)
);

export default router;
