import {
  type LoginChooserDocument,
  type LoginObservation,
  type RecipeGenerationResult,
  isChooserDocument,
} from "@pateat/contracts";
import {
  accountListGenerationInstructions,
  accountListGenerationPromptVersion,
  generationPromptVersion,
} from "@pateat/inference";
import { expect, it } from "vitest";
import { generatedRecipeId } from "@pateat/generation";
import type { GenerationContext, Device } from "./context";

export function registerChooserBranches(context: GenerationContext) {
  const {
    ORIGIN,
    slots,
    element,
    observation,
    emailPage,
    passwordPage,
    homePage,
    plan,
    owner,
    layoutKey,
    post,
    storedHead,
    projected,
    generate,
    rows,
    logRows,
    state,
  } = context;

  const listPage: LoginObservation = {
    ...observation("/login", [
      element("other", "button", "Sign in with another profile"),
      element("help", "link", "Help"),
    ]),
    accounts: ["[email] Last used", "[email]"],
  };
  const listAnswer = (controls: { other?: string; continue?: string; passkeyButton?: string }) =>
    JSON.stringify({ result: { decision: "account-list", ...controls } });
  const judgeReply = (result: unknown) => ({ text: JSON.stringify({ result }) });
  async function branchGenerate(
    device: Device,
    page: LoginObservation,
    base: { recipeId: string; revision: number },
    branch: string,
  ) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      slots,
      base,
      branch,
    });
    expect(response.status).toBe(200);
    return projected((await response.json()) as RecipeGenerationResult);
  }
  /** Stores the list as a chooser with an `other` button and returns its change. */
  async function chooser(device: Device) {
    state.replies.push({ text: listAnswer({ other: "other" }) });
    const answer = await generate(device, listPage);
    if (answer.status !== "recipe") throw new Error(answer.status);
    return answer.change;
  }

  it("stores a branch's page as sign-in whatever kind the model answers (ADR 0035)", async () => {
    const device = await owner();
    const change = await chooser(device);
    state.replies.push({
      text: JSON.stringify({
        result: {
          ...JSON.parse(plan([["email", "email"]], "next", "advance")).result,
          pageKind: "confirm",
          irreversible: "unclear",
        },
      }),
    });
    const answer = await branchGenerate(
      device,
      emailPage,
      { recipeId: change.recipeId, revision: change.revision },
      "other",
    );
    if (answer.status !== "recipe" || !isChooserDocument(answer.change.recipe))
      throw new Error(answer.status);
    // The chooser layout's branch keeps it (ADR 0060); the answer is that layout projected.
    expect(answer.change.recipe).toMatchObject({
      chooser: { afterOther: { pageKind: "sign-in" } },
    });
    // The log keeps what the model answered.
    expect(
      await rows(
        "SELECT signed_in, page_kind, irreversible FROM inference_log WHERE owner_id = ? AND recipe_page = 'continuation'",
        device.ownerId,
      ),
    ).toEqual([{ signed_in: null, page_kind: "confirm", irreversible: "unclear" }]);
  });

  it("stores a list of accounts as a chooser recipe and logs its controls by reference", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const before = Date.now();
    const change = await chooser(device);
    expect(change).toEqual({
      recipeId,
      revision: 1,
      state: "active",
      recipe: {
        version: 1,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        layout: expect.any(String),
        chooser: { path: "/login", other: { by: "id", value: "other" } },
      },
    });
    // Stored as the chooser's first layout (ADR 0060), keyed by when it was made and in the
    // page's language.
    const key = await layoutKey(device.ownerId, recipeId);
    expect(Number(key)).toBeGreaterThanOrEqual(before);
    expect(await storedHead(device.ownerId, recipeId)).toEqual({
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      chooser: {
        path: "/login",
        layouts: [
          { key, language: "en", createdAt: Number(key), other: { by: "id", value: "other" } },
        ],
      },
    });
    // The page went to the model with its accounts as the observation redacted them.
    expect(JSON.stringify(state.sent[0]!.body)).toContain(
      String.raw`\"accounts\":[\"[email] Last used\",\"[email]\"]`,
    );
    const [logged] = await rows(
      "SELECT outcome, result, prompt_version, request FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(logged!.outcome).toBe("ok");
    expect(JSON.parse(String(logged!.result))).toEqual({ accountList: true, other: "other" });
    // Only a list's request carries the list line, with its own prompt version.
    expect(logged!["prompt_version"]).toBe(await accountListGenerationPromptVersion());
    expect(JSON.parse(String(logged!["request"]))).toMatchObject({
      instructions: accountListGenerationInstructions,
    });
    // It goes to the model, and to the log, without slots (owner 2026-10-23 11:48 UTC).
    expect(JSON.stringify(state.sent[0]!.body)).toContain(String.raw`\"slots\":[]`);
    expect(JSON.parse(String(logged!["request"]))).toMatchObject({ slots: [] });
    expect(await accountListGenerationPromptVersion()).not.toBe(await generationPromptVersion());
    expect(
      await rows(
        "SELECT recipe_id, branch, path, base_revision FROM generation_attempts WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ recipe_id: recipeId, branch: "", path: "/login", base_revision: 0 }]);
    // Another device sending the list gets the chooser without a call; a form page on the
    // same path gets no recipe from it.
    expect(await generate(device, listPage)).toEqual({ version: 1, status: "recipe", change });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(state.sent).toHaveLength(1);
  });

  it("stores the passkey button beside the list as the layout's passkey route (ADR 0079)", async () => {
    const device = await owner();
    const page: LoginObservation = {
      ...listPage,
      candidates: [
        ...listPage.candidates,
        element("key", "button", "Sign in with a passkey"),
        element("add-key", "button", "Add a passkey"),
        element("mail-key", "button", "Use a passkey for [email]"),
      ],
    };
    state.replies.push({ text: listAnswer({ other: "other", passkeyButton: "key" }) });
    const answer = await generate(device, page);
    if (answer.status !== "recipe") throw new Error(answer.status);
    const key = await layoutKey(device.ownerId, answer.change.recipeId);
    const button = { by: "id", value: "key" };
    expect(await storedHead(device.ownerId, answer.change.recipeId)).toMatchObject({
      chooser: {
        path: "/login",
        layouts: [
          {
            key,
            other: { by: "id", value: "other" },
            passkey: {
              pageKind: "sign-in",
              slots: [],
              passkeyOnly: true,
              passkey: { path: "/login", target: button },
              steps: [{ kind: "click", path: "/login", target: button, purpose: "submit" }],
              maxSubmissions: 1,
            },
          },
        ],
      },
    });
    // The login runs it as the chooser's passkey route.
    expect(answer.change.recipe).toMatchObject({
      chooser: { passkey: { passkeyOnly: true, layout: key } },
    });
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.result))).toEqual({
      accountList: true,
      other: "other",
      passkeyButton: "key",
    });
    // A button that registers a passkey, one for a single account, or the list's own
    // control, is no passkey route, and the list is stored without one.
    for (const passkeyButton of ["add-key", "mail-key", "other", "help", "missing"]) {
      // eslint-disable-next-line no-await-in-loop
      const another = await owner();
      state.replies.push({ text: listAnswer({ other: "other", passkeyButton }) });
      // eslint-disable-next-line no-await-in-loop
      const kept = await generate(another, page);
      if (kept.status !== "recipe" || !isChooserDocument(kept.change.recipe))
        throw new Error(kept.status);
      expect(kept.change.recipe.chooser).not.toHaveProperty("passkey");
    }
  });

  it("stores a shown account's continue button beside the other one", async () => {
    const device = await owner();
    const wise = {
      ...observation("/login", [
        element("log-back-in", "button", "Log back in"),
        element("another", "button", "Use another account"),
      ]),
      accounts: ["[masked]"],
    };
    state.replies.push({ text: listAnswer({ other: "another", continue: "log-back-in" }) });
    expect(await generate(device, wise)).toMatchObject({
      status: "recipe",
      change: {
        recipe: {
          chooser: {
            path: "/login",
            other: { by: "id", value: "another" },
            continue: { by: "id", value: "log-back-in" },
          },
        },
      },
    });
  });

  it("refuses a plan for a list, a list for a form and controls that may be accounts", async () => {
    const expectRefused = async (page: LoginObservation, text: string, reason: string) => {
      const device = await owner();
      state.replies.push({ text });
      expect(await generate(device, page)).toEqual({
        version: 1,
        status: "failed",
        error: "invalid-output",
        rejection: { check: "plan", reason },
      });
      expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual(
        [],
      );
    };
    await expectRefused(
      { ...listPage, candidates: [...listPage.candidates, element("email", "email", "Email")] },
      plan([["email", "email"]], "other", "advance"),
      "unexpected-plan",
    );
    await expectRefused(emailPage, listAnswer({ other: "next" }), "unexpected-account-list");
    await expectRefused(listPage, listAnswer({ other: "missing" }), "unknown-candidate");
    await expectRefused(
      listPage,
      listAnswer({ other: "other", continue: "other" }),
      "duplicate-candidate",
    );
    await expectRefused(
      {
        ...listPage,
        candidates: [...listPage.candidates, element("profile", "button", "[email] Last used")],
      },
      listAnswer({ other: "profile" }),
      "account-text",
    );
  });

  it("stores no chooser naming no control for a list whose accounts are no entries", async () => {
    const device = await owner();
    // As on a card that shows the account above its buttons: no account is clicked itself.
    const beside: LoginObservation = { ...listPage, accounts: ["[email]"], accountEntries: 0 };
    state.replies.push({ text: listAnswer({}) });
    expect(await generate(device, beside)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "no-list-control" },
    });
    expect(state.sent).toHaveLength(1);
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual([]);
    expect(await rows("SELECT * FROM recipe_revisions WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
    const [logged] = await rows(
      "SELECT outcome FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(logged!.outcome).toBe("invalid-output");
  });

  it("generates each branch's pages into the chooser, with attempts kept apart", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    // Each branch's rows name the chooser's layout before it (ADR 0060).
    const key = await layoutKey(device.ownerId, recipeId);
    // The page after a listed profile: the password alone.
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const account = await branchGenerate(
      device,
      passwordPage,
      { recipeId, revision: 1 },
      "account",
    );
    const afterAccount = {
      version: 1,
      id: recipeId,
      revision: 2,
      origin: ORIGIN,
      pageKind: "sign-in",
      slots: ["password"],
      steps: [
        {
          kind: "fill",
          path: "/password",
          fields: [{ slot: "password", target: { by: "id", value: "password" } }],
          effect: "prepare",
        },
        {
          kind: "click",
          path: "/password",
          target: { by: "id", value: "sign-in" },
          purpose: "submit",
        },
      ],
      maxSubmissions: 1,
    };
    expect(account).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { revision: 2, chooser: { afterAccount } } },
    });
    // The other button's branch starts with the email form, and continues after it.
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const other = await branchGenerate(device, emailPage, { recipeId, revision: 2 }, "other");
    expect(other).toMatchObject({
      status: "recipe",
      change: {
        revision: 3,
        recipe: {
          chooser: {
            afterAccount: { ...afterAccount, revision: 3 },
            afterOther: { revision: 3, slots: ["email"], maxSubmissions: 1 },
          },
        },
      },
    });
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const next = await branchGenerate(device, passwordPage, { recipeId, revision: 3 }, "other");
    expect(next).toMatchObject({
      status: "recipe",
      change: {
        revision: 4,
        recipe: {
          chooser: {
            afterOther: { revision: 4, slots: ["email", "password"], maxSubmissions: 2 },
          },
        },
      },
    });
    // The account branch has submitted, so nothing continues it.
    expect(await branchGenerate(device, homePage, { recipeId, revision: 4 }, "account")).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(
      await rows(
        "SELECT branch, path, base_revision FROM generation_attempts WHERE owner_id = ? ORDER BY base_revision",
        device.ownerId,
      ),
    ).toEqual([
      { branch: "", path: "/login", base_revision: 0 },
      { branch: `${key}:account`, path: "/password", base_revision: 1 },
      { branch: `${key}:other`, path: "/login", base_revision: 2 },
      { branch: `${key}:other`, path: "/password", base_revision: 3 },
    ]);
    expect(state.sent).toHaveLength(4);
    // The list starts the chooser; each branch's page continues it.
    expect(
      (await logRows(device.ownerId)).map(({ branch, base_revision, revision, recipe_page }) => ({
        branch,
        base_revision,
        revision,
        recipe_page,
      })),
    ).toEqual([
      { branch: "", base_revision: 0, revision: 1, recipe_page: "first" },
      { branch: `${key}:account`, base_revision: 1, revision: 2, recipe_page: "continuation" },
      { branch: `${key}:other`, base_revision: 2, revision: 3, recipe_page: "continuation" },
      { branch: `${key}:other`, base_revision: 3, revision: 4, recipe_page: "continuation" },
      // The account branch's page refused as `recipe-conflict`.
      { branch: `${key}:account`, base_revision: 4, revision: null, recipe_page: "continuation" },
    ]);
  });

  it("tries each branch's page on its own within the retry window", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    state.replies.push({
      text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
    });
    expect(
      await branchGenerate(device, emailPage, { recipeId, revision: 1 }, "account"),
    ).toMatchObject({ status: "abstained" });
    // The same path and revision on the other branch is another page.
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(
      await branchGenerate(device, emailPage, { recipeId, revision: 1 }, "other"),
    ).toMatchObject({ status: "recipe", change: { revision: 2 } });
    expect(state.sent).toHaveLength(3);
  });

  it("refuses a branch the chooser cannot take, without a model call", async () => {
    const device = await owner();
    const conflict = { version: 1, status: "unavailable", reason: "recipe-conflict" };
    // A chooser without an `other` button has no other branch.
    state.replies.push({ text: listAnswer({}) });
    const bare = await generate(device, listPage);
    if (bare.status !== "recipe") throw new Error(bare.status);
    const { recipeId } = bare.change;
    expect(await branchGenerate(device, emailPage, { recipeId, revision: 1 }, "other")).toEqual(
      conflict,
    );
    // A route recipe has no branches.
    const routeOwner = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(
      routeOwner,
      observation("/start", [
        element("email", "email", "Email"),
        element("next", "button", "Next"),
      ]),
    );
    if (first.status !== "recipe") throw new Error(first.status);
    expect(
      await branchGenerate(
        routeOwner,
        passwordPage,
        { recipeId: first.change.recipeId, revision: 1 },
        "account",
      ),
    ).toEqual(conflict);
    // A list is only ever a first page, and a branch needs a base.
    expect(await generate(device, listPage, { recipeId, revision: 1 })).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-request",
    });
    const unbased = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots,
      branch: "account",
    });
    expect(unbased.status).toBe(400);
    expect(state.sent).toHaveLength(2);
  });

  it("judges a branch's pages and learns into that branch only", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    await branchGenerate(device, passwordPage, { recipeId, revision: 1 }, "account");
    const judge = (branch?: string) =>
      post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        slots: [],
        revision: 2,
        route: "password",
        ...(branch ? { branch } : {}),
        observation: homePage,
      }).then(async (response) => projected(await response.json()));
    const conflict = { version: 1, status: "unavailable", reason: "recipe-conflict" };
    // The chooser has no route of its own, and the other branch has none yet.
    expect(await judge()).toEqual(conflict);
    expect(await judge("other")).toEqual(conflict);
    const calls = state.sent.length;
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect(await judge("account")).toMatchObject({
      status: "signed-in",
      change: {
        revision: 3,
        recipe: {
          chooser: {
            path: "/login",
            afterAccount: {
              revision: 3,
              completion: [{ target: { by: "id", value: "logout" } }],
            },
          },
        },
      },
    });
    expect(state.sent).toHaveLength(calls + 1);
    // The judge is told the list's path as a login path too.
    expect(JSON.stringify(state.sent.at(-1)!.body)).toContain(
      String.raw`\"loginPaths\":[\"/login\",\"/password\"]`,
    );
    expect(
      await rows(
        "SELECT branch, revision, path FROM page_judgements WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      {
        branch: `${await layoutKey(device.ownerId, recipeId)}:account`,
        revision: 2,
        path: "/home",
      },
    ]);
  });

  it("keeps a branch's page written during the call onto the other branch's newer chooser", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const account = await branchGenerate(
      device,
      passwordPage,
      { recipeId, revision: 1 },
      "account",
    );
    if (account.status !== "recipe" || !isChooserDocument(account.change.recipe))
      throw new Error(account.status);
    // The chooser as stored: its one layout (ADR 0060) holds the account branch.
    const atTwo = (await storedHead(device.ownerId, recipeId)) as LoginChooserDocument;
    const [layout] = atTwo.chooser.layouts;
    const completion = [{ target: { by: "id" as const, value: "logout" } }];
    // While the other branch's page is generated, a judgement of the account branch on
    // another device stores revision 3.
    const judged = {
      ...atTwo,
      revision: 3,
      chooser: {
        ...atTwo.chooser,
        layouts: [{ ...layout!, afterAccount: { ...layout!.afterAccount!, completion } }],
      },
    };
    state.during = async () => {
      const put = await post(
        device,
        `/v1/recipes/${recipeId}`,
        { version: 1, expectedRevision: 2, state: "active", recipe: judged },
        "PUT",
      );
      expect(put.status).toBe(200);
    };
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(
      await branchGenerate(device, emailPage, { recipeId, revision: 2 }, "other"),
    ).toMatchObject({
      status: "recipe",
      change: {
        revision: 4,
        recipe: {
          revision: 4,
          chooser: {
            afterAccount: { revision: 4, completion },
            afterOther: { revision: 4, slots: ["email"] },
          },
        },
      },
    });
    expect(
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        recipeId,
      ),
    ).toEqual([{ revision: 4 }]);
    // The log keeps the revision the rebased write stored, not the one the call started on.
    expect(await logRows(device.ownerId)).toContainEqual(
      expect.objectContaining({
        branch: `${layout!.key}:other`,
        base_revision: 2,
        revision: 4,
        recipe_page: "continuation",
      }),
    );
  });

  it("adds a handler into a branch and never judges the list shown again", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    await branchGenerate(device, passwordPage, { recipeId, revision: 1 }, "account");
    const judge = (page: LoginObservation) =>
      post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        slots: [],
        revision: 2,
        route: "password",
        branch: "account",
        observation: page,
      }).then(async (response) => projected(await response.json()));
    const calls = state.sent.length;
    expect(await judge(listPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(state.sent).toHaveLength(calls);
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    expect(
      await judge(
        observation("/login/webauthn", [
          element("key", "button", "Use security key"),
          element("recovery", "link", "Use a recovery code"),
        ]),
      ),
    ).toMatchObject({
      status: "challenge",
      change: {
        revision: 3,
        recipe: {
          chooser: {
            path: "/login",
            other: { by: "id", value: "other" },
            afterAccount: {
              revision: 3,
              handlers: [
                { kind: "passkey", path: "/login/webauthn", target: { by: "id", value: "key" } },
              ],
            },
          },
        },
      },
    });
  });
}
