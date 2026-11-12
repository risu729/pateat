import * as v from "valibot";
import { ssoMethodRefSchema } from "../crypto/sso-wire";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
export const ssoAccountSchema = v.strictObject({ connectionId: id, itemId: id });
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
export const ssoSourceSchema = v.strictObject({
  account: ssoAccountSchema,
  method: ssoMethodRefSchema,
  sourceEvidence: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
});
export const ssoSelectedSchema = v.strictObject({
  account: ssoAccountSchema,
  origin: ssoOriginSchema,
});
const tabId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const ssoGetRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.sso.get"),
  tabId,
});
const selectionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("unmap"), method: ssoMethodRefSchema }),
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
  itemId: id,
  itemLabel: id,
  connectionLabel: id,
  origin: ssoOriginSchema,
});
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
            }),
          ),
          v.maxLength(32),
        ),
        entries: v.pipe(v.array(v.strictObject({ id, label: id })), v.maxLength(100)),
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
