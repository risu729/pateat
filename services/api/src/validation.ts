import type { Context } from "hono";
import { validator } from "hono/validator";
import * as v from "valibot";
import { apiError } from "./http";

/** Valibot boundary validation; failures never echo the rejected input. */
export function jsonBody<TSchema extends v.GenericSchema>(schema: TSchema) {
  return validator("json", (value, c: Context) => {
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(c.req.header("Content-Type") ?? ""))
      return apiError(c, 415, { error: "unsupported_media_type" });
    const result = v.safeParse(schema, value);
    return result.success ? result.output : apiError(c, 400, { error: "bad_request" });
  });
}
