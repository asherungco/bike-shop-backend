import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

function mapBookingError(error) {
  const message = String(error?.message || "");
  if (message.includes("SLOT_NOT_FOUND")) throw new AppError(404, "The selected appointment slot was not found.");
  if (message.includes("SLOT_CLOSED")) throw new AppError(409, "This appointment slot is already closed for booking.");
  if (message.includes("SLOT_FULL")) throw new AppError(409, "This appointment slot is already full.");
  if (message.includes("BIKE_DETAILS_REQUIRED")) throw new AppError(400, "Please enter your bike details.");
  if (message.includes("PROBLEM_DESCRIPTION_REQUIRED")) throw new AppError(400, "Please describe the bike problem in at least 10 characters.");
  if (message.includes("BIKE_NOT_FOUND")) throw new AppError(404, "The selected bike was not found in your account.");
  if (message.includes("SERVICE_UNAVAILABLE")) throw new AppError(409, "This repair service is currently unavailable.");
  if (message.includes("FINAL_COST_REQUIRED")) throw new AppError(400, "Enter the final repair cost before marking the repair ready.");
  if (message.includes("REPAIR_PAYMENT_REQUIRED")) throw new AppError(409, "Record the repair payment before completing this booking.");
  if (message.includes("REPAIR_NOT_READY_FOR_PAYMENT")) throw new AppError(409, "This repair is not ready for payment yet.");
  if (message.includes("INVALID_BOOKING_TRANSITION")) throw new AppError(409, "That repair booking status change is not allowed.");
  if (message.includes("BOOKING_NOT_FOUND")) throw new AppError(404, "Repair booking not found.");
  if (message.includes("permission denied") || message.includes("not authorized")) {
    throw new AppError(500, "Booking is not enabled on the database yet. The booking function needs permission for the backend service role.");
  }
  console.error("BOOKING ERROR:", error);
  throw new AppError(400, "Could not complete the booking request.");
}

export async function listServices(_req, res) {
  const { data, error } = await supabase
    .from("service_types")
    .select("id,name,duration_minutes,price_centavos")
    .eq("is_active", true)
    .order("id", { ascending: true });

  if (error) {
    console.error("LIST SERVICES ERROR:", error);
    throw new AppError(500, "Could not retrieve repair services.");
  }

  res.json({ success: true, data });
}

export async function listAvailableSlots(req, res) {
  const now = new Date();
  const from = req.query.from ? new Date(req.query.from) : now;
  const to = req.query.to ? new Date(req.query.to) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const serviceTypeId = req.query.service_type_id ? Number(req.query.service_type_id) : null;

  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    throw new AppError(400, "Provide a valid date range. The 'to' date must be later than 'from'.");
  }
  if (to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
    throw new AppError(400, "Please request appointment slots within a 31-day range.");
  }
  if (req.query.service_type_id && (!Number.isInteger(serviceTypeId) || serviceTypeId < 1)) {
    throw new AppError(400, "service_type_id must be a positive integer.");
  }

  let query = supabase
    .from("service_slots")
    .select("id,service_type_id,starts_at,capacity,service_types!inner(id,name,duration_minutes,price_centavos,is_active),bookings(status,held_until)")
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString())
    .eq("service_types.is_active", true)
    .order("starts_at", { ascending: true });

  if (serviceTypeId) query = query.eq("service_type_id", serviceTypeId);

  const { data, error } = await query;
  if (error) {
    console.error("LIST SLOTS ERROR:", error);
    throw new AppError(500, "Could not retrieve appointment availability.");
  }

  const slots = (data || []).map((slot) => {
    const taken = (slot.bookings || []).filter((booking) =>
      ["pending", "confirmed", "in_repair", "ready_for_pickup"].includes(booking.status)
    ).length;
    const { bookings, ...slotData } = slot;
    return { ...slotData, booked_count: taken, available_count: Math.max(0, slot.capacity - taken), is_available: taken < slot.capacity };
  }).filter((slot) => slot.is_available);

  res.json({ success: true, data: slots });
}

export async function createRepairBooking(req, res) {
  const { slot_id: slotId, bike_id: bikeId = null, bike_description: bikeDescription, problem_description: problemDescription } = req.validatedBody;

  const { data: bookingId, error } = await supabase.rpc("create_repair_booking", {
    p_slot_id: slotId,
    p_user_id: req.user.id,
    p_bike_id: bikeId,
    p_bike_description: bikeDescription,
    p_problem_description: problemDescription
  });

  if (error) mapBookingError(error);

  const { data: booking, error: fetchError } = await supabase
    .from("bookings")
    .select("id,slot_id,user_id,bike_id,status,held_until,created_at,bike_description,problem_description,final_cost_centavos,payment_status,payment_method,service_slots(id,starts_at,service_types(id,name,duration_minutes,price_centavos))")
    .eq("id", bookingId)
    .single();

  if (fetchError) {
    console.error("FETCH NEW REPAIR BOOKING ERROR:", fetchError);
    throw new AppError(500, "Your repair booking was created, but its details could not be loaded.");
  }

  res.status(201).json({
    success: true,
    message: "Repair appointment submitted. The shop will review and confirm it.",
    data: booking
  });
}

export async function listBookings(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "20", 10)));

  let query = supabase
    .from("bookings")
    .select("id,slot_id,user_id,order_id,bike_id,status,held_until,created_at,bike_description,problem_description,final_cost_centavos,payment_status,payment_method,service_slots(id,starts_at,service_types(id,name,duration_minutes,price_centavos)),bikes(id,nickname,wheel_size,brake_type,drivetrain_speed,frame_size),users!bookings_user_id_fkey(id,full_name,email),booking_status_history(id,from_status,to_status,actor_role,created_at)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (req.user.role === "customer") query = query.eq("user_id", req.user.id);
  if (req.query.status) query = query.eq("status", req.query.status);

  const { data, error, count } = await query;
  if (error) {
    console.error("LIST BOOKINGS ERROR:", error);
    throw new AppError(500, "Could not retrieve repair bookings.");
  }

  res.json({
    success: true,
    data,
    pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) }
  });
}

export async function cancelBooking(req, res) {
  const { data, error } = await supabase.rpc("cancel_repair_booking", {
    p_booking_id: req.params.id,
    p_actor_id: req.user.id,
    p_actor_role: req.user.role
  });

  if (error) mapBookingError(error);
  res.json({ success: true, message: "Repair booking cancelled.", data });
}

export async function updateBookingStatus(req, res) {
  const { status, final_cost_centavos: finalCostCentavos = null } = req.validatedBody;
  const { data, error } = await supabase.rpc("update_repair_booking_status", {
    p_booking_id: req.params.id,
    p_actor_id: req.user.id,
    p_actor_role: req.user.role,
    p_new_status: status,
    p_final_cost_centavos: finalCostCentavos
  });

  if (error) mapBookingError(error);
  res.json({ success: true, message: `Repair booking ${status.replaceAll("_", " ")}.`, data });
}

export async function markRepairPaymentReceived(req, res) {
  const { data, error } = await supabase.rpc("mark_repair_payment_received", {
    p_booking_id: req.params.id,
    p_actor_id: req.user.id,
    p_actor_role: req.user.role
  });

  if (error) mapBookingError(error);
  res.json({ success: true, message: "Repair payment recorded.", data });
}
