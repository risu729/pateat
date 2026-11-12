import { type LoginObservation, type RecipeCompletionResult } from "@pateat/contracts";
import { exports } from "cloudflare:workers";
import { completionPromptVersion, completionStopPromptVersion } from "@pateat/inference";
import { describe, expect, it, vi } from "vitest";
import { judgedInputs, staleHead } from "@pateat/generation";
import type { PageJudgementContext, Device } from "./context";

export function registerPageJudgement3(context: PageJudgementContext) {
  const {
    element,
    observation,
    emailPage,
    passwordPage,
    route,
    owner,
    post,
    projected,
    complete,
    rows,
    twoPageRecipe,
    judgeReply,
    dayStart,
    judgements,
    seed,
    seedUsage,
    head,
    state,
  } = context;

  describe("detail handlers (ADR 0061)", () => {
    // A synthetic page that asks for the birth year and month or a phone's last 4 digits.
    const birth = { ...element("birth", "text", "Year and month of birth"), maxLength: 6 };
    const phone = { ...element("phone", "tel", "Last 4 digits of your phone"), maxLength: 4 };
    const cardCode = element("card-code", "text", "Security code");
    const confirm = element("confirm", "button", "Next");
    const details = [
      { field: "birth", value: "birth-date", format: "yyyymm" },
      { field: "phone", value: "phone-last-4" },
    ];

    it("keeps the inputs that pass their checks with their button, and logs each dropped one", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      state.replies.push(
        judgeReply({
          decision: "challenge",
          // A security code in a text input without a length is no detail input.
          details: [...details, { field: "card-code", value: "card-code" }],
          detailSubmit: "confirm",
        }),
      );
      const page = observation("/login/confirm", [birth, phone, cardCode, confirm]);
      expect((await complete(device, change.recipeId, 2, page)).body).toMatchObject({
        status: "challenge",
        change: {
          revision: 3,
          recipe: {
            revision: 3,
            steps: route(change.recipe).steps,
            handlers: [
              {
                kind: "detail",
                path: "/login/confirm",
                fields: [
                  { detail: "birth-date", format: "yyyymm", target: { by: "id", value: "birth" } },
                  { detail: "phone-last-4", target: { by: "id", value: "phone" } },
                ],
                target: { by: "id", value: "confirm" },
              },
            ],
          },
        },
      });
      expect(await head(device, change.recipeId)).toBe(3);
      // Kinds and reasons only: never an element, label or value.
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [
          { kind: "detail", kept: true },
          { kind: "detail", kept: false, reason: "not-input" },
        ],
      });
      info.mockRestore();
    });

    describe("with the account's slots (owner 2026-10-23)", () => {
      // A synthetic secret question whose answer field the owner named otherwise.
      const answer = { ...element("answer", "text", "母親の旧姓は？") };
      const accountSlots = [
        { id: "username", kind: "identifier", description: "account username" },
        {
          id: "custom-1",
          kind: "hidden",
          description:
            "concealed value of the user's vault field named in fieldName, such as a PIN",
          fieldName: "お母さんの旧姓",
        },
      ];
      const asked = (recipeId: string, revision: number, extra: object = {}) =>
        post(device!, `/v1/recipes/${recipeId}/completion`, {
          version: 1,
          revision,
          route: "password",
          observation: observation("/login/question", [answer, confirm]),
          slots: accountSlots,
          ...extra,
        });
      let device: Device | undefined;
      const paired = {
        decision: "challenge",
        details: [{ field: "answer", value: "secret-answer", slot: 1, shown: "母親の旧姓は？" }],
        detailSubmit: "confirm",
      };

      it("sends and logs them, and answers the pairing without storing a field name", async () => {
        device = await owner();
        const change = await twoPageRecipe(device);
        const calls = state.sent.length;
        state.replies.push(judgeReply(paired));
        const response = await asked(change.recipeId, 2);
        expect(response.status).toBe(200);
        // The change's recipe as the judged layout's route (ADR 0060).
        const body = projected((await response.json()) as RecipeCompletionResult);
        expect(body).toMatchObject({
          status: "challenge",
          change: {
            revision: 3,
            recipe: {
              handlers: [
                {
                  kind: "detail",
                  path: "/login/question",
                  fields: [{ detail: "secret-answer", target: { by: "id", value: "answer" } }],
                  target: { by: "id", value: "confirm" },
                },
              ],
            },
          },
          questions: [
            { field: { by: "id", value: "answer" }, slot: "custom-1", shown: "母親の旧姓は？" },
          ],
        });
        // The model got the slots, as a generation request carries them.
        expect(state.sent).toHaveLength(calls + 1);
        expect(JSON.stringify(state.sent.at(-1)!.body)).toContain(
          JSON.stringify(JSON.stringify(accountSlots)).slice(1, -1),
        );
        // The shared recipe, its feed and its revisions never hold the field's name.
        const stored = await rows(
          "SELECT document FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ?",
          device.ownerId,
          change.recipeId,
        );
        expect(JSON.stringify(stored)).not.toContain("お母さんの旧姓");
        const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
          headers: { Authorization: `Bearer ${device.token}` },
        });
        expect(JSON.stringify(await feed.json())).not.toContain("お母さんの旧姓");
        // The request log keeps the slots like a generation request's.
        const [logged] = await rows(
          "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY created_at DESC",
          device.ownerId,
        );
        expect(JSON.parse(String(logged!.request))).toMatchObject({ slots: accountSlots });
      });

      it("answers no pairing for a stop's page, which keeps no detail handler", async () => {
        device = await owner();
        const change = await twoPageRecipe(device);
        state.replies.push(judgeReply(paired));
        const response = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
          version: 1,
          revision: 2,
          route: "password",
          stop: true,
          observation: observation("/password", [
            element("password", "password", "Password"),
            answer,
            confirm,
          ]),
          slots: accountSlots,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ version: 1, status: "challenge" });
      });

      it("answers no pairing when no detail handler is kept", async () => {
        device = await owner();
        const change = await twoPageRecipe(device);
        // The path's handler is learned first without a pairing.
        state.replies.push(
          judgeReply({ ...paired, details: [{ field: "answer", value: "secret-answer" }] }),
        );
        const first = await asked(change.recipeId, 2);
        expect(await first.json()).toMatchObject({ status: "challenge", change: { revision: 3 } });
        // Judged again on the next revision, the judge keeps the input, but the path has its
        // handler already, so no handler is kept and nothing is paired.
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        state.replies.push(judgeReply(paired));
        const response = await asked(change.recipeId, 3);
        expect(await response.json()).toEqual({ version: 1, status: "challenge" });
        expect(info).toHaveBeenCalledWith("Judged page handlers", {
          recipeId: change.recipeId,
          handlers: [{ kind: "detail", kept: false, reason: "duplicate" }],
        });
        info.mockRestore();
      });
    });

    it("keeps a detail beside a passkey handler in one revision", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "key",
          details: [details[1]],
          detailSubmit: "confirm",
        }),
      );
      const page = observation("/login/confirm", [
        phone,
        confirm,
        element("key", "button", "Use security key"),
      ]);
      const judged = await complete(device, change.recipeId, 2, page);
      expect(judged.body).toMatchObject({ status: "challenge", change: { revision: 3 } });
      if (!("change" in judged.body) || !judged.body.change) throw new Error("no change");
      expect(route(judged.body.change.recipe).handlers?.map((handler) => handler.kind)).toEqual([
        "passkey",
        "detail",
      ]);
    });

    it("answers a plain challenge when no input passes, logging why", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      state.replies.push(
        judgeReply({
          decision: "challenge",
          details: [{ field: "birth", value: "birth-date" }, details[1]],
          detailSubmit: "missing",
        }),
      );
      const page = observation("/login/confirm", [birth, phone, confirm]);
      expect((await complete(device, change.recipeId, 2, page)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      expect(await head(device, change.recipeId)).toBe(2);
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [
          { kind: "detail", kept: false, reason: "unknown-submit" },
          { kind: "detail", kept: false, reason: "unknown-submit" },
        ],
      });
      info.mockRestore();
    });
  });

  it("names a revoked, moved or missing head as stale", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    expect(staleHead(change, 2)).toBeUndefined();
    const revoked = { recipeId: change.recipeId, revision: 3, state: "revoked" } as const;
    expect(staleHead(revoked, 2)).toBe("recipe-revoked");
    expect(staleHead(change, 1)).toBe("recipe-conflict");
    expect(staleHead(null, 2)).toBe("recipe-conflict");
  });

  it("makes one model call for a page sent again while it is judged", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = state.sent.length;
    let concurrent: unknown;
    state.during = async () => {
      concurrent = (await complete(device, change.recipeId, 2)).body;
    };
    state.replies.push(judgeReply({ decision: "rejected" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    // The first request's row, written before its model call, answers the second while
    // the first is judged (ADR 0029).
    expect(concurrent).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judgement-unanswered",
    });
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      reason: "judged-rejected",
    });
    expect(state.sent).toHaveLength(calls + 1);
  });

  it("sends a page that two requests got past the gate with at once only once", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = state.sent.length;
    // Both requests wait at the token exchange, after their gates, until both are there.
    let arrived = 0;
    let bothGated!: () => void;
    const gated = new Promise<void>((resolve) => {
      bothGated = resolve;
    });
    state.tokenHook = async () => {
      arrived += 1;
      if (arrived === 2) bothGated();
      await gated;
    };
    let release!: () => void;
    state.held = new Promise((resolve) => {
      release = resolve;
    });
    state.replies.push(judgeReply({ decision: "rejected" }));
    const requests = [complete(device, change.recipeId, 2), complete(device, change.recipeId, 2)];
    try {
      // The request that did not take the page's row answers without a model call while
      // the other one is still judged (ADR 0018).
      expect((await Promise.race(requests)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judgement-unanswered",
      });
      expect(arrived).toBe(2);
    } finally {
      release();
    }
    expect((await Promise.all(requests)).map(({ body }) => body)).toEqual(
      expect.arrayContaining([
        { version: 1, status: "rejected" },
        { version: 1, status: "unavailable", reason: "judgement-unanswered" },
      ]),
    );
    expect(state.sent).toHaveLength(calls + 1);
    expect(
      await rows(
        "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/home'",
        device.ownerId,
      ),
    ).toEqual([{ verdict: "rejected" }]);
  });

  // Owner, 2026-10-13 05:39 UTC: a login of an item without a password but with a passkey
  // that stops before the password has that page judged for a passkey button beside the
  // password field (ADR 0036).
  describe("a page at a login's stop before a missing password (ADR 0036)", () => {
    const passkey = element("passkey", "button", "Sign in with a passkey");
    const stopPage = observation("/password", [
      ...passwordPage.candidates,
      passkey,
      element("add-passkey", "button", "Add a passkey"),
    ]);
    async function atStop(
      device: Device,
      recipeId: string,
      revision: number,
      page: LoginObservation = stopPage,
      extra: Record<string, unknown> = {},
    ) {
      const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        slots: [],
        revision,
        route: "password",
        observation: page,
        stop: true,
        ...extra,
      });
      return {
        status: response.status,
        body: projected((await response.json()) as RecipeCompletionResult | { error: string }),
      };
    }
    const stopRows = async (device: Device) =>
      rows(
        "SELECT revision, path, prompt_version, verdict FROM page_judgements WHERE owner_id = ? ORDER BY revision, path, prompt_version",
        device.ownerId,
      );

    it("still refuses the sign-in page from any other request, with no call", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const calls = state.sent.length;
      for (const page of [stopPage, emailPage, passwordPage])
        // oxlint-disable-next-line no-await-in-loop -- Each page is sent on its own.
        expect((await complete(device, change.recipeId, 2, page)).body).toEqual({
          version: 1,
          status: "unavailable",
          reason: "not-judgeable",
        });
      expect(state.sent).toHaveLength(calls);
      expect(await stopRows(device)).toEqual([]);
    });

    it("keeps only a passkey handler for the button beside the password field", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const code = {
        ...element("app-code", "text", "Authentication code"),
        autocomplete: "one-time-code" as const,
        inputMode: "numeric" as const,
        maxLength: 6,
      };
      const page = observation("/password", [
        ...stopPage.candidates,
        code,
        element("choose-password", "button", "Use your password"),
      ]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "passkey",
          passwordButton: "choose-password",
          code: { field: "app-code", submit: "sign-in", source: "authenticator-app" },
        }),
      );
      const judged = await atStop(device, change.recipeId, 2, page);
      expect(judged).toMatchObject({
        status: 200,
        body: {
          version: 1,
          status: "challenge",
          change: {
            revision: 3,
            recipe: {
              steps: route(change.recipe).steps,
              handlers: [{ kind: "passkey", path: "/password", target: passkey.target }],
            },
          },
        },
      });
      expect(await head(device, change.recipeId)).toBe(3);
      // The next revision's stop page on that path has its handler: never sent again.
      const before = state.sent.length;
      expect((await atStop(device, change.recipeId, 3, page)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
      expect(state.sent).toHaveLength(before);
      // The code beside it is never learned there, and the log says so without elements.
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [
          { kind: "passkey", kept: true },
          { kind: "password", kept: false, reason: "stop" },
          { kind: "totp", kept: false, reason: "stop" },
        ],
      });
      info.mockRestore();
      // The model got the stop's instructions, under their own prompt version.
      const [logged] = await rows(
        "SELECT request, prompt_version FROM inference_log WHERE owner_id = ? AND role = 'judge'",
        device.ownerId,
      );
      expect(logged!["prompt_version"]).toBe(await completionStopPromptVersion());
      expect(logged!["prompt_version"]).not.toBe(await completionPromptVersion());
      expect(JSON.parse(String(logged!.request))).toMatchObject({
        route: "password",
        stop: true,
        loginPaths: ["/login", "/password"],
      });
      expect(JSON.stringify(state.sent.at(-1)!.body)).toContain(
        "This sign-in page still shows its password field",
      );
      expect(await stopRows(device)).toEqual([
        {
          revision: 2,
          path: "/password",
          prompt_version: await completionStopPromptVersion(),
          verdict: "challenge",
        },
      ]);
    });

    it("keeps no detail handler for inputs beside the password field (ADR 0061)", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const page = observation("/password", [
        ...stopPage.candidates,
        { ...element("phone", "tel", "Last 4 digits of your phone"), maxLength: 4 },
        { ...element("birth", "text", "Year and month of birth"), maxLength: 6 },
        element("confirm", "button", "Next"),
      ]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "passkey",
          // One input that passes, and one that its local checks drop.
          details: [
            { field: "phone", value: "phone-last-4" },
            { field: "birth", value: "birth-date" },
          ],
          detailSubmit: "confirm",
        }),
      );
      expect(await atStop(device, change.recipeId, 2, page)).toMatchObject({
        status: 200,
        body: {
          version: 1,
          status: "challenge",
          change: {
            revision: 3,
            recipe: { handlers: [{ kind: "passkey", path: "/password", target: passkey.target }] },
          },
        },
      });
      // The kept detail is logged as refused at the stop; the dropped input is not logged.
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [
          { kind: "passkey", kept: true },
          { kind: "detail", kept: false, reason: "stop" },
        ],
      });
      info.mockRestore();
    });

    it("answers a plain challenge for a stop's page that asks only for a detail", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const page = observation("/password", [
        ...stopPage.candidates,
        { ...element("phone", "tel", "Last 4 digits of your phone"), maxLength: 4 },
        element("confirm", "button", "Next"),
      ]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          details: [{ field: "phone", value: "phone-last-4" }],
          detailSubmit: "confirm",
        }),
      );
      expect((await atStop(device, change.recipeId, 2, page)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      expect(await head(device, change.recipeId)).toBe(2);
    });

    it("keeps no marker, rejection or registration button from the stop's page", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // A button that adds a passkey is refused as on any page.
      state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "add-passkey" }));
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      // A rejection is no rejection here, and a marker beside the password field fails
      // closed as on any sign-in page.
      state.replies.push(judgeReply({ decision: "rejected" }));
      expect(
        (await atStop(device, change.recipeId, 2, { ...stopPage, path: "/password/retry" })).body,
      ).toEqual({ version: 1, status: "unclear" });
      state.replies.push(judgeReply({ decision: "signed-in", marker: "passkey" }));
      expect(
        (await atStop(device, change.recipeId, 2, { ...stopPage, path: "/password/again" })).body,
      ).toEqual({ version: 1, status: "failed", error: "invalid-output" });
      expect(await head(device, change.recipeId)).toBe(2);
      expect((await stopRows(device)).map((row) => [row["path"], row["verdict"]]).sort()).toEqual([
        ["/password", "challenge"],
        ["/password/again", null],
        ["/password/retry", "unclear"],
      ]);
      // Each path is judged once, as for any page: a later stop's page is not sent again.
      const calls = state.sent.length;
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-challenge",
      });
      expect(state.sent).toHaveLength(calls);
    });

    it("refuses a stop's page without the route's password field, or with a marker", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      await complete(device, change.recipeId, 2);
      const calls = state.sent.length;
      for (const page of [
        // No password field of the route: not a stop's page.
        observation("/password", [passkey, element("help", "link", "Help")]),
        emailPage,
        // Another password input than the route's.
        observation("/password", [element("other-password", "password", "Password"), passkey]),
        // The password field beside a signed-in marker.
        observation("/password", [...stopPage.candidates, element("logout", "button", "Out")]),
      ])
        // oxlint-disable-next-line no-await-in-loop -- Each page is sent on its own.
        expect((await atStop(device, change.recipeId, 3, page)).body).toEqual({
          version: 1,
          status: "unavailable",
          reason: "not-judgeable",
        });
      // A stop is a password login's, on the recipe's origin.
      expect(
        (await atStop(device, change.recipeId, 3, stopPage, { route: "passkey" })).status,
      ).toBe(400);
      expect(
        (
          await atStop(device, change.recipeId, 3, {
            ...stopPage,
            origin: "https://www.example.test",
          })
        ).body,
      ).toEqual({ version: 1, status: "unavailable", reason: "not-judgeable" });
      expect(state.sent).toHaveLength(calls);
    });

    it("keeps a stop's judgements apart from other pages' of the path, within the day's 20", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(judgeReply({ decision: "challenge" }));
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      // A code page on the same path after a password is still judged, and may learn its
      // handler: the stop's row does not answer it.
      const codePage = observation("/password", [
        {
          ...element("app-code", "text", "Authentication code"),
          autocomplete: "one-time-code" as const,
          inputMode: "numeric" as const,
          maxLength: 6,
        },
        element("verify", "button", "Verify"),
      ]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          code: { field: "app-code", submit: "verify", source: "authenticator-app" },
        }),
      );
      expect((await complete(device, change.recipeId, 2, codePage)).body).toMatchObject({
        status: "challenge",
        change: { revision: 3, recipe: { handlers: [{ kind: "totp", path: "/password" }] } },
      });
      // A stop's judgement counts toward the recipe's 20 a day.
      for (let index = 0; index < 18; index++)
        // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
        await seedUsage(device, change.recipeId, 3, `/p${index}`, dayStart() + index);
      const calls = state.sent.length;
      expect((await atStop(device, change.recipeId, 3)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judgement-limit",
      });
      expect(state.sent).toHaveLength(calls);
    });

    it("keeps the current stop judge's rows when another page purges older ones", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const stopVersion = await completionStopPromptVersion();
      await seed(device, change.recipeId, 2, "/password", dayStart() - 1, {
        promptVersion: stopVersion,
        verdict: "challenge",
        inputs: await judgedInputs(stopPage),
      });
      await seed(device, change.recipeId, 2, "/earlier-judge", dayStart() - 1);
      state.replies.push(judgeReply({ decision: "rejected" }));
      await complete(device, change.recipeId, 2);
      expect(await judgements(device)).toEqual([
        { recipe_id: change.recipeId, revision: 2, path: "/home" },
        { recipe_id: change.recipeId, revision: 2, path: "/password" },
      ]);
      // And the stop's own repeat is answered from it, with no call.
      const calls = state.sent.length;
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-challenge",
      });
      expect(state.sent).toHaveLength(calls);
    });
  });
}
