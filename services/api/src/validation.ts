import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";
import { createMiddleware } from "hono/factory";
import type * as v from "valibot";
import { apiError } from "./http";

/** Rejects other media types before any body parsing, including `+json` variants. */
export const requireJsonBody = createMiddleware(async (c, next) => {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(c.req.header("Content-Type") ?? ""))
    return apiError(c, 415, { error: "unsupported_media_type" });
  return next();
});

/**
 * Valibot boundary validation. A failed check answers with a fixed error code. The hook
 * always returns on failure, because `sValidator` would otherwise reply with the rejected
 * input and the Valibot issues.
 */
export function validate<TTarget extends keyof ValidationTargets, TSchema extends v.GenericSchema>(
  target: TTarget,
  schema: TSchema,
  failure: { status: 400 | 404; error: "bad_request" | "not_found" } = {
    status: 400,
    error: "bad_request",
  },
) {
  return sValidator(target, schema, (result, c) =>
    result.success ? undefined : apiError(c, failure.status, { error: failure.error }),
  );
}

/** Validates a JSON body; failures are `400 bad_request` and never echo the input. */
export function jsonBody<TSchema extends v.GenericSchema>(schema: TSchema) {
  return validate("json", schema);
}

/** Owner pages accept only ordinary form posts; CSRF checks run before this. */
export const requireFormBody = createMiddleware(async (c, next) => {
  if (
    !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(
      c.req.header("Content-Type") ?? "",
    )
  )
    return c.text("Unsupported media type", 415);
  return next();
});
