import { expect, it } from "vitest";
import type { Handlers1Context } from "./context";

export function registerHandlers1(context: Handlers1Context) {
  const { connection, KEY, chooserOf, recipeChange, setup, handledRuns, handled, webauthn } =
    context;

  it("hands a judged handler's recipe to the login without waiting for the cache", async () => {
    const h = setup();
    h.refresh.mockImplementationOnce(() => new Promise<string>(() => {}));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: handled },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).toEqual({
      verdict: "challenge",
      recipe: handledRuns,
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: webauthn,
        slots: [],
      },
    );
    // A failed refresh still hands the recipe over; the login checks it before use.
    h.refresh.mockRejectedValueOnce(new Error("offline"));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: handled },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).toEqual({
      verdict: "challenge",
      recipe: handledRuns,
    });
  });

  // Owner, 2026-10-23: the same information goes to every model call unless there is a
  // sound reason, so the judge gets the account's slots as generation does.
  it("sends the account's slots, the TOTP slot only with a code field, and hands the pairings over", async () => {
    const h = setup();
    const slots = [
      { id: "username", kind: "identifier" as const, description: "account username" },
      { id: "totp", kind: "one-time-code" as const, description: "one-time authentication code" },
      {
        id: "custom-1",
        kind: "hidden" as const,
        description: "concealed value of the user's vault field named in fieldName, such as a PIN",
        fieldName: "お母さんの旧姓",
      },
    ];
    const questions = [
      { field: { by: "id" as const, value: "answer" }, slot: "custom-1", shown: "母親の旧姓は？" },
    ];
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: handled, questions },
    });
    expect(
      await h.generation.judge(
        recipeChange.recipeId,
        1,
        "password",
        webauthn,
        undefined,
        undefined,
        undefined,
        undefined,
        slots,
      ),
    ).toEqual({ verdict: "challenge", recipe: handledRuns, questions });
    // The page shows no code field, so `totp` stays out (ADR 0027).
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: webauthn,
        slots: [slots[0], slots[2]],
      },
    );
    const coded = {
      ...webauthn,
      candidates: [
        ...webauthn.candidates,
        {
          id: "code",
          role: "text" as const,
          target: { by: "id" as const, value: "code" },
          autocomplete: "one-time-code" as const,
        },
      ],
    };
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unclear" },
    });
    await h.generation.judge(
      recipeChange.recipeId,
      1,
      "password",
      coded,
      undefined,
      undefined,
      undefined,
      undefined,
      slots,
    );
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      expect.objectContaining({ slots }),
    );
  });

  it("judges a chooser login's page on its branch and hands the chooser over (ADR 0028)", async () => {
    const h = setup();
    const runsChooser = {
      version: 1 as const,
      id: handledRuns.id,
      revision: handledRuns.revision,
      origin: handledRuns.origin,
      layout: KEY,
      chooser: { path: "/login", afterAccount: handledRuns },
    };
    const chooser = { ...handled, recipe: chooserOf(runsChooser) };
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: chooser },
    });
    expect(
      await h.generation.judge(
        recipeChange.recipeId,
        1,
        "password",
        webauthn,
        undefined,
        `${KEY}:account`,
      ),
    ).toEqual({ verdict: "challenge", recipe: runsChooser });
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: `${KEY}:account`,
        observation: webauthn,
        slots: [],
      },
    );
    // A route login never takes a chooser over.
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: chooser },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).toEqual({
      verdict: "challenge",
    });
  });
}
