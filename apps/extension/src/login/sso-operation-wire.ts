import * as v from "valibot";
import { loginTargetSchema } from "@pateat/contracts";
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const url = v.pipe(v.string(), v.minLength(1), v.maxLength(2 * 1024 * 1024));
/** Ephemeral local IdP identity fence; never part of a journal or remote request. */
export const ssoIdpExpectationSchema = v.strictObject({
  username: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  kind: v.picklist(["account", "continue", "stay-signed-in"]),
});
export type SsoIdpExpectation = v.InferOutput<typeof ssoIdpExpectationSchema>;
export const ssoCommandSchemas = [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.sso.return"),
    token: id,
    username: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1024))),
  }),
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
    idp: v.optional(ssoIdpExpectationSchema),
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
  /**
   * A native login's stay-signed-in question after it sent its credential (ADR 0065
   * amendment of 2026-11-22): the page is read as an IdP page is (`login.sso.idp`), and only
   * its `stay-signed-in` target is prepared for one `login.stay.commit`.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.stay.prepare"),
    token: id,
    attemptId: id,
    operationId: id,
    /** The login's own username, for the same local comparison only. Never persisted. */
    username: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.stay.commit"),
    token: id,
    attemptId: id,
    operationId: id,
    handle: id,
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
  phase: v.picklist(["pointer", "click"]),
  token: id,
  flowId: id,
  operationId: id,
  handle: id,
});
/** The worker's authorization of a stay-signed-in press's phase (ADR 0065, 2026-11-22). */
export const stayAuthorizeSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.stay.authorize"),
  phase: v.picklist(["pointer", "click"]),
  token: id,
  attemptId: id,
  operationId: id,
  handle: id,
});
export const ssoIdpResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("native") }),
  v.strictObject({ kind: v.literal("unsafe"), reason: id }),
  v.strictObject({
    kind: v.literal("unknown"),
    /**
     * The page offers the person something to choose: a visible button, link, field or
     * other control, or a visible frame (ADR 0026, amendment of 2026-11-18). Only a page
     * without one, as an interstitial that sends the tab on by itself, may hold the flow.
     */
    controls: v.boolean(),
  }),
  v.strictObject({
    kind: v.picklist(["account", "continue", "stay-signed-in"]),
    target: loginTargetSchema,
  }),
]);
export type SsoIdpReading = v.InferOutput<typeof ssoIdpResultSchema>;

export const ssoReturnResultSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(false), reason: id }),
  v.strictObject({ ok: v.literal(true), identity: v.picklist(["match", "different", "absent"]) }),
]);
