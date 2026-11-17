import { attemptUsesCode } from "@pateat/contracts";
import { type Execution, type SignInReading } from "./types";
import { current } from "./attempt";
import { enterHandler } from "./handlers";
import { learn } from "./judge";
import { pathNow } from "./steps";
import type { Runtime } from "./state";

/**
 * A page of a watched login that asks for another sign-in step (`continuing`) gets the
 * item's TOTP once when it asks for an authenticator app's code (ADR 0027 amendment of
 * 2026-11-17), as Luma's dialog does after the emailed code the person typed: only in the
 * tab's page on the recipe's own origin, by a login that does not only fill, whose item
 * has a TOTP and that typed or means to type no code yet. A `totp` handler the recipe has
 * on the path is entered as after a step (`enterHandler`, whose code field must be empty
 * on a page that names an authenticator app); otherwise the page is judged, and a `totp`
 * handler the judge learns there is taken over and entered (`learn`). Returns whether the
 * page was dealt with so: a handler entered, or the page sent to the judge.
 */
export async function watchedCode(
  rt: Runtime,
  run: Execution,
  reading: SignInReading,
): Promise<boolean> {
  const { metadata, recipe } = run;
  const { document } = run.live;
  if (
    reading.decision !== "continuing" ||
    metadata.state !== "watching" ||
    metadata.fillOnly === true ||
    metadata.signInFill === true ||
    document.frameId !== 0 ||
    document.origin !== recipe.origin ||
    !metadata.facts.totp ||
    attemptUsesCode(recipe, metadata)
  )
    return false;
  const path = pathNow(run.live);
  const known = (recipe.handlers ?? []).some(
    (handler, index) =>
      handler.kind === "totp" &&
      handler.path === path &&
      !metadata.handlers.some((entered) => entered.index === index),
  );
  if (known) {
    await enterHandler(rt, run, path);
    return !current(rt, run) || run.metadata.state !== "watching";
  }
  return learn(rt, run, reading, { code: true });
}
