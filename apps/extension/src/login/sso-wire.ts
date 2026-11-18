import * as v from "valibot";
import { ssoMethodRefSchema } from "../crypto/sso-wire";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
export const ssoOriginSchema = v.pipe(
  v.string(),
  v.maxLength(8192),
  v.check((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      ["https:", "http:"].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  }),
);
const tabId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const ssoGetRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.sso.get"),
  tabId,
});
const selectionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("unmap"), method: ssoMethodRefSchema }),
  /** Lists the saved IdP accounts and origins of a method whose saved mapping was reused. */
  v.strictObject({ kind: v.literal("discover"), method: ssoMethodRefSchema }),
  v.strictObject({ kind: v.literal("mapping"), method: ssoMethodRefSchema, candidateId: id }),
  v.strictObject({ kind: v.literal("native"), route: v.picklist(["passkey", "password"]) }),
  v.strictObject({
    kind: v.literal("sso"),
    method: ssoMethodRefSchema,
    /** An opaque candidate, never an arbitrary origin or account supplied by the popup. */
    candidateId: id,
    entryId: v.optional(id),
  }),
]);
export const ssoChooseRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.sso.choose"),
  tabId,
  offerId: id,
  selection: selectionSchema,
});
export const ssoCancelRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.sso.cancel"),
  tabId,
  offerId: id,
});
export const ssoActionResponseSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true) }),
  v.strictObject({ ok: v.literal(false), reason: id }),
]);
const candidateSchema = v.strictObject({
  id,
  itemLabel: id,
  connectionLabel: id,
  origin: ssoOriginSchema,
});
/** An observed URL-form entry the coordinator offers: an opaque ID and its shown text. */
export const ssoEntrySchema = v.strictObject({ id, label: id });
export const MAX_SSO_ENTRIES = 100;
export const ssoEntriesSchema = v.pipe(
  v.array(ssoEntrySchema),
  v.maxLength(MAX_SSO_ENTRIES),
  v.check(
    (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
    "Duplicate SSO entries",
  ),
);
export const ssoResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    offer: v.optional(
      v.strictObject({
        id,
        origin: ssoOriginSchema,
        accountLabel: id,
        passkey: v.boolean(),
        password: v.boolean(),
        methods: v.pipe(
          v.array(
            v.strictObject({
              method: ssoMethodRefSchema,
              automatic: v.boolean(),
              form: v.picklist(["url", "bracket"]),
              label: v.optional(v.pipe(v.string(), v.maxLength(128))),
              candidates: v.pipe(v.array(candidateSchema), v.maxLength(2000)),
              selectedId: v.optional(id),
              /** The settings hold a mapping of the method, which it can remove. */
              mapped: v.optional(v.literal(true)),
              /**
               * The one IdP item discovery found is used without a saved mapping, so there
               * is none to remove (ADR 0085, amended 2026-11-18).
               */
              inferred: v.optional(v.literal(true)),
              /** Why this method cannot run now, and the canonical field a refusal names. */
              reason: v.optional(id),
              field: v.optional(id),
            }),
          ),
          v.maxLength(32),
        ),
        entries: ssoEntriesSchema,
        /**
         * The login waits in a frame of the tab's page, whose own origin `origin` is, as
         * for the account chooser (ADR 0086).
         */
        frame: v.optional(v.literal(true)),
        reason: v.optional(id),
        field: v.optional(id),
        blocked: v.optional(v.literal(true)),
      }),
    ),
  }),
  v.strictObject({ ok: v.literal(false), reason: id }),
]);
export type SsoResponse = v.InferOutput<typeof ssoResponseSchema>;
export type SsoSelection = v.InferOutput<typeof selectionSchema>;
export type SsoChooseRequest = Omit<
  v.InferOutput<typeof ssoChooseRequestSchema>,
  "type" | "version"
>;
export type SsoActionResponse = v.InferOutput<typeof ssoActionResponseSchema>;
export interface SsoClient {
  get(tabId: number): Promise<SsoResponse>;
  choose(input: SsoChooseRequest): Promise<SsoActionResponse>;
  cancel(tabId: number, offerId: string): Promise<SsoActionResponse>;
}
export function createSsoClient(send: (message: unknown) => Promise<unknown>): SsoClient {
  return {
    get: async (tab) =>
      v.parse(ssoResponseSchema, await send({ version: 1, type: "login.sso.get", tabId: tab })),
    choose: async (input) =>
      v.parse(
        ssoActionResponseSchema,
        await send({ version: 1, type: "login.sso.choose", ...input }),
      ),
    cancel: async (tab, offerId) =>
      v.parse(
        ssoActionResponseSchema,
        await send({ version: 1, type: "login.sso.cancel", tabId: tab, offerId }),
      ),
  };
}
