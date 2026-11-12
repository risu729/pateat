import { expect, it } from "vitest";
import type { ContinuationClaims1Context } from "./context";

export function registerContinuationClaims1(context: ContinuationClaims1Context) {
  const { observation, request, runs, setup, continuation, answerOf, sent } = context;

  it("keeps a continuation's claim apart from the first page's on the same path", async () => {
    const h = setup(answerOf(2));
    // The continuation first: the path's first page is still free, and the reverse.
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    // Each claim holds on its own.
    expect(await h.generation.generate(continuation)).toEqual(sent);
    expect(await h.generation.generate(request)).toEqual(sent);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
  });

  it("returns the current recipe the service answers for a stale base, pulling recipes only", async () => {
    // Another device continued revision 1 first; the service answers with its revision 3.
    const h = setup(answerOf(3));
    const answer = await h.generation.generate(continuation);
    expect(answer).toEqual({ outcome: "recipe", recipe: { ...runs, revision: 3 } });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("keys the claim by recipe as well as revision and path", async () => {
    const h = setup(answerOf(2));
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    const otherRecipe = {
      ...continuation,
      base: { recipeId: `gen-${"f".repeat(32)}`, revision: 1 },
    };
    expect(await h.generation.generate(otherRecipe)).toMatchObject({ outcome: "recipe" });
    const otherPath = {
      ...continuation,
      observation: { ...observation, path: "/login/password" },
    };
    expect(await h.generation.generate(otherPath)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });

  it("frees only the continuation's claim, never the first page's", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    h.transport.generateRecipe.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unavailable", reason: "busy" },
    });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "unavailable",
      reason: "busy",
      retry: true,
    });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(await h.generation.generate(request)).toEqual(sent);
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });
}
