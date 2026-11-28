import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "Authentication token is required.");
  }

  let payload;
  try {
    payload = jwt.verify(header.slice(7), env.JWT_SECRET);
  } catch {
    throw new AppError(401, "Invalid or expired token.");
  }

  const { data: user, error } = await supabase
    .from("users")
    .select("id,email,full_name,role")
    .eq("id", payload.sub)
    .maybeSingle();

  if (error) throw new AppError(500, "Could not verify user account.");
  if (!user) throw new AppError(401, "User account no longer exists.");

  req.user = user;
  next();
});

export const allowRoles = (...roles) => (req, _res, next) => {
  if (!req.user || (req.user.role !== "admin" && !roles.includes(req.user.role))) {
    return next(new AppError(403, "You do not have permission to perform this action."));
  }
  next();
};

export const requireCustomer = (req, _res, next) => {
  if (!req.user) {
    return next(new AppError(401, "Authentication is required."));
  }
  if (req.user.role !== "customer") {
    return next(new AppError(403, "This action is only available to customers."));
  }
  next();
};
