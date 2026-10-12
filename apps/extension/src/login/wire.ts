import * as v from "valibot";
import {
  loginOperationSchema,
  loginTargetSchema,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
/** Which inputs a secret value may fill; see `acceptsSecret` in `inputs.ts`. */
export const loginSecretKinds = ["password", "otp", "hidden"] as const;
export type LoginSecretKind = (typeof loginSecretKinds)[number];
const path = v.pipe(v.string(), v.minLength(1), v.maxLength(300));
/**
 * Elements a step needs before it can run: each target matches exactly one element that
 * is a writable input (`fill`), an enabled visible button (`click`) or simply present.
 * No targets means the path alone is enough.
 */
export const loginReadinessSchema = v.strictObject({
  path,
  require: v.picklist(["writable", "clickable", "present"]),
  targets: v.pipe(v.array(loginTargetSchema), v.maxLength(20)),
});
export type LoginReadiness = v.InferOutput<typeof loginReadinessSchema>;
/** What a step waits for; a `wait` or `assert`-absent step does its own waiting. */
export function loginReadiness(step: LoginStep): LoginReadiness {
  const targets: LoginTarget[] =
    step.kind === "fill"
      ? step.fields.map((field) => field.target)
      : step.kind === "click" || (step.kind === "assert" && step.present)
        ? [step.target]
        : [];
  return {
    path: step.path,
    require: step.kind === "fill" ? "writable" : step.kind === "click" ? "clickable" : "present",
    targets,
  };
}
/** How long a started attempt waits for a fill or click step's elements (owner-approved). */
export const LOGIN_STEP_WAIT_MS = 10000;
/**
 * How long a page is left unjudged while a held click's button still shows (ADR 0027): a
 * handler's, such as "Use security key", or the `passkey` route's, such as "Sign in with a
 * passkey", during a WebAuthn exchange; the passkey chooser's limit.
 */
export const HELD_CLICK_WAIT_MS = 120_000;
export const helloSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.ready"),
  token: id,
  /** The first step's elements are ready on this path; a new attempt may start. */
  start: v.optional(v.strictObject({ path })),
  /**
   * A visible password, username or one-time-code input shows on this path, so a page
   * without a recipe may be sent for generation (ADR 0016).
   */
  signIn: v.optional(v.strictObject({ path })),
});
/**
 * A refused hello. `starts` lists the first steps of the origin's recipes; the document
 * announces again with `start` once one of them is ready on the current path.
 */
