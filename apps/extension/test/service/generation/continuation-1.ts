import { expect, it } from "vitest";
import { GENERATION_RETRY_MS } from "../../../src/service/generation";
import type { Continuation1Context } from "./context";

export function registerContinuation1(context: Continuation1Context) {
  const { connection, observation, request, runs, setup, base, continuation, continued } = context;

  it("returns the continued recipe after pulling recipes only", async () => {
    const h = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: continued },
    });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "recipe",
      recipe: { ...runs, revision: 2 },
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      continuation,
    );
    // A full sync could write settings and stop the login it belongs to.
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("claims the page under the revision it continues, not its path alone", async () => {
    const h = setup();
    // The first page of the path was sent today; its continuation is a separate claim.
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "skipped",
      reason: "sent",
    });
    // A later revision of the recipe is a new claim; the path's own claim stays.
    expect(
      await h.generation.generate({ ...continuation, base: { ...base, revision: 2 } }),
    ).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
    h.advance(GENERATION_RETRY_MS);
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
  });

  it.each(["recipe-revoked", "recipe-conflict"] as const)(
    "spends a continuation answered %s, which a later document would get again",
    async (reason) => {
      const h = setup({
        kind: "result",
        result: { version: 1, status: "unavailable", reason },
      });
      expect(await h.generation.generate(continuation)).toEqual({
        outcome: "unavailable",
        reason,
      });
      // A recipe's first page with the same answer stays free to send again.
      expect(await h.generation.generate(request)).toEqual({
        outcome: "unavailable",
        reason,
        retry: true,
      });
    },
  );
}
