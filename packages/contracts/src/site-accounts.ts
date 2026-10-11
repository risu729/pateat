import * as v from "valibot";
import { normalizeHostname, parseSiteUrl } from "./settings";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const originSchema = v.pipe(
  v.string(),
  v.check((value) => {
    const url = parseSiteUrl(value);
    return url?.origin === value && normalizeHostname(url.hostname) !== undefined;
  }, "Use an exact HTTP(S) origin"),
);

/** The settings page asks which items could be the default account for one origin. */
export const siteAccountsRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("settings.site-accounts"),
  origin: originSchema,
});

/**
 * Items the saved settings allow for the origin: a provider URI match for `origin/`, a
 * static allowed origin, or a stored passkey whose RP ID covers the origin's host. IDs and
 * the reasons only; no vault values. `complete` is false when a connection could not answer.
 */
export const siteAccountsResponseSchema = v.variant("ok", [
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(true),
    origin: originSchema,
    accounts: v.pipe(
      v.array(
        v.strictObject({
          connectionId: identifier,
          itemId: identifier,
          uri: v.boolean(),
          passkey: v.boolean(),
        }),
      ),
      v.maxLength(10_000),
    ),
    complete: v.boolean(),
  }),
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(false),
    reason: v.picklist(["invalid-request", "site-excluded", "unavailable"]),
  }),
]);

export type SiteAccountsRequest = v.InferOutput<typeof siteAccountsRequestSchema>;
export type SiteAccountsResponse = v.InferOutput<typeof siteAccountsResponseSchema>;

export function parseSiteAccountsResponse(value: unknown): SiteAccountsResponse {
  return v.parse(siteAccountsResponseSchema, value);
}
