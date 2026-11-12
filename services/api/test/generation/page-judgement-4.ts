import {
  type LoginObservation,
  type ObservedCandidate,
  type RecipeCompletionResult,
} from "@pateat/contracts";
import {
  completionBesidePromptVersion,
  completionPromptVersion,
  completionStopPromptVersion,
} from "@pateat/inference";
import { describe, expect, it, vi } from "vitest";
import { judgedInputs } from "@pateat/generation";
import type { PageJudgementContext, Device } from "./context";

export function registerPageJudgement4(context: PageJudgementContext) {
  const {
    element,
    observation,
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
    head,
    state,
  } = context;

  // ADR 0061: a page that still shows the route's sign-in form, as a sidebar behind a
  // lightbox, beside another form that asks for a detail. Synthetic page, shaped like a
  // card site's.
  describe("a page beside the sign-in form (ADR 0061)", () => {
    const inForm = (group: string, candidate: ObservedCandidate): ObservedCandidate => ({
      ...candidate,
      group,
    });
    const sidebar = passwordPage.candidates.map((candidate) => inForm("side", candidate));
    const birth = {
      ...inForm("box", element("birth", "text", "Birth year and month")),
      maxLength: 6,
    };
    const phone = {
      ...inForm("box", element("phone", "text", "Last 4 phone digits")),
      maxLength: 4,
    };
    const submit = inForm("box", element("submit", "button", "Log in"));
    const besidePage = observation("/password", [...sidebar, birth, phone, submit]);
    async function beside(
      device: Device,
      recipeId: string,
      revision: number,
      page: LoginObservation = besidePage,
      extra: Record<string, unknown> = {},
    ) {
      const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        revision,
        route: "password",
        observation: page,
        slots: [],
        beside: true,
        ...extra,
      });
      return {
        status: response.status,
        // A change's recipe as the judged layout's route, as `complete` answers it.
        body: projected((await response.json()) as RecipeCompletionResult | { error: string }),
      };
    }
    const besideRows = async (device: Device) =>
      rows(
        "SELECT revision, path, prompt_version, verdict FROM page_judgements WHERE owner_id = ? ORDER BY revision, path, prompt_version",
        device.ownerId,
      );
    const details = {
      details: [
        { field: "birth", value: "birth-date", format: "yyyymm" },
        { field: "phone", value: "phone-last-4" },
      ],
      detailSubmit: "submit",
    };

    it("still refuses the page from any other request, with no call", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const calls = state.sent.length;
      expect((await complete(device, change.recipeId, 2, besidePage)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
      expect(state.sent).toHaveLength(calls);
      expect(await besideRows(device)).toEqual([]);
    });

    it("keeps only a detail handler for the other form's inputs", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const key = inForm("box", element("passkey", "button", "Sign in with a passkey"));
      const code = {
        ...inForm("box", element("app-code", "text", "Authentication code")),
        autocomplete: "one-time-code" as const,
        inputMode: "numeric" as const,
        maxLength: 6,
      };
      const page = observation("/password", [...besidePage.candidates, key, code]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "passkey",
          code: { field: "app-code", submit: "submit", source: "authenticator-app" },
          ...details,
        }),
      );
      expect(await beside(device, change.recipeId, 2, page)).toMatchObject({
        status: 200,
        body: {
          version: 1,
          status: "challenge",
          change: {
            revision: 3,
            recipe: {
              steps: route(change.recipe).steps,
              handlers: [
                {
                  kind: "detail",
                  path: "/password",
                  fields: [
                    { detail: "birth-date", format: "yyyymm", target: birth.target },
                    { detail: "phone-last-4", target: phone.target },
                  ],
                  target: submit.target,
                },
              ],
            },
          },
        },
      });
      expect(await head(device, change.recipeId)).toBe(3);
      // The next revision's page on that path has its handler: never sent again.
      const before = state.sent.length;
      expect((await beside(device, change.recipeId, 3, page)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
      expect(state.sent).toHaveLength(before);
      // The passkey button and the code beside it are never learned there.
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [
          { kind: "passkey", kept: false, reason: "beside" },
          { kind: "totp", kept: false, reason: "beside" },
          { kind: "detail", kept: true },
        ],
      });
      info.mockRestore();
      // The model got the beside instructions, under their own prompt version.
      const [logged] = await rows(
        "SELECT request, prompt_version FROM inference_log WHERE owner_id = ? AND role = 'judge'",
        device.ownerId,
      );
      expect(logged!["prompt_version"]).toBe(await completionBesidePromptVersion());
      expect(logged!["prompt_version"]).not.toBe(await completionPromptVersion());
      expect(logged!["prompt_version"]).not.toBe(await completionStopPromptVersion());
      expect(JSON.parse(String(logged!.request))).toMatchObject({
        route: "password",
        beside: true,
        loginPaths: ["/login", "/password"],
      });
      expect(JSON.parse(String(logged!.request))).not.toHaveProperty("stop");
      expect(JSON.stringify(state.sent.at(-1)!.body)).toContain(
        "This page still shows the sign-in form Pateat filled",
      );
      expect(await besideRows(device)).toEqual([
        {
          revision: 2,
          path: "/password",
          prompt_version: await completionBesidePromptVersion(),
          verdict: "challenge",
        },
      ]);
    });

    it("keeps no marker, rejection or password button from the page", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const choose = inForm("box", element("choose-password", "button", "Use your password"));
      state.replies.push(judgeReply({ decision: "challenge", passwordButton: "choose-password" }));
      expect(
        (
          await beside(
            device,
            change.recipeId,
            2,
            observation("/password", [...besidePage.candidates, choose]),
          )
        ).body,
      ).toEqual({ version: 1, status: "unclear" });
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "password", kept: false, reason: "beside" }],
      });
      info.mockRestore();
      // A rejection is no rejection here.
      state.replies.push(judgeReply({ decision: "rejected" }));
      expect(
        (await beside(device, change.recipeId, 2, { ...besidePage, path: "/login" })).body,
      ).toEqual({ version: 1, status: "unclear" });
      expect(await head(device, change.recipeId)).toBe(2);
      expect((await besideRows(device)).map((row) => [row["path"], row["verdict"]]).sort()).toEqual(
        [
          ["/login", "unclear"],
          ["/password", "unclear"],
        ],
      );
      // Each path is judged once, as for any page.
      const calls = state.sent.length;
      expect((await beside(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "already-judged",
      });
      expect(state.sent).toHaveLength(calls);
    });

    it("keeps a challenge that adds no detail handler as undecided", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const key = inForm("box", element("passkey", "button", "Sign in with a passkey"));
      const code = {
        ...inForm("box", element("app-code", "text", "Authentication code")),
        autocomplete: "one-time-code" as const,
        inputMode: "numeric" as const,
        maxLength: 6,
      };
      const page = observation("/password", [...besidePage.candidates, key, code]);
      const besideVersion = await completionBesidePromptVersion();
      for (const [reply, handlers] of [
        // Only a passkey button and a code.
        [
          {
            decision: "challenge",
            passkeyButton: "passkey",
            code: { field: "app-code", submit: "submit", source: "authenticator-app" },
          },
          [
            { kind: "passkey", kept: false, reason: "beside" },
            { kind: "totp", kept: false, reason: "beside" },
          ],
        ],
        // Every detail dropped: no input of the page.
        [
          {
            decision: "challenge",
            details: [{ field: "missing", value: "phone-last-4" }],
            detailSubmit: "submit",
          },
          [{ kind: "detail", kept: false, reason: "unknown-field" }],
        ],
        // No handler named at all.
        [{ decision: "challenge" }, undefined],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- Each case has its own recipe.
        const device = await owner();
        // oxlint-disable-next-line no-await-in-loop -- Each case has its own recipe.
        const change = await twoPageRecipe(device);
        info.mockClear();
        state.replies.push(judgeReply(reply));
        // oxlint-disable-next-line no-await-in-loop -- Each page is judged on its own.
        expect((await beside(device, change.recipeId, 2, page)).body).toEqual({
          version: 1,
          status: "unclear",
        });
        if (handlers)
          expect(info).toHaveBeenCalledWith("Judged page handlers", {
            recipeId: change.recipeId,
            handlers,
          });
        else expect(info).not.toHaveBeenCalled();
        // oxlint-disable-next-line no-await-in-loop -- Each recipe is read on its own.
        expect(await head(device, change.recipeId)).toBe(2);
        // oxlint-disable-next-line no-await-in-loop -- Each recipe is read on its own.
        expect(await besideRows(device)).toEqual([
          {
            revision: 2,
            path: "/password",
            prompt_version: besideVersion,
            verdict: "unclear",
          },
        ]);
      }
      info.mockRestore();
    });

    it("fails closed on a signed-in answer while the password field shows", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(judgeReply({ decision: "signed-in", marker: "submit" }));
      expect((await beside(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "failed",
        error: "invalid-output",
      });
      expect(await head(device, change.recipeId)).toBe(2);
    });

    it("refuses a page without a form beside the route's fill field, or with a marker", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      await complete(device, change.recipeId, 2);
      const calls = state.sent.length;
      for (const page of [
        // No fill field of the route: such a page is sent without `beside`.
        observation("/password", [birth, phone, submit]),
        // The sign-in form alone.
        observation("/password", sidebar),
        // The other inputs in the sign-in form.
        observation("/password", [...sidebar, inForm("side", birth), inForm("side", phone)]),
        // No button in the other form.
        observation("/password", [...sidebar, birth, phone]),
        // A route fill field on a path that is no route path.
        { ...besidePage, path: "/elsewhere" },
        // A signed-in marker beside it.
        observation("/password", [...besidePage.candidates, element("logout", "button", "Out")]),
      ])
        // oxlint-disable-next-line no-await-in-loop -- Each page is sent on its own.
        expect((await beside(device, change.recipeId, 3, page)).body).toEqual({
          version: 1,
          status: "unavailable",
          reason: "not-judgeable",
        });
      // It is a password login's without a chooser or a stop, on the recipe's origin.
      for (const extra of [{ route: "passkey" }, { stop: true }, { branch: "account" }])
        // oxlint-disable-next-line no-await-in-loop -- Each request is sent on its own.
        expect((await beside(device, change.recipeId, 3, besidePage, extra)).status).toBe(400);
      expect(
        (
          await beside(device, change.recipeId, 3, {
            ...besidePage,
            origin: "https://www.example.test",
          })
        ).body,
      ).toEqual({ version: 1, status: "unavailable", reason: "not-judgeable" });
      expect(state.sent).toHaveLength(calls);
    });

    it("keeps the current beside judge's rows when another page purges older ones", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      await seed(device, change.recipeId, 2, "/password", dayStart() - 1, {
        promptVersion: await completionBesidePromptVersion(),
        verdict: "challenge",
        inputs: await judgedInputs(besidePage),
      });
      await seed(device, change.recipeId, 2, "/earlier-judge", dayStart() - 1);
      state.replies.push(judgeReply({ decision: "rejected" }));
      await complete(device, change.recipeId, 2);
      expect(await judgements(device)).toEqual([
        { recipe_id: change.recipeId, revision: 2, path: "/home" },
        { recipe_id: change.recipeId, revision: 2, path: "/password" },
      ]);
      // And the page's own repeat is answered from it, with no call.
      const calls = state.sent.length;
      expect((await beside(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-challenge",
      });
      expect(state.sent).toHaveLength(calls);
    });
  });
}
