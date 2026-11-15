import { expect, it, vi } from "vitest";
import type { ServiceGenerationTestContext } from "./context";
import { type LoginObservation } from "@pateat/contracts";

export function registerJudgedHandlerCases({
  connection,
  KEY,
  chooserOf,
  recipeChange,
  setup,
  handledRuns,
  handled,
  webauthn,
}: Pick<
  ServiceGenerationTestContext,
  | "connection"
  | "KEY"
  | "chooserOf"
  | "recipeChange"
  | "setup"
  | "handledRuns"
  | "handled"
  | "webauthn"
>) {
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

export function registerJudgementAnswerCases({
  connection,
  observation,
  request,
  recipeChange,
  setup,
  totp,
  handled,
  webauthn,
  completed,
}: Pick<
  ServiceGenerationTestContext,
  | "connection"
  | "observation"
  | "request"
  | "recipeChange"
  | "setup"
  | "totp"
  | "handled"
  | "webauthn"
  | "completed"
>) {
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
