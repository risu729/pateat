import * as v from "valibot";
import { loginTargetSchema } from "@pateat/contracts";
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const url = v.pipe(v.string(), v.minLength(1), v.maxLength(2 * 1024 * 1024));
export const ssoCommandSchemas = [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.sso.inspect"),
    token: id,
    target: loginTargetSchema,
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.sso.prepare"),
    token: id,
    flowId: id,
    operationId: id,
    target: loginTargetSchema,
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.sso.commit"),
    token: id,
    flowId: id,
    operationId: id,
    handle: id,
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.sso.idp"),
    token: id,
    /** Native IdP username used only for exact local account comparison. Never persisted. */
    username: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  }),
] as const;
export const ssoCommandSchema = v.variant("type", ssoCommandSchemas);
export type SsoContentCommand = v.InferOutput<typeof ssoCommandSchema>;
export const ssoInspectResultSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(false), reason: id }),
  v.strictObject({
    ok: v.literal(true),
    url,
    destinations: v.pipe(v.array(url), v.maxLength(8)),
    handle: v.optional(id),
  }),
]);
export type SsoInspection = v.InferOutput<typeof ssoInspectResultSchema>;
export const ssoAuthorizeSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.sso.authorize"),
  token: id,
  flowId: id,
  operationId: id,
  handle: id,
});
export const ssoIdpResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("native") }),
  v.strictObject({ kind: v.literal("unsafe"), reason: id }),
  v.strictObject({ kind: v.literal("unknown") }),
  v.strictObject({
    kind: v.picklist(["account", "continue", "stay-signed-in"]),
    target: loginTargetSchema,
  }),
]);
export type SsoIdpReading = v.InferOutput<typeof ssoIdpResultSchema>;
