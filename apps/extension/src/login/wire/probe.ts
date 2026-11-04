import * as v from "valibot";
import { LOGIN_STEP_WAIT_MS } from "./constants";
import { id } from "./primitives";

export const configureSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.configure"),
  origin: v.pipe(
    v.string(),
    v.check((origin) => {
      const url = URL.parse(origin);
      return (
        url !== null &&
        url.origin === origin &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1"
      );
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
  /**
   * Probe-only wait in place of `LOGIN_STEP_WAIT_MS` for a step's elements and an
   * advance's confirmation, so a test runs past those waits without sitting out ten
   * seconds. Without it, as always in production, the full wait applies.
   */
  stepWaitMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(LOGIN_STEP_WAIT_MS)),
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
