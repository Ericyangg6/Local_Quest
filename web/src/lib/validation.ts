import { z } from "zod";

export const USERNAME_RULES = "3–20 characters: letters, numbers, or underscores.";
export const PASSWORD_RULES = "Use 10–128 characters, with at least one letter and one number.";

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, USERNAME_RULES)
  .max(20, USERNAME_RULES)
  .regex(/^[a-z0-9_]+$/, USERNAME_RULES);

const email = z.string().trim().toLowerCase().max(254, "Enter a valid email address.").pipe(z.email("Enter a valid email address."));

// Length is the main strength factor; the 128 cap bounds hashing cost.
const password = z
  .string()
  .min(10, PASSWORD_RULES)
  .max(128, PASSWORD_RULES)
  .regex(/[A-Za-z]/, PASSWORD_RULES)
  .regex(/[0-9]/, PASSWORD_RULES);

export const registrationSchema = z
  .object({ username, email, password })
  .superRefine((data, ctx) => {
    const lowered = data.password.toLowerCase();
    const emailName = data.email.split("@")[0];
    if (lowered.includes(data.username) || (emailName.length >= 3 && lowered.includes(emailName))) {
      ctx.addIssue({ code: "custom", path: ["password"], message: "Don't include your username or email in your password." });
    }
  });

/** Sign-in only checks shape; it never reports which rule failed, to keep errors generic. */
export const signInSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(128),
});

export type FieldErrors = Partial<Record<"username" | "email" | "password", string>>;

export function toFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if ((field === "username" || field === "email" || field === "password") && !errors[field]) {
      errors[field] = issue.message;
    }
  }
  return errors;
}
