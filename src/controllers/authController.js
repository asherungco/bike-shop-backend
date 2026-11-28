
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
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
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    throw new AppError(500, "Could not check email availability.");
  }

  if (existing) {
    throw new AppError(409, "An account with this email already exists.");
  }

  const password_hash = await bcrypt.hash(password, 12);

  const { data: user, error } = await supabase
    .from("users")
    .insert({ email, password_hash, full_name, role: "customer" })
    .select("id,email,full_name,role,created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError(409, "An account with this email already exists.");
    }
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

  if (error) {
    throw new AppError(500, "Could not sign in.");
  }

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new AppError(401, "Invalid email or password.");
  }

  const { password_hash, ...safeUser } = user;

  res.json({
    success: true,
    data: { user: safeUser, token: issueToken(safeUser) }
  });
}

export async function googleLogin(req, res) {
  const { access_token } = req.body || {};

  if (!access_token || typeof access_token !== "string") {
    throw new AppError(400, "Google access token is required.");
  }

  // Verify the Supabase Auth token with Supabase itself.
  const { data: authData, error: authError } =
    await supabase.auth.getUser(access_token);

  const authUser = authData?.user;

  if (authError || !authUser) {
    throw new AppError(401, "Invalid Google sign-in session.");
  }

  const isGoogleUser =
    authUser.app_metadata?.provider === "google" ||
    authUser.identities?.some(
      (identity) => identity.provider === "google"
    );

  if (!isGoogleUser || !authUser.email || !authUser.email_confirmed_at) {
    throw new AppError(401, "A verified Google account is required.");
  }

  const email = authUser.email.toLowerCase();

  // Reuse an existing account with the same verified email.
  const { data: existingUser, error: lookupError } = await supabase
    .from("users")
    .select("id,email,full_name,role")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    throw new AppError(500, "Could not check your account.");
  }

  let user = existingUser;

  // Create a customer account if this email has not registered before.
  if (!user) {
    const randomPassword = randomBytes(32).toString("hex");
    const password_hash = await bcrypt.hash(randomPassword, 12);

    const full_name =
      authUser.user_metadata?.full_name ||
      authUser.user_metadata?.name ||
      email.split("@")[0];

    const { data: newUser, error: insertError } = await supabase
      .from("users")
      .insert({
        email,
        password_hash,
        full_name,
        role: "customer"
      })
      .select("id,email,full_name,role")
      .single();

    if (insertError) {
      // Another simultaneous Google login may have created the account.
      if (insertError.code === "23505") {
        const { data: retryUser, error: retryError } = await supabase
          .from("users")
          .select("id,email,full_name,role")
          .eq("email", email)
          .maybeSingle();

        if (retryError || !retryUser) {
          throw new AppError(500, "Could not create or retrieve your account.");
        }

        user = retryUser;
      } else {
        throw new AppError(500, "Could not create your Google account.");
      }
    } else {
      user = newUser;
    }
  }

  res.json({
    success: true,
    data: {
      user,
      token: issueToken(user)
    }
  });
}

export async function me(req, res) {
  res.json({ success: true, data: { user: req.user } });
}
