import { z } from "zod";

/**
 * Shape the background SW returns for `SAVE_AS_PDF` / `SCREENSHOT` messages.
 *
 * Both endpoints are same-extension, but we validate the payload instead of
 * blindly casting it, so a contract drift between the content script and the SW
 * is surfaced as an explicit error rather than a misleading "saved as
 * undefined" / "failed: unknown error" message. Shared by the sibling handlers
 * so the same-extension contract is validated with a single source of truth.
 */
export const swOkResponseSchema = z.object({
  ok: z.boolean(),
  filename: z.string().optional(),
  error: z.string().optional(),
});