export const readySchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.string()),
  starts: v.optional(v.pipe(v.array(loginReadinessSchema), v.maxLength(32))),
  /** The page may be sent for generation; announce again with `signIn` once it applies. */
  generate: v.optional(v.literal(true)),
});
export const reconnectSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.reconnect"),
});
export const authorizeSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.operation.authorize"),
  token: id,
  attemptId: id,
  operationId: id,
});
export const commandSchema = v.variant("type", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.observe"),
    token: id,
    path: v.string(),
    targets: v.pipe(v.array(loginTargetSchema), v.maxLength(24)),
    /**
     * Per target, what its one element must be to count as `unique`: a shown writable
     * input, a shown enabled button, or any shown element; otherwise it is `unusable`.
     * Without it, any one element counts, hidden or not.
     */
    require: v.optional(
      v.pipe(v.array(v.picklist(["writable", "clickable", "shown", "present"])), v.maxLength(24)),
    ),
    /**
     * Per target, whether a text locator may also name a link by its text, as for an
     * account switch: set for a completion marker, which may be a link (ADR 0018).
     */
    links: v.optional(v.pipe(v.array(v.boolean()), v.maxLength(24))),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.execute"),
    token: id,
    operation: loginOperationSchema,
    values: v.pipe(
      v.array(
        v.strictObject({
          slot: id,
          value: v.pipe(v.string(), v.maxLength(4096)),
          /** Secret values fill only matching inputs; other values fill any writable input. */
          secret: v.optional(v.picklist(loginSecretKinds)),
        }),
      ),
      v.maxLength(20),
    ),
    /**
     * The selected account's username, sent only with a fill of a secret but no username.
     * The page must not show another account; it never leaves the content script.
     */
    account: v.optional(v.strictObject({ username: v.pipe(v.string(), v.maxLength(4096)) })),
    /** The recipe's account switch, clicked when the page shows another account. */
    accountSwitch: v.optional(loginTargetSchema),
    /**
     * With a `totp` handler's code fill (ADR 0027): the button that submits the code. The
     * fill then watches for the page submitting the code by itself before it answers.
     */
    code: v.optional(v.strictObject({ submit: loginTargetSchema })),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.await"),
    token: id,
    readiness: loginReadinessSchema,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGIN_STEP_WAIT_MS)),
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("login.cancel"), token: id }),
  /**
   * Clicks the account switch a `wrong-account` result of `operationId` reported as
   * `switchable`, once the attempt has recorded the switch.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.switch"),
    token: id,
    operationId: id,
  }),
  /**
   * Describes the page without values: a login page to generate a recipe from, or the
   * page after a generated recipe's final submission (ADR 0018).
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.extract"),
    token: id,
    page: v.picklist(["login", "signed-in"]),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.status"),
    token: id,
    state: v.string(),
    stepIndex: v.number(),
    outcome: v.optional(v.string()),
  }),
]);
export const executionResultSchema = v.strictObject({
  ok: v.boolean(),
  operationId: id,
  documentId: id,
  mutation: v.picklist(["none", "possible"]),
  /**
   * `value-mismatch`: a value does not fit its input, and nothing was filled.
   * `fill-rejected`: after a preparing fill the page marked a filled input invalid or
   * showed a new alert (ADR 0010).
   * `submitted`: after a `totp` handler's code fill the page showed that it submits the
   * code by itself (ADR 0027); nothing was clicked.
   */
  reason: v.optional(
    v.picklist([
      "structural-mismatch",
      "timeout",
      "cancelled",
      "wrong-account",
      "value-mismatch",
      "fill-rejected",
      "submitted",
    ]),
  ),
  /**
   * With `wrong-account`: the command's account switch is on the page and can be clicked
   * with `login.switch`. Nothing was filled or clicked.
   */
  switchable: v.optional(v.literal(true)),
});
export const awaitResultSchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.picklist(["timeout", "cancelled"])),
});
/** The page description; validated again against `loginObservationSchema` by the caller. */
export const extractResultSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true), observation: v.unknown() }),
  v.strictObject({ ok: v.literal(false), reason: v.string() }),
]);
export const observationSchema = v.strictObject({
  path: v.string(),
  targets: v.pipe(
    v.array(v.picklist(["missing", "unique", "ambiguous", "unusable"])),
    v.maxLength(24),
  ),
});
export const configureSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.configure"),
  origin: v.pipe(
    v.string(),
    v.check((origin) => {
      try {
        const url = new URL(origin);
        return url.origin === origin && url.protocol === "http:" && url.hostname === "127.0.0.1";
      } catch {
        return false;
      }
    }),
  ),
  /** Probe-only explicit account binding; the default is the bundled demo item. */
  account: v.optional(
    v.strictObject({
      connectionId: id,
      itemId: id,
      slots: v.pipe(
        v.array(v.strictObject({ slot: id, fieldId: id })),
        v.minLength(1),
        v.maxLength(20),
      ),
    }),
  ),
  /**
   * Probe-only passkey fact for the synthetic item (ADR 0027). The probe vault holds no
   * passkey, so this stands in for the vault search; no key is created or used.
   */
  passkey: v.optional(v.picklist(["discoverable", "second-factor"])),
  /**
   * Probe-only TOTP fact for the synthetic item (ADR 0027): its synthetic `totp` field then
   * counts as holding a TOTP secret. The field's value is a fixed synthetic code.
   */
  totp: v.optional(v.literal(true)),
});
export const statusSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.status"),
});
export const cancelSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.cancel"),
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export const probeControlSchema = v.variant("action", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.probe.control"),
    action: v.literal("arm"),
    checkpoint: v.picklist(["before-delivery", "before-ack", "intent-write-failure"]),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.probe.control"),
    action: v.literal("release"),
  }),
]);
