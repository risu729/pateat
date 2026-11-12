import { expect, it } from "vitest";
import { addCompletion, addHandler, appendPageSteps } from "../../src/assemble";
import type { CompletionSwitchContext } from "./context";

export function registerCompletionSwitchCases({
  origin,
  target,
  page,
  candidate,
  built,
  other,
  switched,
}: CompletionSwitchContext) {
  it("refuses the account switch or the rejection as a marker, as a handler does", () => {
    // A signed-in page's account menu may read like the login page's switch, but a marker
    // proves the sign-in on any path, so the login page would read as signed in.
    const home = { origin, path: "/home", candidates: [candidate("switch", other)] };
    expect(addCompletion(switched, home, other)).toEqual({ ok: false, reason: "step-target" });
    const rejected = { ...switched, rejection: target("error") };
    // A page that shows the rejection is a failed sign-in, whatever the marker.
    const failed = { origin, path: "/home", candidates: [candidate("error", target("error"))] };
    expect(addCompletion(rejected, failed, target("error"))).toEqual({
      ok: false,
      reason: "login-page",
    });
  });

  it("leaves out a continued page's switch that is a handler's button, keeping the page", () => {
    const first = built(page("/login", "username", "advance"));
    const key = target("key");
    const handled = addHandler(
      first,
      { origin, path: "/webauthn", candidates: [candidate("key", key)] },
      { kind: "passkey", target: key },
    );
    if (!handled.ok) throw new Error(handled.reason);
    const next = appendPageSteps(handled.recipe, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
      accountSwitch: key,
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe.accountSwitch).toBeUndefined();
    expect(next.recipe.steps).toHaveLength(4);
  });
}
