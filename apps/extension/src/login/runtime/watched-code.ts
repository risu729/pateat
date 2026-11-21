import { type Execution, type SignInReading } from "./types";
import { current } from "./attempt";
import { enterHandler } from "./handlers";
import { learn, watchesCode } from "./judge";
import { pathNow } from "./steps";
import type { Runtime } from "./state";

/**
 * A page of a watched login that asks for another sign-in step (`continuing`) gets the
 * item's TOTP once when it asks for an authenticator app's code (ADR 0027 amendment of
 * 2026-11-17), as Luma's dialog does after the emailed code the person typed: only in the
 * tab's page on the recipe's own origin, by a login that does not only fill, whose item
 * has a TOTP and that typed or means to type no code yet (`watchesCode`). A `totp` handler
 * the recipe has on the path is entered as after a step (`enterHandler`, whose code field
 * must be empty on a page that names an authenticator app); otherwise the page is judged,
 * and a `totp` handler the judge learns there is taken over and entered (`learn`). A page
 * with no sign of a sign-in going on (`judge`), as one whose only code input is a plain
 * text input the sign-in state does not read as one (ImmiAccount's, ADR 0027 amendment of
 * 2026-11-22), gets a `totp` handler the recipe has on the path entered the same way, and
 * is otherwise judged as any such page, where `learn` takes over a `totp` handler learned
 * on a page whose words name an authenticator app. Returns whether the page was dealt with
 * so: a handler entered, or the page sent to the judge.
 */
export async function watchedCode(
  rt: Runtime,
  run: Execution,
  reading: SignInReading,
): Promise<boolean> {
  const { metadata, recipe } = run;
  if ((reading.decision !== "continuing" && reading.decision !== "judge") || !watchesCode(run))
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
  if (reading.decision === "judge") return false;
  return learn(rt, run, reading, { code: true });
}
