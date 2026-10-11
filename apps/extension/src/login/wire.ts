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
export const helloSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.ready"),
  token: id,
  /** The first step's elements are ready on this path; a new attempt may start. */
  start: v.optional(v.strictObject({ path })),
});
/**
 * A refused hello. `starts` lists the first steps of the origin's recipes; the document
 * announces again with `start` once one of them is ready on the current path.
 */
export const readySchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.string()),
  starts: v.optional(v.pipe(v.array(loginReadinessSchema), v.maxLength(32))),
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
     * The selected account's username, sent only with a fill of secrets alone. The page
     * must not show another account; it never leaves the content script.
     */
    account: v.optional(v.strictObject({ username: v.pipe(v.string(), v.maxLength(4096)) })),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.await"),
    token: id,
    readiness: loginReadinessSchema,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGIN_STEP_WAIT_MS)),
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("login.cancel"), token: id }),
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
  reason: v.optional(v.picklist(["structural-mismatch", "timeout", "cancelled", "wrong-account"])),
});
export const awaitResultSchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.picklist(["timeout", "cancelled"])),
});
export const observationSchema = v.strictObject({
  path: v.string(),
  targets: v.pipe(v.array(v.picklist(["missing", "unique", "ambiguous"])), v.maxLength(24)),
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
