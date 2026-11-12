import { MAX_ACTIVE_RECIPE_BYTES, type ObservedCandidate } from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { completionPromptVersion, generationPromptVersion } from "@pateat/inference";
import { describe, expect, it, vi } from "vitest";
import { judgedInputs } from "@pateat/generation";
import { seedRecipeBytes, storedRecipeBytes } from "../recipe-byte-helpers";
import type { PageJudgementContext, Device } from "./context";

export function registerPageJudgement1(context: PageJudgementContext) {
  const {
    ORIGIN,
    element,
    observation,
    emailPage,
    homePage,
    plan,
    owner,
    post,
    generate,
    complete,
    rows,
    twoPageRecipe,
    judgeReply,
    webauthnPage,
    judgements,
    spend,
    head,
    state,
  } = context;

  it("names the route, which must be one the stored recipe has", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = state.sent.length;
    const unknownRoute = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      slots: [],
      revision: 2,
      route: "sso",
      observation: homePage,
    });
    expect(unknownRoute.status).toBe(400);
    // A known route the stored recipe does not have is a conflict, with no model call.
    const passkeyRoute = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      slots: [],
      revision: 2,
      route: "passkey",
      observation: homePage,
    });
    expect(await passkeyRoute.json()).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(state.sent).toHaveLength(calls);
    state.replies.push(judgeReply({ decision: "rejected" }));
    const response = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      slots: [],
      revision: 2,
      route: "password",
      observation: homePage,
    });
    expect(await response.json()).toEqual({ version: 1, status: "rejected" });
    // The logged request names the route, and the row the judge's prompt version. The
    // conflict's row has no login paths: the stored revision has no such route.
    const [conflict, logged] = await rows(
      "SELECT request, prompt_version, outcome FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY created_at",
      device.ownerId,
    );
    expect(conflict!.outcome).toBe("recipe-conflict");
    const conflictRequest = JSON.parse(String(conflict!.request)) as Record<string, unknown>;
    expect(conflictRequest).toMatchObject({ route: "passkey", observation: homePage });
    expect(conflictRequest).not.toHaveProperty("loginPaths");
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      route: "password",
      loginPaths: ["/login", "/password"],
    });
    expect(logged!["prompt_version"]).toBe(await completionPromptVersion());
    expect(logged!["prompt_version"]).not.toBe(await generationPromptVersion());
  });

  it("judges the page after an advance whose next step never appeared", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, first.change.recipeId, 1)).body).toMatchObject({
      status: "signed-in",
      change: {
        revision: 2,
        recipe: { completion: [{ target: { by: "id", value: "logout" } }] },
      },
    });
    expect(state.sent).toHaveLength(2);
  });

  it("adds a later signed-in page's marker, up to four (ADR 0029)", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 3 },
    });
    const markers = ["account", "settings", "inbox"];
    for (const [index, marker] of markers.entries()) {
      const page = observation(`/${marker}`, [element(marker, "button", "Account")]);
      state.replies.push(judgeReply({ decision: "signed-in", marker }));
      // oxlint-disable-next-line no-await-in-loop -- Each marker lands in its own revision.
      expect((await complete(device, change.recipeId, 3 + index, page)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 4 + index,
          recipe: {
            completion: ["logout", ...markers.slice(0, index + 1)].map((value) => ({
              target: { by: "id", value },
            })),
          },
        },
      });
    }
    // With four, a later signed-in page changes nothing.
    const fifth = observation("/fifth", [element("fifth", "button", "Account")]);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "fifth" }));
    expect((await complete(device, change.recipeId, 6, fifth)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(state.sent).toHaveLength(7);
    expect(await head(device, change.recipeId)).toBe(6);
  });

  it("answers signed-in without a change when a later marker cannot be added", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    await complete(device, change.recipeId, 2);
    // The judge names the first page's Next button, which is never a marker (ADR 0029).
    const welcome = observation("/welcome", [element("next", "button", "Next")]);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "next" }));
    expect((await complete(device, change.recipeId, 3, welcome)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(await head(device, change.recipeId)).toBe(3);
  });

  it("answers signed-in without a change when a first marker is the recipe's own element", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    // The site gives a signed-in page's button the sign-in button's id: the judge is told
    // it is a step's element, and a marker naming it anyway is not learned, since the
    // sign-in page would read as signed in (ADR 0029).
    const welcome = observation("/welcome", [
      element("sign-in", "button", "Sign out"),
      element("help", "link", "Help"),
    ]);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "sign-in" }));
    expect((await complete(device, change.recipeId, 2, welcome)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(JSON.stringify(state.sent.at(-1)!.body)).toContain(
      String.raw`\"stepElements\":[\"sign-in\"]`,
    );
    expect(await head(device, change.recipeId)).toBe(2);
  });

  it("fails closed on a page that still shows the login's elements, whatever the marker", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const code = {
      ...element("app-code", "text", "Authentication code"),
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    const mfa = observation("/login/mfa", [code, element("verify", "button", "Verify")]);
    state.replies.push(
      judgeReply({
        decision: "challenge",
        code: { field: "app-code", submit: "verify", source: "authenticator-app" },
      }),
    );
    await complete(device, change.recipeId, 2, mfa);
    // The code page again, its own button taken for the marker: still the handler's page.
    state.replies.push(judgeReply({ decision: "signed-in", marker: "verify" }));
    expect((await complete(device, change.recipeId, 3, mfa)).body).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
    });
    // The first page's Next button on its own path, with its field gone.
    const login = observation("/login", [
      element("next", "button", "Next"),
      element("help", "link", "Help"),
    ]);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "next" }));
    expect((await complete(device, change.recipeId, 3, login)).body).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
    });
    // Both paths keep `challenge`, so a later login of the revision never completes there.
    const calls = state.sent.length;
    for (const page of [mfa, login])
      // oxlint-disable-next-line no-await-in-loop -- Each request reads the row kept before.
      expect((await complete(device, change.recipeId, 3, page)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-challenge",
      });
    expect(state.sent).toHaveLength(calls);
    expect(await head(device, change.recipeId)).toBe(3);
  });

  it("fails closed on a marker that chooses the authenticator app (ADR 0081)", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    // The extension may name a `role="button"` choice by its text on a judged page, which a
    // marker's lookup never finds; such a button is a sign-in step's in any case.
    const chooser = observation("/login/verify", [
      {
        ...element("app", "button", "Use code from authenticator"),
        target: { by: "text", value: "Use code from authenticator" },
      },
    ]);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "app" }));
    expect((await complete(device, change.recipeId, 2, chooser)).body).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
    });
    const calls = state.sent.length;
    expect((await complete(device, change.recipeId, 2, chooser)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(state.sent).toHaveLength(calls);
    expect(await head(device, change.recipeId)).toBe(2);
  });

  it("does not judge a page that shows a route fill field or a signed-in marker", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    await complete(device, change.recipeId, 2);
    const calls = state.sent.length;
    const before = await spend(device);
    const stored = await judgements(device);
    for (const page of [
      // A marker proves the sign-in already, on any path.
      observation("/elsewhere", [element("logout", "button", "Sign out")]),
      // A route's fill field on another path than its step's.
      observation("/session", [
        element("password", "password", "Password"),
        element("help", "link", "Help"),
      ]),
    ])
      // oxlint-disable-next-line no-await-in-loop -- Each page is sent on its own.
      expect((await complete(device, change.recipeId, 3, page)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
    expect(state.sent).toHaveLength(calls);
    expect(await spend(device)).toEqual(before);
    expect(await judgements(device)).toEqual(stored);
  });

  it("maps a first marker write refused for bytes to recipe-limit", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES - (await storedRecipeBytes(device.ownerId)),
    );
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    const answer = await complete(device, change.recipeId, 2, homePage);
    expect(answer.body).toEqual({ version: 1, status: "unavailable", reason: "recipe-limit" });
    expect(await head(device, change.recipeId)).toBe(2);
    expect(state.sent).toHaveLength(3);
  });

  it("answers signed-in when a later marker is refused for bytes", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    const first = await complete(device, change.recipeId, 2, homePage);
    if (!("change" in first.body) || !first.body.change) throw new Error("no change");
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES - (await storedRecipeBytes(device.ownerId)),
    );
    const account = observation("/account", [element("account", "button", "Account")]);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "account" }));
    expect((await complete(device, change.recipeId, 3, account)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(await head(device, change.recipeId)).toBe(3);
    expect(state.sent).toHaveLength(4);
  });

  it("answers challenge when its handler is refused for bytes", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES - (await storedRecipeBytes(device.ownerId)),
    );
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    const answer = await complete(device, change.recipeId, 2, webauthnPage);
    expect(answer.body).toEqual({ version: 1, status: "challenge" });
    expect(await head(device, change.recipeId)).toBe(2);
    expect(state.sent).toHaveLength(3);
  });

  it("judges each revision and path once", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "challenge" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    const calls = state.sent.length;
    // The earlier judgement was `challenge`, so the page never completes a login (ADR 0029).
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(state.sent).toHaveLength(calls);
    // Another path of the same revision is judged; here it adds a handler.
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    expect((await complete(device, change.recipeId, 2, webauthnPage)).body).toMatchObject({
      status: "challenge",
      change: { revision: 3 },
    });
    // The new revision may judge the first path again.
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, change.recipeId, 3)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 4 },
    });
    expect(state.sent).toHaveLength(calls + 2);
    expect(await judgements(device)).toEqual([
      { recipe_id: change.recipeId, revision: 2, path: "/home" },
      { recipe_id: change.recipeId, revision: 2, path: "/login/webauthn" },
      { recipe_id: change.recipeId, revision: 3, path: "/home" },
    ]);
  });

  // Resend, 2026-11-04 10:18 UTC: the code page was described before its code field was
  // drawn, judged `challenge` with no handler, and every later login of the revision was
  // answered `judged-challenge` though its page showed the field (ADR 0029 amendment of
  // 2026-11-06).
  it("judges a challenge page again once it shows other inputs", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const bare = observation("/auth/mfa", [
      element("verify", "button", "Continue"),
      element("recovery", "button", "Use a recovery code"),
    ]);
    state.replies.push(judgeReply({ decision: "challenge" }));
    expect((await complete(device, change.recipeId, 2, bare)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    // The same inputs, whatever else the page shows, keep the kept answer.
    const calls = state.sent.length;
    const relabelled = observation("/auth/mfa", [element("verify", "button", "Verify")]);
    expect((await complete(device, change.recipeId, 2, relabelled)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(state.sent).toHaveLength(calls);
    // With its code field the page is judged again, within the day's limit, and its
    // handler is learned.
    const code = {
      ...element("app-code", "text", "One-time code"),
      autocomplete: "one-time-code" as const,
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    const drawn = observation("/auth/mfa", [code, ...bare.candidates]);
    state.replies.push(
      judgeReply({
        decision: "challenge",
        code: { field: "app-code", submit: "verify", source: "authenticator-app" },
      }),
    );
    expect((await complete(device, change.recipeId, 2, drawn)).body).toMatchObject({
      status: "challenge",
      change: { revision: 3 },
    });
    expect(state.sent).toHaveLength(calls + 1);
    expect(await judgements(device)).toEqual([
      { recipe_id: change.recipeId, revision: 2, path: "/auth/mfa" },
    ]);
  });

  // Epic Games' and HCP Cloud's code pages, 2026-11-07 16:26 and 16:29 UTC: the judge named
  // the code field, the code rules refused it, and the page was kept `challenge` with no
  // handler. A page whose inputs the rules read otherwise is judged again (ADR 0027
  // amendment of 2026-11-07).
  it("judges a challenge page again once the code rules read its inputs otherwise", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const verify = element("verify", "button", "Continue");
    const plain = {
      ...element("code", "text", "Enter your one-time code"),
      autocomplete: "off" as const,
    };
    const reply = () =>
      judgeReply({
        decision: "challenge",
        code: { field: "code", submit: "verify", source: "authenticator-app" },
      });
    // A phone keyboard keeps it from the code rules (ADR 0027 amendment of 2026-11-08).
    const refused = observation("/u/mfa-otp-challenge", [
      { ...plain, inputMode: "tel" as const },
      verify,
    ]);
    state.replies.push(reply());
    expect((await complete(device, change.recipeId, 2, refused)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    const calls = state.sent.length;
    // The same field, with a numeric keyboard instead, is a code input now.
    const read = observation("/u/mfa-otp-challenge", [
      { ...plain, inputMode: "numeric" as const },
      verify,
    ]);
    expect(await judgedInputs(read)).not.toBe(await judgedInputs(refused));
    state.replies.push(reply());
    expect((await complete(device, change.recipeId, 2, read)).body).toMatchObject({
      status: "challenge",
      change: { revision: 3 },
    });
    expect(state.sent).toHaveLength(calls + 1);
  });

  it("keeps a challenge when its page judged again gets no new verdict", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const bare = observation("/auth/mfa", [element("verify", "button", "Continue")]);
    const drawn = observation("/auth/mfa", [
      { ...element("app-code", "text", "One-time code"), autocomplete: "one-time-code" as const },
      element("verify", "button", "Continue"),
    ]);
    const kept = () =>
      rows(
        "SELECT verdict, inputs FROM page_judgements WHERE owner_id = ? AND path = '/auth/mfa'",
        device.ownerId,
      );
    state.replies.push(judgeReply({ decision: "challenge" }));
    await complete(device, change.recipeId, 2, bare);
    // The request judging it again fails: the row keeps `challenge` and its earlier inputs,
    // so the next login of the new ones judges it again.
    expect((await complete(device, change.recipeId, 2, drawn)).body).toEqual({
      version: 1,
      status: "failed",
      error: "provider-error",
    });
    expect(await kept()).toEqual([{ verdict: "challenge", inputs: await judgedInputs(bare) }]);
    // The model is undecided: the page is a challenge still, now for these inputs.
    const calls = state.sent.length;
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2, drawn)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    expect(state.sent).toHaveLength(calls + 1);
    expect(await kept()).toEqual([{ verdict: "challenge", inputs: await judgedInputs(drawn) }]);
    expect((await complete(device, change.recipeId, 2, drawn)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(state.sent).toHaveLength(calls + 1);
  });

  it("judges a challenge page kept without its inputs again", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    state.replies.push(judgeReply({ decision: "challenge" }));
    await complete(device, change.recipeId, 2);
    // A row kept before the inputs were recorded holds none.
    await env.DB.prepare("UPDATE page_judgements SET inputs = NULL WHERE owner_id = ?")
      .bind(device.ownerId)
      .run();
    const calls = state.sent.length;
    state.replies.push(judgeReply({ decision: "challenge" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    expect(state.sent).toHaveLength(calls + 1);
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(state.sent).toHaveLength(calls + 1);
  });

  // EPOS Net, 2026-11-11 12:53 UTC: an image puzzle on the path after the sign-in was
  // judged `unclear`, and its card security code page, on the same path, would have been
  // answered `already-judged` and completed unconfirmed (ADR 0029 amendment of
  // 2026-11-11).
  it("judges an undecided page again once it shows other inputs", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const puzzle = observation("/login/dispatch", [element("login", "button", "Log in")]);
    const kept = () =>
      rows(
        "SELECT verdict, inputs FROM page_judgements WHERE owner_id = ? AND path = '/login/dispatch'",
        device.ownerId,
      );
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2, puzzle)).body).toEqual({
      version: 1,
      status: "unclear",
    });
    // The same inputs keep the kept answer.
    const calls = state.sent.length;
    expect((await complete(device, change.recipeId, 2, puzzle)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "already-judged",
    });
    expect(state.sent).toHaveLength(calls);
    const code = observation("/login/dispatch", [
      { ...element("input_pass", "password", "Security code"), maxLength: 3 },
      element("next", "button", "Next"),
    ]);
    // The request judging it again fails: the row keeps `unclear` and its earlier inputs.
    expect((await complete(device, change.recipeId, 2, code)).body).toEqual({
      version: 1,
      status: "failed",
      error: "provider-error",
    });
    expect(await kept()).toEqual([{ verdict: "unclear", inputs: await judgedInputs(puzzle) }]);
    // The model is undecided again: the row stays `unclear`, now for these inputs.
    state.replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2, code)).body).toEqual({
      version: 1,
      status: "unclear",
    });
    expect(await kept()).toEqual([{ verdict: "unclear", inputs: await judgedInputs(code) }]);
    const judged = state.sent.length;
    expect((await complete(device, change.recipeId, 2, code)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "already-judged",
    });
    expect(state.sent).toHaveLength(judged);
    // The puzzle shows again and is judged a challenge this time.
    state.replies.push(judgeReply({ decision: "challenge" }));
    expect((await complete(device, change.recipeId, 2, puzzle)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    expect(state.sent).toHaveLength(judged + 1);
    expect(await kept()).toEqual([{ verdict: "challenge", inputs: await judgedInputs(puzzle) }]);
  });

  describe("a page of another origin of the site (ADR 0022)", () => {
    const moved = (path: string, candidates: ObservedCandidate[]) =>
      observation(path, candidates, "https://www.example.test");
    const movedHome = moved("/home", [
      element("logout", "button", "Sign out"),
      element("help", "link", "Help"),
    ]);
    const origins = (device: Device) =>
      rows(
        "SELECT origin, path, verdict FROM page_judgements WHERE owner_id = ? ORDER BY origin, verdict",
        device.ownerId,
      );

    it("judges it apart from the recipe's origin and learns its marker with that origin", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // The recipe's own `/home` at the same revision does not count as this page judged.
      state.replies.push(judgeReply({ decision: "unclear" }));
      expect((await complete(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unclear",
      });
      state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      expect((await complete(device, change.recipeId, 2, movedHome)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 3,
          recipe: {
            completion: [
              { target: { by: "id", value: "logout" }, origin: "https://www.example.test" },
            ],
          },
        },
      });
      // The recipe's own origin, on the same path, is another page with its own marker.
      state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      expect((await complete(device, change.recipeId, 3)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 4,
          recipe: {
            completion: [
              { target: { by: "id", value: "logout" }, origin: "https://www.example.test" },
              { target: { by: "id", value: "logout" } },
            ],
          },
        },
      });
      expect(await origins(device)).toEqual([
        { origin: ORIGIN, path: "/home", verdict: "signed-in" },
        { origin: ORIGIN, path: "/home", verdict: "unclear" },
        { origin: "https://www.example.test", path: "/home", verdict: "signed-in" },
      ]);
      // Its marker now proves the sign-in there, so the page is not judged again.
      const calls = state.sent.length;
      expect((await complete(device, change.recipeId, 4, movedHome)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
      expect(state.sent).toHaveLength(calls);
    });

    it("answers a page judged signed-in before as such, and an undecided one as already judged", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // The first page's Next button is never a marker, so nothing is learned there.
      const welcome = moved("/welcome", [element("next", "button", "Next")]);
      state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      await complete(device, change.recipeId, 2);
      state.replies.push(judgeReply({ decision: "signed-in", marker: "next" }));
      expect((await complete(device, change.recipeId, 3, welcome)).body).toEqual({
        version: 1,
        status: "signed-in",
      });
      const unclear = moved("/later", [element("help", "link", "Help")]);
      state.replies.push(judgeReply({ decision: "unclear" }));
      expect((await complete(device, change.recipeId, 3, unclear)).body).toEqual({
        version: 1,
        status: "unclear",
      });
      const calls = state.sent.length;
      expect((await complete(device, change.recipeId, 3, welcome)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-signed-in",
      });
      expect((await complete(device, change.recipeId, 3, unclear)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "already-judged",
      });
      expect(state.sent).toHaveLength(calls);
    });

    it("answers signed-in when its marker cannot be learned, as a later request would", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // The first page's Next button is never a marker, and the recipe has none yet.
      state.replies.push(judgeReply({ decision: "signed-in", marker: "next" }));
      expect(
        (
          await complete(
            device,
            change.recipeId,
            2,
            moved("/welcome", [element("next", "button", "Next")]),
          )
        ).body,
      ).toEqual({ version: 1, status: "signed-in" });
      expect(await head(device, change.recipeId)).toBe(2);
    });

    it("judges it on a route the stored recipe has, whatever the route (owner, 2026-11-08)", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const calls = state.sent.length;
      const response = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
        version: 1,
        slots: [],
        revision: 2,
        route: "passkey",
        observation: movedHome,
      });
      // This recipe has no passkey route: a conflict, as on its own origin.
      expect(await response.json()).toEqual({
        version: 1,
        status: "unavailable",
        reason: "recipe-conflict",
      });
      expect(state.sent).toHaveLength(calls);
    });

    it("keeps no handler for a challenge there", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
      expect(
        (
          await complete(
            device,
            change.recipeId,
            2,
            moved("/login/webauthn", [element("key", "button", "Use security key")]),
          )
        ).body,
      ).toEqual({ version: 1, status: "challenge" });
      expect(await head(device, change.recipeId)).toBe(2);
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "passkey", kept: false, reason: "origin-mismatch" }],
      });
    });

    it("judges a page of another site a password login moved to after a second factor", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const portal = "https://portal.elsewhere.test";
      const portalHome = observation("/home", [element("logout", "button", "Sign out")], portal);
      // A page answered by itself may ask for the passkey, so no recipe step shows it: the
      // extension alone knows the second factor (ADR 0022).
      state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      expect((await complete(device, change.recipeId, 2, portalHome)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 3,
          recipe: { completion: [{ target: { by: "id", value: "logout" }, origin: portal }] },
        },
      });
      const calls = state.sent.length;
      // Only over HTTPS.
      expect(
        (
          await complete(device, change.recipeId, 3, {
            ...portalHome,
            origin: "http://portal.test",
          })
        ).status,
      ).toBe(400);
      expect(state.sent).toHaveLength(calls);
    });

    it("judges its page on a recipe path when it shows no field to fill", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // `/password` is a path of the recipe's own origin; only its sign-in button shows here.
      state.replies.push(judgeReply({ decision: "unclear" }));
      expect(
        (
          await complete(
            device,
            change.recipeId,
            2,
            moved("/password", [element("sign-in", "button", "Sign in")]),
          )
        ).body,
      ).toEqual({ version: 1, status: "unclear" });
    });
  });
}
