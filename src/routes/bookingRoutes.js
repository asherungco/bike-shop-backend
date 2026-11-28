import { Router } from "express";
import { requireAuth, allowRoles } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { bookingHoldSchema, bookingStatusSchema } from "../validators/bookingSchemas.js";
import {
  listServices,
  listAvailableSlots,
  createBookingHold,
  listBookings,
  cancelBooking,
  updateBookingStatus
} from "../controllers/bookingController.js";

const router = Router();
router.use(requireAuth);

router.get("/services", asyncHandler(listServices));
router.get("/slots", asyncHandler(listAvailableSlots));
router.get("/", asyncHandler(listBookings));
router.post("/hold", validateBody(bookingHoldSchema), asyncHandler(createBookingHold));
router.patch("/:id/cancel", asyncHandler(cancelBooking));
router.patch("/:id/status", allowRoles("admin", "employee", "mechanic"), validateBody(bookingStatusSchema), asyncHandler(updateBookingStatus));

export default router;
