import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.js";
import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";

function issueToken(user) {
  return jwt.sign(
    { sub: user.id },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

export async function register(req, res) {
  const { email, password, full_name } = req.validatedBody;

  const { data: existing, error: lookupError } = await supabase
    .from("users").select("id").eq("email", email).maybeSingle();

  if (lookupError) throw new AppError(500, "Could not check email availability.");
  if (existing) throw new AppError(409, "An account with this email already exists.");

  const password_hash = await bcrypt.hash(password, 12);
  const { data: user, error } = await supabase
    .from("users")
    .insert({ email, password_hash, full_name, role: "customer" })
    .select("id,email,full_name,role,created_at")
    .single();

  if (error) {
    if (error.code === "23505") throw new AppError(409, "An account with this email already exists.");
    throw new AppError(500, "Could not create account.");
  }

  res.status(201).json({
    success: true,
    message: "Account created.",
    data: { user, token: issueToken(user) }
  });
}

export async function login(req, res) {
  const { email, password } = req.validatedBody;
  const { data: user, error } = await supabase
    .from("users")
    .select("id,email,full_name,role,password_hash")
    .eq("email", email)
    .maybeSingle();

  if (error) throw new AppError(500, "Could not sign in.");
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new AppError(401, "Invalid email or password.");
  }

  const { password_hash, ...safeUser } = user;
  res.json({
    success: true,
    data: { user: safeUser, token: issueToken(safeUser) }
  });
}

export async function me(req, res) {
  res.json({ success: true, data: { user: req.user } });
}
