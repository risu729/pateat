import type { LoginLogoutRecipe } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createLogoutService } from "./logout";
import type { ServiceTransport } from "./transport";

// ADR 0063: the extension side of the logout route, with a synthetic transport.

const connection = {
  origin: "https://pateat.example.com",
  credential: "synthetic-credential",
  deviceId: "synthetic-device",
};
const recipe: LoginLogoutRecipe = {
  version: 1,
  id: "gen-00000000000000000000000000000001",
  revision: 1,
  origin: "https://shop.example",
  logout: {
    path: "/home",
    targets: [
      { kind: "click", path: "/home", target: { by: "id", value: "sign-out" }, purpose: "logout" },
    ],
  },
};
const request = {
  version: 1 as const,
  observation: {
    version: 1 as const,
    origin: "https://shop.example",
    path: "/home",
    language: "en" as const,
    complete: true,
    candidates: [],
  },
};

function setup(
  answer: Awaited<ReturnType<ServiceTransport["generateLogout"]>>,
  paired: object | null = connection,
) {
  const generateLogout = vi.fn<ServiceTransport["generateLogout"]>(async () => answer);
  const refresh = vi.fn(async () => undefined);
  const logout = createLogoutService({
    service: { connection: async () => (paired ?? undefined) as never },
    transport: { generateLogout },
    recipes: { logouts: async (origin) => (origin === recipe.origin ? [recipe] : []) },
    refresh,
  });
  return { logout, generateLogout, refresh };
}
const timing = { timing: { roundTripMs: 1 } };

describe("the logout service (ADR 0063)", () => {
  it("lists the origin's cached logout recipes", async () => {
    const { logout } = setup({ kind: "failed", error: "unreachable", ...timing });
    expect(await logout.recipes(recipe.origin)).toEqual([recipe]);
    expect(await logout.recipes("https://other.example")).toEqual([]);
  });

  it("sends the page to the paired service and pulls a returned recipe into the cache", async () => {
    const { logout, generateLogout, refresh } = setup({
      kind: "result",
      result: {
        version: 1,
        status: "recipe",
        change: { recipeId: recipe.id, revision: 1, state: "active", recipe },
      },
      ...timing,
    });
    expect(await logout.generate(request)).toEqual({ outcome: "recipe", recipe });
    expect(generateLogout).toHaveBeenCalledWith(connection.origin, connection.credential, request);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: "result", result: { version: 1, status: "signed-out" } }, { outcome: "signed-out" }],
    [
      { kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } },
      { outcome: "abstained", reason: "ambiguous" },
    ],
    [
      { kind: "result", result: { version: 1, status: "failed", error: "recipe-invalid" } },
      { outcome: "failed", reason: "recipe-invalid" },
    ],
    [
      { kind: "result", result: { version: 1, status: "unavailable", reason: "daily-limit" } },
      { outcome: "unavailable", reason: "daily-limit" },
    ],
    [{ kind: "rejected" }, { outcome: "failed", reason: "device-rejected" }],
    [
      { kind: "failed", error: "timeout" },
      { outcome: "failed", reason: "timeout" },
    ],
  ] as const)("answers %j as %j", async (answer, outcome) => {
    const { logout, refresh } = setup({ ...answer, ...timing } as never);
    expect(await logout.generate(request)).toEqual(outcome);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["no paired device", null],
    ["a rejected device", { ...connection, rejected: true }],
  ])("sends nothing with %s", async (_name, paired) => {
    const { logout, generateLogout } = setup(
      { kind: "failed", error: "unreachable", ...timing },
      paired,
    );
    expect(await logout.generate(request)).toEqual({ outcome: "skipped", reason: "not-connected" });
    expect(generateLogout).not.toHaveBeenCalled();
  });
});
