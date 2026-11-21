import * as v from "valibot";
import { localSettingsSchema, normalizeHostname, parseSiteUrl } from "./settings";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const originSchema = v.pipe(
  v.string(),
  v.check((value) => {
    const url = parseSiteUrl(value);
    return url?.origin === value && normalizeHostname(url.hostname) !== undefined;
  }, "Use an exact HTTP(S) origin"),
);

/** The most items one `settings.site-accounts` request names. */
export const SITE_ACCOUNTS_MAX_NAMED = 10_000;
const itemReference = v.strictObject({ connectionId: identifier, itemId: identifier });

/**
 * The settings page asks which items could be the default account for one origin. Its
 * unsaved draft decides which connections and items are searched; it grants nothing.
 * `named` lists other items the page shows for the origin, matching or not, such as the
 * saved default's item or every item when the page lists those that do not match; their
 * login usernames are read too, so same-named items can be told apart.
 */
export const siteAccountsRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("settings.site-accounts"),
  origin: originSchema,
  settings: localSettingsSchema,
  named: v.optional(v.pipe(v.array(itemReference), v.maxLength(SITE_ACCOUNTS_MAX_NAMED))),
});

/**
 * Items the draft settings allow for the origin: a provider URI match for `origin/`, a
 * static allowed origin, or a stored passkey whose RP ID the origin may use. IDs, the
 * reasons and, for these matched items and the request's `named` items only, the login
 * username the saved settings let the item use; no other vault value. `named` holds the
 * usernames of the requested items that did not match. `complete` is false when a
 * connection or an item could not be evaluated.
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
          /** The item's login username, for telling same-named items apart. */
          username: v.optional(v.pipe(v.string(), v.maxLength(1024))),
        }),
      ),
      v.maxLength(10_000),
    ),
    named: v.optional(
      v.pipe(
        v.array(
          v.strictObject({
            ...itemReference.entries,
            username: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
          }),
        ),
        v.maxLength(10_000),
      ),
    ),
    complete: v.boolean(),
  }),
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(false),
    reason: v.picklist(["invalid-request", "unavailable"]),
  }),
]);

export type SiteItemReference = v.InferOutput<typeof itemReference>;
export type SiteAccountsRequest = v.InferOutput<typeof siteAccountsRequestSchema>;
export type SiteAccountsResponse = v.InferOutput<typeof siteAccountsResponseSchema>;

export function parseSiteAccountsResponse(value: unknown): SiteAccountsResponse {
  return v.parse(siteAccountsResponseSchema, value);
}
