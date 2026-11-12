import { continuesRecipe } from "@pateat/contracts";
import { expect, it } from "vitest";
import { appendPageSteps } from "../../src/assemble";
import type { ReplacedAdvanceContext } from "./context";

export function registerReplacedAdvanceCases({
  origin,
  target,
  page,
  built,
  first,
  password,
  submit,
  replace,
}: ReplacedAdvanceContext) {
  it("drops the final click and appends the page's steps in its place", () => {
    const next = replace([password, submit]);
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe).toMatchObject({
      revision: 2,
      slots: ["username", "password"],
      maxSubmissions: 1,
      steps: [first.steps[0], password, submit],
    });
    expect(continuesRecipe(first, next.recipe, { replacesLast: true })).toBe(true);
    expect(continuesRecipe(first, next.recipe)).toBe(false);
  });

  it("refuses steps without a password, ending elsewhere, or filling the email again", () => {
    for (const steps of [
      [submit],
      [password, { ...submit, target: target("continue") }],
      [password, submit, password],
      [submit, password, submit],
    ])
      expect(replace(steps)).toEqual({ ok: false, reason: "invalid-recipe" });
    expect(replace([first.steps[0]!, password, submit])).toEqual({
      ok: false,
      reason: "slot-refilled",
    });
  });

  it("refuses a first page, and a base that submits", () => {
    expect(
      appendPageSteps(undefined, {
        pageKind: "sign-in",
        id: "gen-1",
        origin,
        steps: [password, submit],
        replacesLast: true,
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
    expect(replace([password, submit], built(page("/login", "username", "submit")))).toEqual({
      ok: false,
      reason: "not-advancing",
    });
  });
}
