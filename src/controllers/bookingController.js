import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

const ACTIVE_BOOKING_STATUSES = ["confirmed", "held"];

function mapBookingError(error) {
  const message = String(error?.message || "");
  if (message.includes("SLOT_NOT_FOUND")) throw new AppError(404, "The selected appointment slot was not found.");
  if (message.includes("SLOT_CLOSED")) throw new AppError(409, "This appointment slot is already closed for booking.");
  if (message.includes("SLOT_FULL")) throw new AppError(409, "This appointment slot is already full.");
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
      booking.status === "confirmed" ||
      (booking.status === "held" && new Date(booking.held_until).getTime() > now.getTime())
    ).length;
    const { bookings, ...slotData } = slot;
    return { ...slotData, booked_count: taken, available_count: Math.max(0, slot.capacity - taken), is_available: taken < slot.capacity };
  }).filter((slot) => slot.is_available);

  res.json({ success: true, data: slots });
}

export async function createBookingHold(req, res) {
  const userId = req.user.id;
  const { slot_id: slotId, bike_id: bikeId = null } = req.validatedBody;

  if (bikeId) {
    const { data: bike, error: bikeError } = await supabase
      .from("bikes")
      .select("id")
      .eq("id", bikeId)
      .eq("user_id", userId)
      .maybeSingle();

    if (bikeError) {
      console.error("CHECK BIKE OWNERSHIP ERROR:", bikeError);
      throw new AppError(500, "Could not verify the selected bike.");
    }
    if (!bike) throw new AppError(404, "The selected bike was not found in your account.");
  }

  const { data: bookingId, error } = await supabase.rpc("create_booking_hold", {
    p_slot_id: slotId,
    p_user_id: userId,
    p_bike_id: bikeId,
    p_hold_minutes: 10,
    p_cutoff_hours: 2
  });

  if (error) mapBookingError(error);

  const { data: booking, error: fetchError } = await supabase
    .from("bookings")
    .select("id,slot_id,user_id,bike_id,status,held_until,created_at,service_slots(id,starts_at,service_types(id,name,duration_minutes,price_centavos))")
    .eq("id", bookingId)
    .single();

  if (fetchError) {
    console.error("FETCH NEW BOOKING ERROR:", fetchError);
    throw new AppError(500, "Your appointment hold was created, but its details could not be loaded.");
  }

  res.status(201).json({ success: true, message: "Appointment slot held for 10 minutes. Complete the next checkout step before the hold expires.", data: booking });
}

export async function listBookings(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "20", 10)));

  let query = supabase
    .from("bookings")
    .select("id,slot_id,user_id,order_id,bike_id,status,held_until,created_at,service_slots(id,starts_at,service_types(id,name,duration_minutes,price_centavos)),bikes(id,nickname,wheel_size,brake_type,drivetrain_speed,frame_size),users!bookings_user_id_fkey(id,full_name,email)", { count: "exact" })
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
  let lookup = supabase
    .from("bookings")
    .select("id,user_id,status,held_until")
    .eq("id", req.params.id);

  if (req.user.role === "customer") lookup = lookup.eq("user_id", req.user.id);
  const { data: booking, error: lookupError } = await lookup.maybeSingle();

  if (lookupError) {
    console.error("LOOKUP BOOKING ERROR:", lookupError);
    throw new AppError(500, "Could not retrieve the booking.");
  }
  if (!booking) throw new AppError(404, "Booking not found.");
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) throw new AppError(409, "Only held or confirmed bookings can be cancelled.");

  const { data, error } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", booking.id)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .select("id,status")
    .maybeSingle();

  if (error) {
    console.error("CANCEL BOOKING ERROR:", error);
    throw new AppError(500, "Could not cancel the booking.");
  }
  if (!data) throw new AppError(409, "The booking was changed by another request. Refresh and try again.");

  res.json({ success: true, message: "Booking cancelled.", data });
}

export async function updateBookingStatus(req, res) {
  const { status } = req.validatedBody;
  const { data: current, error: lookupError } = await supabase
    .from("bookings")
    .select("id,status,held_until")
    .eq("id", req.params.id)
    .maybeSingle();

  if (lookupError) {
    console.error("LOOKUP BOOKING STATUS ERROR:", lookupError);
    throw new AppError(500, "Could not retrieve the booking.");
  }
  if (!current) throw new AppError(404, "Booking not found.");
  if (status === "confirmed" && current.status !== "held") {
    throw new AppError(409, "Only an active held booking can be confirmed.");
  }
  if (status === "confirmed" && new Date(current.held_until).getTime() <= Date.now()) {
    await supabase.from("bookings").update({ status: "expired" }).eq("id", current.id).eq("status", "held");
    throw new AppError(409, "The booking hold has expired. The customer must select another slot.");
  }
  if (status === "cancelled" && !ACTIVE_BOOKING_STATUSES.includes(current.status)) {
    throw new AppError(409, "Only held or confirmed bookings can be cancelled.");
  }

  const { data, error } = await supabase
    .from("bookings")
    .update({ status })
    .eq("id", current.id)
    .eq("status", current.status)
    .select("id,status")
    .maybeSingle();

  if (error) {
    console.error("UPDATE BOOKING STATUS ERROR:", error);
    throw new AppError(500, "Could not update the booking status.");
  }
  if (!data) throw new AppError(409, "The booking was changed by another request. Refresh and try again.");

  res.json({ success: true, message: `Booking ${status}.`, data });
}
