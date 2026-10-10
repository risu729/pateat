import * as v from "valibot";
import { loginOperationSchema, loginTargetSchema } from "@pateat/contracts";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
/** Which inputs a secret value may fill; see `acceptsSecret` in `inputs.ts`. */
export const loginSecretKinds = ["password", "otp", "hidden"] as const;
export type LoginSecretKind = (typeof loginSecretKinds)[number];
export const helloSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.ready"),
  token: id,
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
  reason: v.optional(v.picklist(["structural-mismatch", "timeout", "cancelled"])),
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
