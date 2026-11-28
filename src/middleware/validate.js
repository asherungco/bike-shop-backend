import { AppError } from "../utils/appError.js";

export const validateBody = (schema) => (req, _res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
  }
  req.validatedBody = parsed.data;
  next();
};
