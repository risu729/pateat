import { completionPromptVersion } from "@pateat/inference";
import { describe, expect, it, vi } from "vitest";
import { judgedInputs } from "@pateat/generation";
import type { PageJudgementContext, Device } from "./context";

export function registerPageJudgement2(context: PageJudgementContext) {
  const {
    element,
    observation,
    emailPage,
    passwordPage,
    homePage,
    bigPage,
    route,
    plan,
    owner,
    post,
    generate,
    complete,
    rows,
    logRows,
    twoPageRecipe,
    judgeReply,
    webauthnPage,
    dayStart,
    judgements,
    seed,
    seedUsage,
    head,
    state,
  } = context;

  it("judges a path again once the judge changed", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    // An earlier judge judged the page `challenge` and kept no handler, as for a code split
    // into one-digit inputs before those were learned.
    await seed(device, change.recipeId, 2, "/login/webauthn", dayStart(), {
      verdict: "challenge",
    });
    const calls = state.sent.length;
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    expect((await complete(device, change.recipeId, 2, webauthnPage)).body).toMatchObject({
      status: "challenge",
      change: { revision: 3 },
    });
    expect(state.sent).toHaveLength(calls + 1);
    // The earlier row keeps its verdict beside the new one.
    expect(
      await rows(
        "SELECT prompt_version, verdict FROM page_judgements WHERE owner_id = ? AND path = ? ORDER BY prompt_version",
        device.ownerId,
        "/login/webauthn",
      ),
    ).toEqual([
      { prompt_version: "", verdict: "challenge" },
      { prompt_version: await completionPromptVersion(), verdict: "challenge" },
    ]);
    // The current judge's own verdict on the same inputs still stops a repeat.
    await seed(device, change.recipeId, 3, "/home", dayStart(), {
      promptVersion: await completionPromptVersion(),
      verdict: "challenge",
      inputs: await judgedInputs(homePage),
    });
    expect((await complete(device, change.recipeId, 3)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(state.sent).toHaveLength(calls + 1);
  });

  it("gives an oversized page back without a verdict row or a judgement of the day", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = state.sent.length;
    const big = bigPage();
    const refused = { version: 1, status: "failed", error: "input-too-large" };
    expect(await complete(device, change.recipeId, 2, big)).toEqual({ status: 200, body: refused });
    expect(state.sent).toHaveLength(calls);
    // Nothing reached the model, so the page gives the judgement back (ADR 0027): its
    // resend is refused locally again, not `judgement-unanswered`, and no row holds the
    // path without a verdict or counts toward the recipe's 20 a day.
    expect((await complete(device, change.recipeId, 2, big)).body).toEqual(refused);
    expect(state.sent).toHaveLength(calls);
    expect(await judgements(device)).toEqual([]);
  });

  it("judges a recipe at most 20 times a UTC day, whatever the path", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = state.sent.length;
    for (let index = 0; index < 20; index++)
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seedUsage(device, change.recipeId, 1, `/p${index}`, dayStart() + index);
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judgement-limit",
    });
    expect(state.sent).toHaveLength(calls);
  });

  it("counts only this recipe's judgements of the current UTC day", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    for (let index = 0; index < 19; index++)
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seedUsage(device, change.recipeId, 2, `/today-${index}`, dayStart() + index);
    for (let index = 0; index < 5; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seedUsage(device, change.recipeId, 2, `/yesterday-${index}`, dayStart() - 1 - index);
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seedUsage(device, "gen-other", 1, `/other-${index}`, dayStart() + index);
    }
    state.replies.push(judgeReply({ decision: "rejected" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    // That was the 20th today; the next page waits for the next UTC day.
    expect(
      (await complete(device, change.recipeId, 2, { ...homePage, path: "/welcome" })).body,
    ).toMatchObject({ reason: "judgement-limit" });
  });

  it.each(["optional", "partial", "challenge", "unclear"] as const)(
    "stops provider dispatch after twenty %s overwrites of one page",
    async (kind) => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const calls = state.sent.length;
      /* oxlint-disable no-await-in-loop -- Each login depends on the previous page verdict. */
      for (let index = 0; index < 20; index++) {
        const page = {
          ...homePage,
          candidates: [
            ...homePage.candidates,
            ...(kind === "challenge" || kind === "unclear"
              ? [element(`extra-${index}`, "text", "Synthetic field")]
              : []),
          ],
        };
        state.replies.push(judgeReply({ decision: kind === "partial" ? "optional" : kind }));
        expect(
          (
            await complete(
              device,
              change.recipeId,
              2,
              page,
              kind === "partial" && index % 2 === 0 ? true : undefined,
            )
          ).body,
        ).toMatchObject({ status: kind === "partial" ? "optional" : kind });
      }
      /* oxlint-enable no-await-in-loop */
      expect(state.sent).toHaveLength(calls + 20);
      expect(
        (
          await complete(device, change.recipeId, 2, {
            ...homePage,
            candidates: [...homePage.candidates, element("extra-next", "text", "Synthetic field")],
          })
        ).body,
      ).toMatchObject({ status: "unavailable", reason: "judgement-limit" });
      expect(state.sent).toHaveLength(calls + 20);
      expect(
        await rows(
          "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/home'",
          device.ownerId,
        ),
      ).toEqual([{ verdict: kind === "partial" ? "optional" : kind }]);
      expect(
        await rows(
          "SELECT count(*) AS n FROM judgement_reservations WHERE owner_id = ? AND state != 'cancelled'",
          device.ownerId,
        ),
      ).toEqual([{ n: 20 }]);
    },
  );

  it("serves a cached judgement at the daily cap without charging or replacing it", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "rejected" }));
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({ status: "rejected" });
    await Promise.all(
      Array.from({ length: 19 }, (_, index) =>
        seedUsage(device, change.recipeId, 1, `/quota-${index}`, dayStart() + index),
      ),
    );

    const calls = state.sent.length;
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      status: "unavailable",
      reason: "judged-rejected",
    });
    expect(state.sent).toHaveLength(calls);
    expect(
      await rows(
        "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/home'",
        device.ownerId,
      ),
    ).toEqual([{ verdict: "rejected" }]);
    expect(
      await rows(
        "SELECT count(*) AS n FROM judgement_reservations WHERE owner_id = ? AND state != 'cancelled'",
        device.ownerId,
      ),
    ).toEqual([{ n: 20 }]);
  });

  it.each(["provider-error", "invalid-output", "uncertain-send"] as const)(
    "retains the daily debit after %s",
    async (failure) => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const calls = state.sent.length;
      state.replies.push(failure === "invalid-output" ? { text: "not valid JSON" } : 500);
      if (failure === "uncertain-send")
        state.during = async () => {
          throw new TypeError("synthetic connection lost after send");
        };
      expect((await complete(device, change.recipeId, 2)).body).toMatchObject({ status: "failed" });
      state.during = undefined;
      expect(state.sent).toHaveLength(calls + 1);
      expect(
        await rows("SELECT state FROM judgement_reservations WHERE owner_id = ?", device.ownerId),
      ).toEqual([{ state: "finished" }]);
      expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
        reason: "judgement-unanswered",
      });
      expect(state.sent).toHaveLength(calls + 1);
    },
  );

  it.each(["optional", "partial", "challenge", "unclear"] as const)(
    "restores the previous %s cache answer after a charged replacement fails",
    async (kind) => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const inputs = kind === "challenge" || kind === "unclear";
      const first = {
        ...homePage,
        candidates: [
          ...homePage.candidates,
          ...(inputs ? [element("first-field", "text", "Synthetic field")] : []),
        ],
      };
      const second = {
        ...homePage,
        candidates: [
          ...homePage.candidates,
          ...(inputs ? [element("second-field", "text", "Synthetic field")] : []),
        ],
      };
      state.replies.push(judgeReply({ decision: kind === "partial" ? "optional" : kind }));
      expect(
        (await complete(device, change.recipeId, 2, first, kind === "partial" ? true : undefined))
          .body,
      ).toMatchObject({ status: kind === "partial" ? "optional" : kind });
      state.replies.push(500);
      expect((await complete(device, change.recipeId, 2, second)).body).toMatchObject({
        status: "failed",
        error: "provider-error",
      });
      expect(
        await rows(
          "SELECT verdict, inputs FROM page_judgements WHERE owner_id = ? AND path = '/home'",
          device.ownerId,
        ),
      ).toEqual([{ verdict: kind, inputs: await judgedInputs(first) }]);
      expect(
        await rows("SELECT state FROM judgement_reservations WHERE owner_id = ?", device.ownerId),
      ).toEqual([{ state: "finished" }, { state: "finished" }]);
    },
  );

  it("purges older revisions' and judges' judgements once their day is over", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const promptVersion = await completionPromptVersion();
    await seed(device, change.recipeId, 1, "/old", dayStart() - 1);
    await seed(device, change.recipeId, 1, "/recent", dayStart());
    await seed(device, change.recipeId, 2, "/current", dayStart() - 1, { promptVersion });
    await seed(device, change.recipeId, 2, "/earlier-judge", dayStart() - 1);
    await seed(device, "gen-other", 1, "/other", dayStart() - 1);
    state.replies.push(judgeReply({ decision: "rejected" }));
    await complete(device, change.recipeId, 2);
    expect(await judgements(device)).toEqual([
      { recipe_id: change.recipeId, revision: 1, path: "/recent" },
      { recipe_id: change.recipeId, revision: 2, path: "/current" },
      { recipe_id: change.recipeId, revision: 2, path: "/home" },
      { recipe_id: "gen-other", revision: 1, path: "/other" },
    ]);
  });

  it("adds a passkey handler for a challenge naming a security-key button", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    const judged = await complete(device, change.recipeId, 2, webauthnPage);
    expect(judged).toMatchObject({
      status: 200,
      body: {
        version: 1,
        status: "challenge",
        change: {
          recipeId: change.recipeId,
          revision: 3,
          state: "active",
          recipe: {
            revision: 3,
            steps: route(change.recipe).steps,
            handlers: [
              { kind: "passkey", path: "/login/webauthn", target: { by: "id", value: "key" } },
            ],
          },
        },
      },
    });
    expect(await head(device, change.recipeId)).toBe(3);
    expect(
      await rows(
        "SELECT created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ? AND revision = 3",
        device.ownerId,
        change.recipeId,
      ),
    ).toEqual([{ created_by_device_id: device.deviceId }]);
    // Later judgements tell the model the handler's path is part of the login.
    state.replies.push(judgeReply({ decision: "unclear" }));
    await complete(device, change.recipeId, 3);
    expect(JSON.stringify(state.sent.at(-1)!.body)).toContain(
      String.raw`\"loginPaths\":[\"/login\",\"/password\",\"/login/webauthn\"]`,
    );
    // The handler's revision is on its judgement's row; the undecided page wrote none.
    expect(
      (await logRows(device.ownerId, "judge")).map(({ base_revision, revision, answer }) => ({
        base_revision,
        revision,
        answer,
      })),
    ).toEqual([
      { base_revision: 2, revision: 3, answer: { decision: "challenge", passkeyButton: "key" } },
      { base_revision: 3, revision: null, answer: { decision: "unclear" } },
    ]);
  });

  it("answers a plain challenge for a registration button or a duplicate handler", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const register = observation("/login/webauthn", [
      element("add", "button", "Add a passkey"),
      element("key", "button", "Use security key"),
    ]);
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "add" }));
    expect((await complete(device, change.recipeId, 2, register)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    expect(await head(device, change.recipeId)).toBe(2);
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    const added = await complete(device, change.recipeId, 2, { ...webauthnPage, path: "/mfa" });
    expect(added.body).toMatchObject({ status: "challenge", change: { revision: 3 } });
    // Another button on a path that already has a passkey handler adds nothing.
    const again = observation("/mfa", [element("other", "button", "Use your passkey")]);
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "other" }));
    expect((await complete(device, change.recipeId, 3, again)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    expect(await head(device, change.recipeId)).toBe(3);
  });

  describe("an optional page after the sign-in (ADR 0065)", () => {
    const checkupPage = observation("/checkup", [
      element("verify", "button", "Verify now"),
      element("remind-later", "button", "Remind me later"),
      element("logout", "button", "Sign out"),
    ]);

    it("answers optional, learns nothing and judges the path again on a later login", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(judgeReply({ decision: "optional" }));
      expect((await complete(device, change.recipeId, 2, checkupPage)).body).toEqual({
        version: 1,
        status: "optional",
      });
      // No marker from a page whose elements may never show on the usual signed-in page.
      expect(await head(device, change.recipeId)).toBe(2);
      const verdicts = () =>
        rows(
          "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/checkup'",
          device.ownerId,
        );
      expect(await verdicts()).toEqual([{ verdict: "optional" }]);
      // The judge was told what such a page is.
      expect(JSON.stringify(state.sent.at(-1)!.body)).toContain("is optional, not a challenge");
      // The same path later shows the password form again, as a single-page sign-in does:
      // the earlier answer is not reused, and the new one replaces it.
      const calls = state.sent.length;
      state.replies.push(judgeReply({ decision: "challenge" }));
      expect((await complete(device, change.recipeId, 2, checkupPage)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      expect(state.sent).toHaveLength(calls + 1);
      expect(await verdicts()).toEqual([{ verdict: "challenge" }]);
    });

    it("stores an optional answer as partial when a disabled field was left out", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(judgeReply({ decision: "optional" }));
      const body = await complete(device, change.recipeId, 2, checkupPage, true);
      expect(body.body).toEqual({ version: 1, status: "optional" });
      expect(
        await rows(
          "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/checkup'",
          device.ownerId,
        ),
      ).toEqual([{ verdict: "partial" }]);
    });

    it("answers a challenge for an optional answer on a page with a code field", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const withCode = observation("/checkup", [
        element("verify", "button", "Verify now"),
        { ...element("otp", "text", "Code"), autocomplete: "one-time-code" },
      ]);
      state.replies.push(judgeReply({ decision: "optional" }));
      expect((await complete(device, change.recipeId, 2, withCode)).body).toEqual({
        version: 1,
        status: "challenge",
      });
    });
  });

  describe("a page that asks how to confirm the sign-in (ADR 0048)", () => {
    // The page after the identifier's Next: no inputs, a choice of how to verify.
    const choicePage = (label = "Password") =>
      observation("/login", [
        element("choose-password", "button", label),
        element("mobile", "button", "Mobile"),
        element("cancel", "link", "Cancel"),
      ]);
    const passwordHandler = {
      kind: "password",
      path: "/login",
      target: { by: "id", value: "choose-password" },
    };
    async function identifierRecipe(device: Device) {
      state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
      const first = await generate(device, emailPage);
      if (first.status !== "recipe") throw new Error(first.status);
      return first.change;
    }

    it("adds a password handler, which a continuation of the route keeps", async () => {
      const device = await owner();
      const info = vi.spyOn(console, "info");
      const change = await identifierRecipe(device);
      state.replies.push(judgeReply({ decision: "challenge", passwordButton: "choose-password" }));
      const judged = await complete(device, change.recipeId, 1, choicePage());
      expect(judged.body).toMatchObject({
        status: "challenge",
        change: {
          revision: 2,
          recipe: { steps: route(change.recipe).steps, handlers: [passwordHandler] },
        },
      });
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "password", kept: true }],
      });
      // The judge was told what such a page and its button are.
      expect(JSON.stringify(state.sent.at(-1)!.body)).toContain("passwordButton is the button");
      // The password page after the press continues the route; the handler stays.
      state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
      const continued = await generate(device, passwordPage, {
        recipeId: change.recipeId,
        revision: 2,
      });
      if (continued.status !== "recipe") throw new Error(continued.status);
      expect(continued.change.revision).toBe(3);
      expect(route(continued.change.recipe)).toMatchObject({
        steps: [
          { kind: "fill", path: "/login" },
          { kind: "click", path: "/login", purpose: "advance" },
          { kind: "fill", path: "/password" },
          { kind: "click", path: "/password", purpose: "submit" },
        ],
        handlers: [passwordHandler],
      });
      info.mockRestore();
    });

    it("answers a plain challenge for a button that does not name the password", async () => {
      const device = await owner();
      const change = await identifierRecipe(device);
      const info = vi.spyOn(console, "info");
      state.replies.push(judgeReply({ decision: "challenge", passwordButton: "choose-password" }));
      expect(
        (await complete(device, change.recipeId, 1, choicePage("Forgot password?"))).body,
      ).toEqual({ version: 1, status: "challenge" });
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "password", kept: false, reason: "not-password" }],
      });
      expect(await head(device, change.recipeId)).toBe(1);
      info.mockRestore();
    });

    it("never learns one for a recipe that already types the password", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info");
      const later = observation("/verify", [element("choose-password", "button", "Password")]);
      state.replies.push(judgeReply({ decision: "challenge", passwordButton: "choose-password" }));
      expect((await complete(device, change.recipeId, 2, later)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "password", kept: false, reason: "password-filled" }],
      });
      expect(await head(device, change.recipeId)).toBe(2);
      info.mockRestore();
    });
  });

  it("adds a totp handler for an authenticator app code, beside a passkey handler in one revision", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const code = {
      ...element("app-code", "text", "Authentication code"),
      autocomplete: "one-time-code" as const,
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    const verify = element("verify", "button", "Verify");
    const mfa = observation("/login/mfa", [
      code,
      verify,
      element("key", "button", "Use security key"),
    ]);
    const answer = (source: string, passkeyButton?: string) =>
      judgeReply({
        decision: "challenge",
        ...(passkeyButton ? { passkeyButton } : {}),
        code: { field: "app-code", submit: "verify", source },
      });
    state.replies.push(answer("authenticator-app", "key"));
    expect((await complete(device, change.recipeId, 2, mfa)).body).toMatchObject({
      status: "challenge",
      change: {
        revision: 3,
        recipe: {
          revision: 3,
          steps: route(change.recipe).steps,
          handlers: [
            { kind: "passkey", path: "/login/mfa", target: { by: "id", value: "key" } },
            {
              kind: "totp",
              path: "/login/mfa",
              field: { by: "id", value: "app-code" },
              target: { by: "id", value: "verify" },
            },
          ],
        },
      },
    });
    expect(await head(device, change.recipeId)).toBe(3);
    // A code sent by SMS or email adds nothing.
    for (const [path, source] of [
      ["/login/sms", "sms"],
      ["/login/email", "email"],
    ] as const) {
      state.replies.push(answer(source));
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Each page is judged on its own.
        (await complete(device, change.recipeId, 3, observation(path, [code, verify]))).body,
      ).toEqual({ version: 1, status: "challenge" });
    }
    expect(await head(device, change.recipeId)).toBe(3);
    // A code whose source the page does not say adds a totp handler (owner, 2026-10-13).
    state.replies.push(answer("unknown"));
    expect(
      (await complete(device, change.recipeId, 3, observation("/login/code", [code, verify]))).body,
    ).toMatchObject({
      status: "challenge",
      change: {
        revision: 4,
        recipe: {
          handlers: [
            { kind: "passkey", path: "/login/mfa" },
            { kind: "totp", path: "/login/mfa" },
            {
              kind: "totp",
              path: "/login/code",
              field: { by: "id", value: "app-code" },
              target: { by: "id", value: "verify" },
            },
          ],
        },
      },
    });
    expect(await head(device, change.recipeId)).toBe(4);
  });

  it("does not learn a completion on a page that shows a totp handler's code field", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const code = {
      ...element("app-code", "text", "Authentication code"),
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    state.replies.push(
      judgeReply({
        decision: "challenge",
        code: { field: "app-code", submit: "verify", source: "authenticator-app" },
      }),
    );
    const mfa = observation("/login/mfa", [code, element("verify", "button", "Verify")]);
    expect((await complete(device, change.recipeId, 2, mfa)).body).toMatchObject({
      change: { revision: 3 },
    });
    // The code page again, with a link the model takes for a signed-in marker.
    state.replies.push(judgeReply({ decision: "signed-in", marker: "help" }));
    expect(
      (
        await complete(
          device,
          change.recipeId,
          3,
          observation("/login/mfa", [code, element("help", "link", "Help")]),
        )
      ).body,
    ).toEqual({ version: 1, status: "failed", error: "invalid-output" });
    expect(await head(device, change.recipeId)).toBe(3);
  });

  describe("totp handlers, probed independently", () => {
    const appCode = {
      ...element("app-code", "text", "Authentication code"),
      autocomplete: "one-time-code" as const,
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    const verify = element("verify", "button", "Verify");
    const code = (source: string) => ({ field: "app-code", submit: "verify", source });

    it("keeps the code when the named passkey button fails its checks, and the reverse", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // A registration button stores no passkey handler; the code still lands.
      const register = observation("/login/mfa", [
        appCode,
        verify,
        element("add", "button", "Add a passkey"),
      ]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "add",
          code: code("authenticator-app"),
        }),
      );
      const first = await complete(device, change.recipeId, 2, register);
      expect(first.body).toMatchObject({
        status: "challenge",
        change: {
          revision: 3,
          recipe: {
            handlers: [
              {
                kind: "totp",
                path: "/login/mfa",
                field: { by: "id", value: "app-code" },
                target: { by: "id", value: "verify" },
              },
            ],
          },
        },
      });
      // A field the TOTP fill rule refuses stores no totp handler; the passkey button lands.
      const plain = observation("/login/key", [
        { ...element("plain", "text", "Code"), inputMode: "tel" as const },
        verify,
        element("key", "button", "Use security key"),
      ]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "key",
          code: { field: "plain", submit: "verify", source: "authenticator-app" },
        }),
      );
      const second = await complete(device, change.recipeId, 3, plain);
      expect(second.body).toMatchObject({ change: { revision: 4 } });
      if (!("change" in second.body) || !second.body.change) throw new Error("no change");
      expect(route(second.body.change.recipe).handlers?.map((handler) => handler.kind)).toEqual([
        "totp",
        "passkey",
      ]);
    });

    it("stores a code step in the sign-in form that reuses the route's button", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const sameForm = observation("/password", [appCode, element("sign-in", "button", "Sign in")]);
      state.replies.push(
        judgeReply({
          decision: "challenge",
          code: { field: "app-code", submit: "sign-in", source: "authenticator-app" },
        }),
      );
      expect((await complete(device, change.recipeId, 2, sameForm)).body).toMatchObject({
        change: {
          revision: 3,
          recipe: {
            steps: route(change.recipe).steps,
            handlers: [
              {
                kind: "totp",
                path: "/password",
                field: { by: "id", value: "app-code" },
                target: { by: "id", value: "sign-in" },
              },
            ],
          },
        },
      });
    });

    it("logs the kept handler's locators only, and refuses a page carrying values", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      state.replies.push(judgeReply({ decision: "challenge", code: code("authenticator-app") }));
      await complete(device, change.recipeId, 2, observation("/login/mfa", [appCode, verify]));
      state.replies.push(judgeReply({ decision: "challenge", code: code("sms") }));
      await complete(device, change.recipeId, 3, observation("/login/sms", [appCode, verify]));
      const logged = await rows(
        "SELECT request, result FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY created_at",
        device.ownerId,
      );
      expect(logged.map((row) => JSON.parse(String(row.result)))).toEqual([
        {
          decision: "challenge",
          totp: { field: { by: "id", value: "app-code" }, target: { by: "id", value: "verify" } },
        },
        // Why the SMS code was dropped, without an element.
        { decision: "challenge", totpDropped: "source-sms" },
      ]);
      // A synthetic code typed into the page never reaches the service or its log.
      const calls = state.sent.length;
      const withValue = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
        version: 1,
        slots: [],
        revision: 3,
        route: "password",
        observation: observation("/login/other", [
          { ...appCode, value: "012345" } as never,
          verify,
        ]),
      });
      expect(withValue.status).toBe(400);
      expect(state.sent).toHaveLength(calls);
      const all = await rows(
        "SELECT request, result FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      );
      expect(JSON.stringify(all)).not.toContain("012345");
    });
  });
}
