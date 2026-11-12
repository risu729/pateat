import { expect, it } from "vitest";
import type { Timing1Context } from "./context";

export function registerTiming1(context: Timing1Context) {
  const { observation, request, recipeChange, entryRequest, setup, timing } = context;

  it("passes each answered request's timing on with its outcome", async () => {
    const recipe = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
      timing,
    });
    expect(await recipe.generation.generate(request)).toMatchObject({ outcome: "recipe", timing });
    const abstained = setup({
      kind: "result",
      result: { version: 1, status: "abstained", reason: "no-login-form" },
      timing,
    });
    expect(await abstained.generation.generate(request)).toEqual({
      outcome: "abstained",
      reason: "no-login-form",
      timing,
    });
    const unreachable = setup(undefined, {
      kind: "failed",
      error: "unreachable",
      timing: { roundTripMs: 30 },
    });
    expect(await unreachable.generation.generateEntry(entryRequest)).toEqual({
      outcome: "failed",
      reason: "unreachable",
      retry: true,
      timing: { roundTripMs: 30 },
    });
    const judged = setup();
    judged.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge" },
      timing,
    });
    expect(
      await judged.generation.judge(recipeChange.recipeId, 1, "password", {
        ...observation,
        path: "/home",
      }),
    ).toEqual({ verdict: "challenge", timing });
  });

  it("has no timing for a page that was never sent", async () => {
    const h = setup();
    h.service.connection.mockResolvedValue(undefined);
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
  });
}
