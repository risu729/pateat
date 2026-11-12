import { type LoginRecipe } from "@pateat/contracts";
import { expect, it } from "vitest";
import { addCompletion, addHandler } from "../../src/assemble";
import type { TotpProbesContext } from "./context";

export function registerTotpProbesCases({
  target,
  candidate,
  verify,
  key,
  recipe,
  code,
  at,
  totp,
}: TotpProbesContext) {
  it("refuses a field the page shows only as a button or link", () => {
    for (const role of ["button", "link"] as const)
      expect(
        addHandler(
          recipe,
          at("/two-factor", candidate("otp", target("otp"), role), candidate("v", verify)),
          totp(),
        ),
      ).toEqual({ ok: false, reason: "not-on-page" });
  });

  it("refuses a field the route fills on any path, even when it looks like a code input", () => {
    // `username` is filled on /login; the code page is elsewhere.
    expect(
      addHandler(
        recipe,
        at("/two-factor", code("username"), candidate("v", verify)),
        totp(target("username")),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
  });

  it("accepts the route's advance button on its path as the code's button", () => {
    const next = target("username-next");
    const added = addHandler(
      recipe,
      at("/login", code("otp"), candidate("next", next)),
      totp(target("otp"), next),
    );
    expect(added.ok && added.recipe.handlers).toEqual([
      { kind: "totp", path: "/login", field: target("otp"), target: next },
    ]);
  });

  it("refuses the passkey route's button on its path as the code's button", () => {
    const passkeyButton = target("passkey-login");
    const withRoute: LoginRecipe = {
      ...recipe,
      passkey: { path: "/login", target: passkeyButton },
    };
    expect(
      addHandler(
        withRoute,
        at("/login", code("otp"), candidate("pk", passkeyButton)),
        totp(target("otp"), passkeyButton),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
  });

  it("refuses another handler's element on that path, in either order", () => {
    const withKey = addHandler(
      recipe,
      at("/two-factor", candidate("key", key), code("otp"), candidate("v", verify)),
      { kind: "passkey", target: key },
    );
    if (!withKey.ok) throw new Error(withKey.reason);
    // The code's button is the passkey handler's button.
    expect(
      addHandler(
        withKey.recipe,
        at("/two-factor", candidate("key", key), code("otp")),
        totp(target("otp"), key),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
    // A passkey button that is the totp handler's button.
    const withCode = addHandler(
      recipe,
      at("/two-factor", code("otp"), candidate("v", verify)),
      totp(),
    );
    if (!withCode.ok) throw new Error(withCode.reason);
    expect(
      addHandler(withCode.recipe, at("/two-factor", code("otp"), candidate("v", verify)), {
        kind: "passkey",
        target: verify,
      }),
    ).toEqual({ ok: false, reason: "step-target" });
  });

  it("refuses a duplicate even when the new elements differ", () => {
    const added = addHandler(
      recipe,
      at("/two-factor", code("otp"), candidate("v", verify)),
      totp(),
    );
    if (!added.ok) throw new Error(added.reason);
    const go = target("go");
    expect(
      addHandler(
        added.recipe,
        at("/two-factor", code("otp2"), candidate("go", go)),
        totp(target("otp2"), go),
      ),
    ).toEqual({ ok: false, reason: "duplicate" });
    // A second code page on another path is a handler of its own.
    const again = addHandler(
      added.recipe,
      at("/two-factor/again", code("otp2"), candidate("go", go)),
      totp(target("otp2"), go),
    );
    expect(again.ok && again.recipe.handlers?.length).toBe(2);
  });

  it("refuses a code field on another origin", () => {
    expect(
      addHandler(
        recipe,
        {
          ...at("/two-factor", code("otp"), candidate("v", verify)),
          origin: "https://evil.example",
        },
        totp(),
      ),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("adds a handler on a path with a replaced segment, which every tenant's page shares (ADR 0039)", () => {
    const added = addHandler(
      recipe,
      at("/[id]/two-factor", code("otp"), candidate("v", verify)),
      totp(),
    );
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      expect.objectContaining({ kind: "totp", path: "/[id]/two-factor" }),
    ]);
  });

  it("learns no completion beside the handler's code field on its path, but beside other inputs", () => {
    const added = addHandler(
      recipe,
      at("/two-factor", code("otp"), candidate("v", verify)),
      totp(),
    );
    if (!added.ok) throw new Error(added.reason);
    // The handler's field on its own path blocks a completion there.
    expect(
      addCompletion(
        added.recipe,
        at("/two-factor", code("otp"), candidate("logout", target("logout"))),
        target("logout"),
      ),
    ).toEqual({ ok: false, reason: "login-page" });
    // The same locator on another path is not the handler's field.
    expect(
      addCompletion(
        added.recipe,
        at("/account", code("otp"), candidate("logout", target("logout"))),
        target("logout"),
      ).ok,
    ).toBe(true);
    // Another code-like field there is not the handler's, and the marker is learned.
    const learned = addCompletion(
      added.recipe,
      at("/account", code("pin"), candidate("logout", target("logout"))),
      target("logout"),
    );
    expect(learned.ok && learned.recipe.completion).toEqual([{ target: target("logout") }]);
    // The handler's button recurring there does not block it.
    const button = addCompletion(
      added.recipe,
      at("/account", candidate("v", verify), candidate("logout", target("logout"))),
      target("logout"),
    );
    expect(button.ok).toBe(true);
    // Its button is never a marker, on any path (ADR 0029).
    expect(addCompletion(added.recipe, at("/account", candidate("v", verify)), verify)).toEqual({
      ok: false,
      reason: "step-target",
    });
  });
}
