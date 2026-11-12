import { type LoginObservation } from "@pateat/contracts";
import { expect, it, vi } from "vitest";
import type { Handlers2Context } from "./context";

export function registerHandlers2(context: Handlers2Context) {
  const {
    connection,
    observation,
    request,
    recipeChange,
    setup,
    totp,
    handled,
    webauthn,
    completed,
  } = context;

  it.each([
    ["signed-in", completed],
    ["challenge", handled],
  ] as const)(
    "pulls only recipes after a %s judgement with a change, never a full sync",
    async (status, change) => {
      const h = setup();
      h.transport.judgeCompletion.mockResolvedValueOnce({
        kind: "result",
        result: { version: 1, status, change },
      });
      // A settings write would stop the login this page belongs to as a policy change.
      expect(
        (await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).verdict,
      ).toBe(status);
      await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
      expect(h.sync).not.toHaveBeenCalled();
    },
  );

  it("answers signed-in without a change and does not wait for the cache", async () => {
    const h = setup();
    h.refresh.mockImplementationOnce(() => new Promise<string>(() => {}));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "signed-in" },
    });
    expect(
      await h.generation.judge(recipeChange.recipeId, 3, "password", { ...observation, path: "/" }),
    ).toEqual({ verdict: "signed-in" });
    for (const reason of ["already-judged", "judgement-limit", "not-judgeable"] as const) {
      h.transport.judgeCompletion.mockResolvedValueOnce({
        kind: "result",
        result: { version: 1, status: "unavailable", reason },
      });
      // eslint-disable-next-line no-await-in-loop
      expect(await h.generation.judge(recipeChange.recipeId, 3, "password", webauthn)).toEqual({
        verdict: "unclear",
        reason,
      });
    }
  });

  it("offers the TOTP slot only for a page with a code field", async () => {
    const h = setup();
    expect(
      await h.generation.generate({ ...request, slots: [...request.slots, totp] }),
    ).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      request,
    );
    const coded: LoginObservation = {
      ...observation,
      path: "/verify",
      candidates: [
        ...observation.candidates,
        {
          id: "c2",
          role: "text",
          target: { by: "id", value: "code" },
          autocomplete: "one-time-code",
        },
      ],
    };
    const withCode = { ...request, observation: coded, slots: [...request.slots, totp] };
    expect(await h.generation.generate(withCode)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      withCode,
    );
  });

  it("sends no request whose only slot is a TOTP the page has no field for", async () => {
    const h = setup();
    expect(await h.generation.generate({ ...request, slots: [totp] })).toEqual({
      outcome: "skipped",
      reason: "no-slots",
    });
    expect(h.transport.generateRecipe).not.toHaveBeenCalled();
  });
}
