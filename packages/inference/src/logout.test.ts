import type { LoginObservation, ObservedCandidate } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import {
  appendLogoutClick,
  createLogoutGenerator,
  logoutInstructions,
  logoutPromptVersion,
  validateLogout,
} from "./logout";
import { entryGenerationPromptVersion, generationInstructions } from "./generation";
import { textModel, textResult } from "./testing/fake-models";

// ADR 0063: a synthetic signed-in page, sent to find the control that signs out.

const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const control = (
  id: string,
  role: "button" | "link",
  target: ObservedCandidate["target"],
  label?: string,
): ObservedCandidate => ({ id, role, target, ...(label ? { label } : {}) });
const homePage: LoginObservation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/home",
  language: "en",
  complete: true,
  candidates: [
    control("c1", "button", { by: "id", value: "account-menu" }, "Account"),
    control("c2", "link", { by: "text", value: "Orders" }),
    control("c3", "button", { by: "text", value: "Sign out" }),
    control("c4", "button", { by: "text", value: "[email]" }),
  ],
};
const answer = (candidate: string, purpose = "logout") =>
  JSON.stringify({ result: { decision: "logout", control: candidate, purpose } });

function generator(text: string) {
  const model = textModel(async () => textResult(text));
  return { model, generate: createLogoutGenerator({ model, limits, maxOutputTokens: 512 }) };
}

describe("logout generation (ADR 0063)", () => {
  it("returns the control the model names, its locator and what it does", async () => {
    const { model, generate } = generator(answer("c3"));
    expect(await generate({ observation: homePage })).toMatchObject({
      status: "ok",
      calls: 1,
      value: {
        decision: "logout",
        control: "c3",
        target: { by: "text", value: "Sign out" },
        purpose: "logout",
      },
      answer: { decision: "logout", control: "c3", purpose: "logout" },
    });
    const call = model.doGenerateCalls[0]!;
    const system = call.prompt.filter((message) => message.role === "system");
    expect(system.map((message) => message.content)).toEqual([logoutInstructions]);
    const user = call.prompt.find((message) => message.role === "user")!;
    const text = user.content.find((part) => part.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "")).toEqual({
      task: "logout",
      observation: homePage,
    });
  });

  it("returns a menu that holds the logout, and a page that is signed out", async () => {
    expect(await generator(answer("c1", "menu")).generate({ observation: homePage })).toMatchObject(
      {
        status: "ok",
        value: { decision: "logout", target: { by: "id", value: "account-menu" }, purpose: "menu" },
      },
    );
    expect(
      await generator(JSON.stringify({ result: { decision: "signed-out" } })).generate({
        observation: homePage,
      }),
    ).toMatchObject({ status: "ok", value: { decision: "signed-out" } });
  });

  it("passes an abstention through", async () => {
    expect(
      await generator(
        JSON.stringify({ result: { decision: "abstain", reason: "no-logout-control" } }),
      ).generate({ observation: homePage }),
    ).toMatchObject({ status: "abstained", reason: "no-logout-control" });
  });

  it.each([
    ["an unknown candidate", "Sign out", "unknown-candidate", "?"],
    ["a control that names an account", "c4", "account-text", "c4"],
  ])("refuses a logout that names %s", async (_name, candidate, detail, logged) => {
    expect(await generator(answer(candidate)).generate({ observation: homePage })).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail,
      answer: { decision: "logout", control: logged },
    });
  });

  it("refuses a page with a field, accounts or no complete description before any call", async () => {
    const field: ObservedCandidate = {
      id: "q",
      role: "text",
      target: { by: "id", value: "search" },
    };
    const cases = [
      [{ ...homePage, candidates: [...homePage.candidates, field] }, "invalid-request"],
      [{ ...homePage, accounts: ["[email]"] }, "invalid-request"],
      [{ ...homePage, complete: false }, "incomplete-observation"],
    ] as const;
    for (const [observation, error] of cases) {
      const { model, generate } = generator(answer("c3"));
      // eslint-disable-next-line no-await-in-loop
      expect(await generate({ observation })).toMatchObject({ status: "failed", error, calls: 0 });
      expect(model.doGenerateCalls).toHaveLength(0);
    }
  });

  it("has its own instructions and prompt version, generic and without site names", async () => {
    expect(logoutInstructions).not.toBe(generationInstructions);
    expect(await logoutPromptVersion()).not.toBe(await entryGenerationPromptVersion());
    expect(logoutInstructions).not.toMatch(/\.(?:com|jp|net)\b/u);
  });
});

describe("logout plan check and assembly (ADR 0063)", () => {
  it("accepts a button or link by id, name, test ID or text, never a field locator", () => {
    expect(validateLogout(homePage, "c2")).toEqual({
      ok: true,
      target: { by: "text", value: "Orders" },
    });
    expect(
      validateLogout(
        {
          candidates: [
            control("c1", "button", { by: "accessible-name", value: "Sign out" }),
            { id: "c2", role: "checkbox", target: { by: "id", value: "keep" } },
          ],
        },
        "c1",
      ),
    ).toEqual({ ok: false, reason: "incompatible-role" });
  });

  const page = { id: "gen-logout", origin: "https://shop.example.test", path: "/home" };
  it("starts a recipe and appends the clicks after it, as the next revisions", () => {
    const first = appendLogoutClick(
      undefined,
      { ...page, revision: 1 },
      { target: { by: "id", value: "account-menu" }, purpose: "menu" },
    );
    expect(first).toEqual({
      ok: true,
      recipe: {
        version: 1,
        id: "gen-logout",
        revision: 1,
        origin: "https://shop.example.test",
        logout: {
          path: "/home",
          targets: [
            {
              kind: "click",
              path: "/home",
              target: { by: "id", value: "account-menu" },
              purpose: "menu",
            },
          ],
        },
      },
    });
    if (!first.ok) throw new Error(first.reason);
    const second = appendLogoutClick(
      first.recipe,
      { ...page, revision: 2 },
      { target: { by: "text", value: "Sign out" }, purpose: "logout" },
    );
    if (!second.ok) throw new Error(second.reason);
    const third = appendLogoutClick(
      second.recipe,
      { ...page, path: "/logout", revision: 3 },
      { target: { by: "text", value: "Yes" }, purpose: "confirm" },
    );
    if (!third.ok) throw new Error(third.reason);
    expect(third.recipe.logout.path).toBe("/home");
    expect(third.recipe.logout.targets.map((target) => [target.path, target.purpose])).toEqual([
      ["/home", "menu"],
      ["/home", "logout"],
      ["/logout", "confirm"],
    ]);
    expect(
      appendLogoutClick(
        third.recipe,
        { ...page, revision: 4 },
        {
          target: { by: "text", value: "Again" },
          purpose: "logout",
        },
      ),
    ).toEqual({ ok: false, reason: "too-many-clicks" });
    expect(
      appendLogoutClick(
        first.recipe,
        { ...page, revision: 2 },
        {
          target: { by: "text", value: "Yes" },
          purpose: "confirm",
        },
      ),
    ).toEqual({ ok: false, reason: "confirm-without-logout" });
  });
});
