import { Router } from "express";
import { requireAuth, requireCustomer, allowRoles } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { bookingSchema, bookingStatusSchema, bookingPaymentSchema } from "../validators/bookingSchemas.js";
import {
  listServices,
  listAvailableSlots,
  createRepairBooking,
  listBookings,
  cancelBooking,
  updateBookingStatus,
  markRepairPaymentReceived
} from "../controllers/bookingController.js";

const router = Router();

router.get("/services", asyncHandler(listServices));
router.get("/slots", asyncHandler(listAvailableSlots));

router.use(requireAuth);
router.get("/", asyncHandler(listBookings));
router.post("/", requireCustomer, validateBody(bookingSchema), asyncHandler(createRepairBooking));
router.patch("/:id/cancel", asyncHandler(cancelBooking));
router.patch(
  "/:id/status",
  allowRoles("admin", "employee", "mechanic"),
  validateBody(bookingStatusSchema),
  asyncHandler(updateBookingStatus)
);
router.patch(
  "/:id/payment",
  allowRoles("admin", "employee", "mechanic"),
  validateBody(bookingPaymentSchema),
  asyncHandler(markRepairPaymentReceived)
);

export default router;
