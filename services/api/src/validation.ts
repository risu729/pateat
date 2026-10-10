import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { validator } from "hono/validator";
import * as v from "valibot";
import { apiError } from "./http";

/** Rejects other media types before any body parsing, including `+json` variants. */
export const requireJsonBody = createMiddleware(async (c, next) => {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(c.req.header("Content-Type") ?? ""))
    return apiError(c, 415, { error: "unsupported_media_type" });
  return next();
});

/** Valibot boundary validation; failures never echo the rejected input. */
export function jsonBody<TSchema extends v.GenericSchema>(schema: TSchema) {
  return validator("json", (value, c: Context) => {
    const result = v.safeParse(schema, value);
    return result.success ? result.output : apiError(c, 400, { error: "bad_request" });
  });
}
