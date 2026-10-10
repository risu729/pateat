import type { SyncError } from "@pateat/contracts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

/** Error bodies name a stable code only; causes stay out of responses. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  error: SyncError,
  headers?: Record<string, string>,
) {
  return c.json(error, status, headers);
}
