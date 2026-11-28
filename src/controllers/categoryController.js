import { supabase } from "../config/supabase.js";
import { AppError } from "../utils/appError.js";

export async function listCategories(_req, res) {
  const { data, error } = await supabase.from("categories")
    .select("id,name").order("name", { ascending: true });

  if (error) throw new AppError(500, "Could not retrieve categories.");
  res.json({ success: true, data });
}

export async function createCategory(req, res) {
  const name = req.validatedBody.name.trim();
  const { data, error } = await supabase.from("categories")
    .insert({ name }).select("id,name").single();

  if (error?.code === "23505") throw new AppError(409, "Category already exists.");
  if (error) throw new AppError(400, "Could not create category.");
  res.status(201).json({ success: true, data });
}
