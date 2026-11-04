import * as v from "valibot";
import {
  isDetailSlot,
  loginTargetSchema,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";
import { path } from "./primitives";

/**
 * Elements a step needs before it can run: each target matches exactly one element that
 * is a writable input (`fill`; a writable input or a select for a `detail` handler's fill,
 * ADR 0061), an enabled visible button (`click`) or simply present. No targets means the
 * path alone is enough.
 */
export const loginReadinessSchema = v.strictObject({
  path,
  require: v.picklist(["writable", "settable", "clickable", "present"]),
  targets: v.pipe(v.array(loginTargetSchema), v.maxLength(20)),
  /**
   * Those of a `fill` step's `targets` that are entered on the page's software keyboard
   * (ADR 0067): ready when shown and enabled, read-only or not.
   */
  keypad: v.optional(v.pipe(v.array(loginTargetSchema), v.minLength(1), v.maxLength(20))),
  /**
   * A chooser recipe's start (ADR 0028): ready on its path, without a sign-in input, once
   * one of `targets` shows or the page lists an account by its email, masked or not.
   */
  accounts: v.optional(v.literal(true)),
  /**
   * A later `fill` step a new login may start at (ADR 0049): ready only while the page
   * shows no other identifier input, as an email form beside its password input would.
   */
  later: v.optional(v.literal(true)),
  /**
   * The targets a later step started with its password alone drops (ADR 0049): ready only
   * while none of them shows writable, no other text input shares the password's form and
   * neither the password input nor its form is marked `new-password`.
   */
  absent: v.optional(v.pipe(v.array(loginTargetSchema), v.minLength(1), v.maxLength(20))),
  /**
   * A recipe's final `advance` click whose page may be sent to replace it (ADR 0018
   * amendment of 2026-11-03): the wait also ends, as `revealed`, once its one target shows
   * but takes no click while a visible writable password input, no new password or
   * one-time code, shares its form.
   */
  revealed: v.optional(v.literal(true)),
});
export type LoginReadiness = v.InferOutput<typeof loginReadinessSchema>;
/** What a later step a new login may start at waits for (ADR 0049). */
export function laterReadiness(entry: {
  step: LoginStep;
  absent?: LoginTarget[] | undefined;
}): LoginReadiness {
  return {
    ...loginReadiness(entry.step),
    later: true,
    ...(entry.absent?.length ? { absent: entry.absent } : {}),
  };
}
/** What a step waits for; a `wait` or `assert`-absent step does its own waiting. */
export function loginReadiness(step: LoginStep): LoginReadiness {
  const targets: LoginTarget[] =
    step.kind === "fill"
      ? step.fields.map((field) => field.target)
      : step.kind === "click" || (step.kind === "assert" && step.present)
        ? [step.target]
        : [];
  const keypad =
    step.kind === "fill"
      ? step.fields.flatMap((field) => (field.keypad ? [field.target] : []))
      : [];
  return {
    path: step.path,
    // A split date's part may be a select (ADR 0061); Enter goes into a field (ADR 0064).
    require:
      step.kind === "fill"
        ? step.fields.some((field) => isDetailSlot(field.slot))
          ? "settable"
          : "writable"
        : step.kind === "click" && step.press === "enter"
          ? "writable"
          : step.kind === "click"
            ? "clickable"
            : "present",
    targets,
    ...(keypad.length ? { keypad } : {}),
  };
}

/**
 * Why a later step a login may start at did not (ADR 0049), in the order checked:
 * `target`, a target matches no unique usable element; `identifier`, the page shows
 * another identifier input; for a step started with its password alone, `absent`, a target
 * it drops shows writable, `form-input`, another text input shares the password's form,
 * or `new-password`, the form is marked for a new password.
 */
export const LATER_MISSES = [
  "target",
  "identifier",
  "absent",
  "form-input",
  "new-password",
] as const;
export type LaterMiss = (typeof LATER_MISSES)[number];
export const shownLaterSchema = v.strictObject({
  steps: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32)),
  partial: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(32)),
  miss: v.picklist(LATER_MISSES),
});
export type ShownLater = v.InferOutput<typeof shownLaterSchema>;
/**
 * What the first steps watched on a path missed after the step wait (ADR 0041): the
 * targets that match no element, several, or one that is not rendered, not those that
 * match one shown element that is not usable yet, and the HTTP status of the document's
 * own load when the browser reports one.
 */
export const startMissSchema = v.strictObject({
  missing: v.pipe(v.array(loginTargetSchema), v.maxLength(20)),
  /**
   * More targets missed than `missing` lists. `found` then says whether a watched first
   * step had every target match one element.
   */
  more: v.optional(v.literal(true)),
  found: v.optional(v.literal(true)),
  status: v.optional(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
});
export type StartMiss = v.InferOutput<typeof startMissSchema>;
