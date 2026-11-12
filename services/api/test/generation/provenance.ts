import {
  type LoginChooserDocument,
  type LoginObservation,
  type LoginRecipeDocument,
  type ObservedCandidate,
  type RecipeGenerationResult,
  type StoredLoginRecipe,
  isLoginRecipeDocument,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import {
  accountListGenerationPromptVersion,
  completionBesidePromptVersion,
  completionPromptVersion,
  entryGenerationPromptVersion,
  generationPromptVersion,
} from "@pateat/inference";
import { expect, it } from "vitest";
import { writeRecipe } from "../../src/recipe-store";
import { documentUnits, generatedRecipeId } from "@pateat/generation";
import type { GenerationContext, Device } from "./context";

export function registerProvenance(context: GenerationContext) {
  const {
    ORIGIN,
    slots,
    element,
    observation,
    emailPage,
    passwordPage,
    route,
    plan,
    owner,
    layoutKey,
    post,
    storedHead,
    generate,
    complete,
    rows,
    twoPageRecipe,
    state,
  } = context;

  const judgeReply = (result: unknown) => ({ text: JSON.stringify({ result }) });
  type SourceRow = {
    layout: string | null;
    unit: string;
    digest: string;
    revision: number;
    origin: string;
    provider: string | null;
    model: string | null;
    effort: string | null;
    speed: string | null;
    prompt_version: string | null;
    build: string;
    device_id: string | null;
    log_id: string | null;
    created_at: number;
  };
  /** The owner's unit rows of a recipe, in the order they were written. */
  const sources = async (ownerId: string, recipeId: string) =>
    (await rows(
      "SELECT layout, unit, digest, revision, origin, provider, model, effort, speed, prompt_version, build, device_id, log_id, created_at FROM recipe_unit_sources WHERE owner_id = ? AND recipe_id = ? ORDER BY revision, layout, unit",
      ownerId,
      recipeId,
    )) as unknown as SourceRow[];
  /** Each row's layout, unit, origin and revision, as one line. */
  const summary = async (ownerId: string, recipeId: string) =>
    (await sources(ownerId, recipeId))
      .map(({ layout, unit, origin, revision }) => `${layout} ${unit} ${origin} ${revision}`)
      .toSorted();
  /**
   * Whether every row's digest is its unit's in the stored head, split at the recorded
   * pages: units keep their digest while later writes add to the recipe.
   */
  async function digestsMatch(ownerId: string, recipeId: string) {
    const recorded = await sources(ownerId, recipeId);
    const head = (await storedHead(ownerId, recipeId)) as StoredLoginRecipe;
    const units = await documentUnits(head, recorded);
    expect(
      recorded.map(({ layout, unit, digest }) => ({ layout, unit, digest })).toSorted(byUnit),
    ).toEqual(units.toSorted(byUnit));
  }
  const byUnit = (a: { layout: string | null; unit: string }, b: typeof a) =>
    `${a.layout} ${a.unit}`.localeCompare(`${b.layout} ${b.unit}`);
  /**
   * A row as a call wrote it: the model, effort, speed and prompt version its request log
   * row names, the test build, and the device that asked.
   */
  async function fromCall(
    device: Device,
    row: SourceRow,
    expected: {
      layout: string | null;
      unit: string;
      origin: "generated" | "judged";
      revision: number;
    },
  ) {
    expect(row).toMatchObject({ ...expected, build: "test-revision", device_id: device.deviceId });
    expect(row.digest).toMatch(/^[0-9a-f]{32}$/u);
    const [logged] = await rows(
      "SELECT role, provider, model_id, effort, speed, prompt_version FROM inference_log WHERE owner_id = ? AND id = ?",
      device.ownerId,
      row.log_id,
    );
    expect(logged).toEqual({
      role: expected.origin === "generated" ? "generate" : "judge",
      provider: row.provider,
      model_id: row.model,
      effort: row.effort,
      speed: row.speed,
      prompt_version: row.prompt_version,
    });
    expect(row.provider).toBe("anthropic");
    expect(row.model).toEqual(expect.any(String));
  }

  it("records each page, the judge's handlers and its marker as units of their layout", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const { recipeId } = change;
    const key = (await layoutKey(device.ownerId, recipeId))!;
    // One judgement adds two handlers: one row each, under the same request log row.
    const code = {
      ...element("app-code", "text", "Authentication code"),
      autocomplete: "one-time-code" as const,
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    const mfa = observation("/login/mfa", [
      code,
      element("verify", "button", "Verify"),
      element("key", "button", "Use security key"),
    ]);
    state.replies.push(
      judgeReply({
        decision: "challenge",
        passkeyButton: "key",
        code: { field: "app-code", submit: "verify", source: "authenticator-app" },
      }),
    );
    expect((await complete(device, recipeId, 2, mfa)).body).toMatchObject({
      status: "challenge",
      change: { revision: 3 },
    });
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, recipeId, 3)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 4 },
    });
    const written = await sources(device.ownerId, recipeId);
    // The email page's fill and click come first, so the password page starts at 2; the
    // handlers and the marker are named by their index.
    expect(written.map(({ unit }) => unit)).toEqual([
      "page:0",
      "page:2",
      "handler:0",
      "handler:1",
      "marker:0",
    ]);
    const unit = (id: string) => written.find((row) => row.unit === id)!;
    await fromCall(device, unit("page:0"), {
      layout: key,
      unit: "page:0",
      origin: "generated",
      revision: 1,
    });
    await fromCall(device, unit("page:2"), {
      layout: key,
      unit: "page:2",
      origin: "generated",
      revision: 2,
    });
    for (const id of ["handler:0", "handler:1"])
      // oxlint-disable-next-line no-await-in-loop -- Each row is read on its own.
      await fromCall(device, unit(id), { layout: key, unit: id, origin: "judged", revision: 3 });
    expect(unit("handler:0").log_id).toBe(unit("handler:1").log_id);
    await fromCall(device, unit("marker:0"), {
      layout: key,
      unit: "marker:0",
      origin: "judged",
      revision: 4,
    });
    // Each unit names its own call, and the generation rows their prompt version.
    expect(new Set(written.map((row) => row.log_id)).size).toBe(4);
    expect(unit("page:0").prompt_version).toBe(await generationPromptVersion());
    expect(unit("marker:0").prompt_version).toBe(await completionPromptVersion());
    // The first page's digest, written at revision 1, still names its content at revision 4.
    await digestsMatch(device.ownerId, recipeId);
    // The synced document carries none of it.
    const document = JSON.stringify(await storedHead(device.ownerId, recipeId));
    for (const value of [
      device.deviceId,
      device.ownerId,
      unit("page:0").model!,
      unit("page:0").digest,
      "test-revision",
    ])
      expect(document).not.toContain(value);
  });

  it("records a page that replaced a disabled final click where that click stood (ADR 0018)", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    const { recipeId } = first.change;
    const key = (await layoutKey(device.ownerId, recipeId))!;
    // The same page once the email is typed: a password input opened, Next still disabled.
    const opened = observation("/login", [
      element("email", "email", "Email"),
      element("password", "password", "Password"),
      element("next", "button", "Next"),
    ]);
    state.replies.push({ text: plan([["password", "password"]], "next", "submit") });
    const replaced = await generate(device, opened, {
      recipeId,
      revision: 1,
      replacesLast: true,
    });
    expect(replaced).toMatchObject({ status: "recipe", change: { revision: 2 } });
    if (replaced.status !== "recipe") throw new Error(replaced.status);
    expect(route(replaced.change.recipe!)).toMatchObject({
      slots: ["email", "password"],
      maxSubmissions: 1,
      steps: [
        { kind: "fill", fields: [{ slot: "email" }] },
        { kind: "fill", fields: [{ slot: "password" }] },
        { kind: "click", target: { by: "id", value: "next" }, purpose: "submit" },
      ],
    });
    // The email fill keeps its call, with the digest of what is left of its page.
    expect(await summary(device.ownerId, recipeId)).toEqual([
      `${key} page:0 generated 1`,
      `${key} page:1 generated 2`,
    ]);
    await digestsMatch(device.ownerId, recipeId);
  });

  it("refuses a replacing page that does not end with the replaced click (ADR 0018)", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    const opened = observation("/login", [
      element("email", "email", "Email"),
      element("password", "password", "Password"),
      element("next", "button", "Next"),
      element("help", "button", "Help"),
    ]);
    state.replies.push({ text: plan([["password", "password"]], "help", "submit") });
    expect(
      await generate(device, opened, {
        recipeId: first.change.recipeId,
        revision: 1,
        replacesLast: true,
      }),
    ).toMatchObject({ status: "failed", error: "recipe-invalid" });
    expect(await storedHead(device.ownerId, first.change.recipeId)).toMatchObject({
      revision: 1,
    });
  });

  it("records a judged detail handler (ADR 0061) as a handler unit of its layout", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const { recipeId } = change;
    const key = (await layoutKey(device.ownerId, recipeId))!;
    // One judgement keeps a passkey handler and a detail handler: one row each, under the
    // judge's request log row, in the order they are appended.
    state.replies.push(
      judgeReply({
        decision: "challenge",
        passkeyButton: "key",
        details: [{ field: "phone", value: "phone-last-4" }],
        detailSubmit: "confirm",
      }),
    );
    const page = observation("/login/confirm", [
      { ...element("phone", "tel", "Last 4 digits of your phone"), maxLength: 4 },
      element("confirm", "button", "Next"),
      element("key", "button", "Use security key"),
    ]);
    const judged = await complete(device, recipeId, 2, page);
    expect(judged.body).toMatchObject({ status: "challenge", change: { revision: 3 } });
    if (!("change" in judged.body) || !judged.body.change) throw new Error("no change");
    expect(route(judged.body.change.recipe).handlers?.map((handler) => handler.kind)).toEqual([
      "passkey",
      "detail",
    ]);
    const written = await sources(device.ownerId, recipeId);
    expect(written.map(({ unit }) => unit)).toEqual(["page:0", "page:2", "handler:0", "handler:1"]);
    const unit = (id: string) => written.find((row) => row.unit === id)!;
    for (const id of ["handler:0", "handler:1"])
      // oxlint-disable-next-line no-await-in-loop -- Each row is read on its own.
      await fromCall(device, unit(id), { layout: key, unit: id, origin: "judged", revision: 3 });
    expect(unit("handler:1").log_id).toBe(unit("handler:0").log_id);
    expect(unit("handler:1").prompt_version).toBe(await completionPromptVersion());
    await digestsMatch(device.ownerId, recipeId);
  });

  it("records a detail handler judged beside the sign-in form into that layout only (ADR 0061)", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    // Two layouts of the sign-in page; the second fills both fields in one form.
    const signInRoute = (fields: [string, string][], button: string) => ({
      pageKind: "sign-in" as const,
      slots: fields.map(([slot]) => slot),
      steps: [
        {
          kind: "fill" as const,
          path: "/login",
          effect: "prepare" as const,
          fields: fields.map(([slot, id]) => ({ slot, target: { by: "id" as const, value: id } })),
        },
        {
          kind: "click" as const,
          path: "/login",
          target: { by: "id" as const, value: button },
          purpose: "submit" as const,
        },
      ],
      maxSubmissions: 1,
    });
    const layouts = [
      { key: "1000", createdAt: 1000, ...signInRoute([["email", "email"]], "next") },
      {
        key: "2000",
        createdAt: 2000,
        ...signInRoute(
          [
            ["email", "user"],
            ["password", "pass"],
          ],
          "go",
        ),
      },
    ];
    const written = await post(
      device,
      `/v1/recipes/${recipeId}`,
      {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: { version: 1, id: recipeId, revision: 1, origin: ORIGIN, layouts },
      },
      "PUT",
    );
    expect(written.status).toBe(200);
    // The second layout's sign-in form still shows, beside a form that asks for a detail.
    const inForm = (group: string, candidate: ObservedCandidate) => ({ ...candidate, group });
    const page = observation("/login", [
      inForm("side", element("user", "email", "Email")),
      inForm("side", element("pass", "password", "Password")),
      inForm("side", element("go", "button", "Sign in")),
      { ...inForm("box", element("phone", "text", "Last 4 phone digits")), maxLength: 4 },
      inForm("box", element("confirm", "button", "Log in")),
    ]);
    state.replies.push(
      judgeReply({
        decision: "challenge",
        details: [{ field: "phone", value: "phone-last-4" }],
        detailSubmit: "confirm",
      }),
    );
    const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
      version: 1,
      revision: 1,
      route: "password",
      branch: "2000",
      observation: page,
      slots: [],
      beside: true,
    });
    expect(await response.json()).toMatchObject({ status: "challenge", change: { revision: 2 } });
    const head = (await storedHead(device.ownerId, recipeId)) as LoginRecipeDocument;
    expect(head.layouts.map((layout) => layout.handlers?.map((handler) => handler.kind))).toEqual([
      undefined,
      ["detail"],
    ]);
    // The judged page is keyed by that layout, under the beside prompt version.
    expect(
      await rows(
        "SELECT branch, path, prompt_version, verdict FROM page_judgements WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      {
        branch: "2000",
        path: "/login",
        prompt_version: await completionBesidePromptVersion(),
        verdict: "challenge",
      },
    ]);
    const [row, ...others] = (await sources(device.ownerId, recipeId)).filter(
      (source) => source.origin === "judged",
    );
    expect(others).toEqual([]);
    await fromCall(device, row!, {
      layout: "2000",
      unit: "handler:0",
      origin: "judged",
      revision: 2,
    });
    expect(row!.prompt_version).toBe(await completionBesidePromptVersion());
    await digestsMatch(device.ownerId, recipeId);
  });

  it("names a chooser's list and each branch's units under the branch", async () => {
    const device = await owner();
    const listPage: LoginObservation = {
      ...observation("/login", [
        element("other", "button", "Sign in with another profile"),
        element("help", "link", "Help"),
      ]),
      accounts: ["[email] Last used", "[email]"],
    };
    state.replies.push({
      text: JSON.stringify({ result: { decision: "account-list", other: "other" } }),
    });
    const list = await generate(device, listPage);
    if (list.status !== "recipe") throw new Error(list.status);
    const { recipeId } = list.change;
    const key = (await layoutKey(device.ownerId, recipeId))!;
    const branchPage = async (page: LoginObservation, revision: number, branch: string) =>
      post(device, "/v1/recipes/generate", {
        version: 1,
        observation: page,
        slots,
        base: { recipeId, revision },
        branch,
      });
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect((await branchPage(passwordPage, 1, "account")).status).toBe(200);
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect((await branchPage(emailPage, 2, "other")).status).toBe(200);
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect((await branchPage(passwordPage, 3, "other")).status).toBe(200);
    // A handler judged on the account branch's page.
    state.replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    const judged = await post(device, `/v1/recipes/${recipeId}/completion`, {
      version: 1,
      revision: 4,
      route: "password",
      branch: "account",
      observation: observation("/login/webauthn", [element("key", "button", "Use security key")]),
      slots: [],
    });
    expect(await judged.json()).toMatchObject({ status: "challenge", change: { revision: 5 } });
    expect(await summary(device.ownerId, recipeId)).toEqual(
      [
        `${key} list generated 1`,
        `${key} account/page:0 generated 2`,
        `${key} other/page:0 generated 3`,
        `${key} other/page:2 generated 4`,
        `${key} account/handler:0 judged 5`,
      ].toSorted(),
    );
    const written = await sources(device.ownerId, recipeId);
    expect(written.find((row) => row.unit === "list")!.prompt_version).toBe(
      await accountListGenerationPromptVersion(),
    );
    await digestsMatch(device.ownerId, recipeId);
  });

  it("carries a passkey-only layout's learned units into the passkey route beside its list (ADR 0079)", async () => {
    const device = await owner();
    const button = element("key", "button", "Sign in with a passkey");
    state.replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [],
          action: { candidate: "key", purpose: "submit" },
          passkeyButton: "key",
        },
      }),
    });
    const started = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: observation("/login", [button]),
      slots: [],
      passkeyOnly: true,
      signedIn: false,
    });
    const first = (await started.json()) as RecipeGenerationResult;
    if (first.status !== "recipe" || !isLoginRecipeDocument(first.change.recipe))
      throw new Error("Expected a passkey-only recipe");
    const { recipeId } = first.change;
    const stored = first.change.recipe;
    const old = stored.layouts[0]!.key;
    // A device learns the layout's signed-in marker.
    const marked = await post(
      device,
      `/v1/recipes/${recipeId}`,
      {
        version: 1,
        expectedRevision: 1,
        state: "active",
        recipe: {
          ...stored,
          revision: 2,
          layouts: [
            { ...stored.layouts[0]!, completion: [{ target: { by: "id", value: "logout" } }] },
          ],
        },
      },
      "PUT",
    );
    expect(marked.status).toBe(200);
    // Its start page now lists accounts beside the same button: the repair adds a list whose
    // layout copies the passkey-only route with its marker, and the passkey-only layout
    // stays beside it (#1248).
    state.replies.push({
      text: JSON.stringify({
        result: { decision: "account-list", other: "other", passkeyButton: "key" },
      }),
    });
    const repaired = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: {
        ...observation("/login", [element("other", "button", "Use another account"), button]),
        accounts: ["[email]"],
      },
      slots: [],
      repair: { recipeId, revision: 2 },
    });
    expect(await repaired.json()).toMatchObject({ status: "recipe", change: { revision: 3 } });
    const head = (await storedHead(device.ownerId, recipeId)) as LoginChooserDocument;
    expect(head.layouts?.map((entry) => entry.key)).toEqual([old]);
    const [layout, ...others] = head.chooser.layouts;
    expect(others).toEqual([]);
    expect(layout!.key).not.toBe(old);
    expect(layout!.passkey).toEqual({
      pageKind: "sign-in",
      slots: [],
      passkeyOnly: true,
      passkey: { path: "/login", target: { by: "id", value: "key" } },
      steps: [
        { kind: "click", path: "/login", target: { by: "id", value: "key" }, purpose: "submit" },
      ],
      maxSubmissions: 1,
      completion: [{ target: { by: "id", value: "logout" } }],
    });
    // The marker keeps the device that learned it; the list and the button are this call's.
    // The passkey-only layout keeps its own rows.
    expect(await summary(device.ownerId, recipeId)).toEqual(
      [
        `${old} page:0 generated 1`,
        `${old} marker:0 device 2`,
        `${layout!.key} list generated 3`,
        `${layout!.key} passkey/page:0 generated 3`,
        `${layout!.key} passkey/marker:0 device 2`,
      ].toSorted(),
    );
    await digestsMatch(device.ownerId, recipeId);
  });

  it("drops the units of a passkey route beside a list put in place of another (ADR 0079)", async () => {
    const device = await owner();
    const page = (button: string): LoginObservation => ({
      ...observation("/login", [
        element("other", "button", "Use another account"),
        element(button, "button", "Sign in with a passkey"),
      ]),
      accounts: ["[email]"],
    });
    const answer = (passkeyButton: string) => ({
      text: JSON.stringify({
        result: { decision: "account-list", other: "other", passkeyButton },
      }),
    });
    state.replies.push(answer("key"));
    const list = await generate(device, page("key"));
    if (list.status !== "recipe") throw new Error(list.status);
    const { recipeId } = list.change;
    const stored = (await storedHead(device.ownerId, recipeId)) as LoginChooserDocument;
    const [layout] = stored.chooser.layouts;
    // A device learns the passkey route's signed-in marker.
    const marked = await post(
      device,
      `/v1/recipes/${recipeId}`,
      {
        version: 1,
        expectedRevision: 1,
        state: "active",
        recipe: {
          ...stored,
          revision: 2,
          chooser: {
            ...stored.chooser,
            layouts: [
              {
                ...layout!,
                passkey: {
                  ...layout!.passkey!,
                  completion: [{ target: { by: "id", value: "logout" } }],
                },
              },
            ],
          },
        },
      },
      "PUT",
    );
    expect(marked.status).toBe(200);
    expect(await summary(device.ownerId, recipeId)).toContain(
      `${layout!.key} passkey/marker:0 device 2`,
    );
    // A passkey route is stored whole: a request for its next page is refused before a call.
    const calls = state.sent.length;
    const continued = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: passwordPage,
      slots,
      base: { recipeId, revision: 2 },
      branch: `${layout!.key}:passkey`,
    });
    expect(await continued.json()).toMatchObject({ reason: "recipe-conflict" });
    expect(state.sent).toHaveLength(calls);
    // The list repaired with another button: its route takes the old one's place, and the
    // old route's marker row goes with it.
    state.replies.push(answer("passkey"));
    const repaired = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page("passkey"),
      slots: [],
      repair: { recipeId, revision: 2 },
    });
    expect(await repaired.json()).toMatchObject({ status: "recipe", change: { revision: 3 } });
    expect(await summary(device.ownerId, recipeId)).toEqual(
      [`${layout!.key} list generated 1`, `${layout!.key} passkey/page:0 generated 3`].toSorted(),
    );
    await digestsMatch(device.ownerId, recipeId);
  });

  it("writes a branch's page rebased onto the other branch's newer head as its own unit", async () => {
    const device = await owner();
    const listPage: LoginObservation = {
      ...observation("/login", [
        element("other", "button", "Sign in with another profile"),
        element("help", "link", "Help"),
      ]),
      accounts: ["[email] Last used", "[email]"],
    };
    state.replies.push({
      text: JSON.stringify({ result: { decision: "account-list", other: "other" } }),
    });
    const list = await generate(device, listPage);
    if (list.status !== "recipe") throw new Error(list.status);
    const { recipeId } = list.change;
    const key = (await layoutKey(device.ownerId, recipeId))!;
    const branchPage = async (page: LoginObservation, revision: number, branch: string) =>
      post(device, "/v1/recipes/generate", {
        version: 1,
        observation: page,
        slots,
        base: { recipeId, revision },
        branch,
      });
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect((await branchPage(passwordPage, 1, "account")).status).toBe(200);
    // While the other branch's first page is generated, another device stores a marker of
    // the account branch, so the other page loses once and is written again onto that head.
    const atTwo = (await storedHead(device.ownerId, recipeId)) as LoginChooserDocument;
    const [layout] = atTwo.chooser.layouts;
    state.during = async () => {
      const put = await post(
        device,
        `/v1/recipes/${recipeId}`,
        {
          version: 1,
          expectedRevision: 2,
          state: "active",
          recipe: {
            ...atTwo,
            revision: 3,
            chooser: {
              ...atTwo.chooser,
              layouts: [
                {
                  ...layout!,
                  afterAccount: {
                    ...layout!.afterAccount!,
                    completion: [{ target: { by: "id", value: "logout" } }],
                  },
                },
              ],
            },
          },
        },
        "PUT",
      );
      expect(put.status).toBe(200);
    };
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await (await branchPage(emailPage, 2, "other")).json()).toMatchObject({
      status: "recipe",
      change: { revision: 4 },
    });
    // The rebased write records its page once, at the revision it stored; the device's
    // marker is its own, and the units it left as they were keep their calls.
    expect(await summary(device.ownerId, recipeId)).toEqual(
      [
        `${key} list generated 1`,
        `${key} account/page:0 generated 2`,
        `${key} account/marker:0 device 3`,
        `${key} other/page:0 generated 4`,
      ].toSorted(),
    );
    const written = await sources(device.ownerId, recipeId);
    const other = written.find((row) => row.unit === "other/page:0")!;
    // The other page's row names the other page's own call.
    const [logged] = await rows(
      "SELECT branch, revision FROM inference_log WHERE owner_id = ? AND id = ?",
      device.ownerId,
      other.log_id,
    );
    expect(logged).toEqual({ branch: `${key}:other`, revision: 4 });
    await digestsMatch(device.ownerId, recipeId);
  });

  it("records an entry recipe as one unit without a layout", async () => {
    const device = await owner();
    const topPage = observation("/en/", [
      { id: "c1", role: "link", target: { by: "text", value: "Login" } },
    ]);
    state.replies.push({ text: JSON.stringify({ result: { decision: "entry", entry: "c1" } }) });
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: topPage,
    });
    expect(await response.json()).toMatchObject({ status: "recipe" });
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    const [row, ...others] = await sources(device.ownerId, recipeId);
    expect(others).toEqual([]);
    await fromCall(device, row!, { layout: null, unit: "entry", origin: "generated", revision: 1 });
    expect(row!.prompt_version).toBe(await entryGenerationPromptVersion());
    // The database refuses a second row for it, though its layout is null.
    await expect(
      env.DB.prepare(
        "INSERT INTO recipe_unit_sources SELECT owner_id, recipe_id, layout, unit, digest, revision, origin, provider, model, effort, speed, prompt_version, build, device_id, log_id, created_at FROM recipe_unit_sources WHERE owner_id = ?",
      )
        .bind(device.ownerId)
        .run(),
    ).rejects.toThrow(/UNIQUE/u);
  });

  it("marks only the units a device's document changes or adds as the device's", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const { recipeId } = change;
    const key = (await layoutKey(device.ownerId, recipeId))!;
    const put = async (expectedRevision: number, recipe: unknown) =>
      (
        await post(
          device,
          `/v1/recipes/${recipeId}`,
          { version: 1, expectedRevision, state: "active", recipe },
          "PUT",
        )
      ).status;
    const stored = (await storedHead(device.ownerId, recipeId)) as LoginRecipeDocument;
    const [layout] = stored.layouts;
    // The same document written back keeps every row as the calls wrote it.
    expect(await put(2, { ...stored, revision: 3 })).toBe(200);
    expect(await summary(device.ownerId, recipeId)).toEqual(
      [`${key} page:0 generated 1`, `${key} page:2 generated 2`].toSorted(),
    );
    // A changed second page, a handler, a marker and another layout are the device's; the
    // first page it left as it was keeps its call.
    const [fill, click, ...rest] = layout!.steps;
    const changed = {
      ...stored,
      revision: 4,
      layouts: [
        {
          ...layout!,
          steps: [fill!, click!, ...rest.map((step) => ({ ...step, path: "/signin" }))],
          handlers: [
            { kind: "passkey" as const, path: "/mfa", target: { by: "id" as const, value: "key" } },
          ],
          completion: [{ target: { by: "id" as const, value: "logout" } }],
        },
        { ...layout!, key: "1000", createdAt: 1000 },
      ],
    };
    expect(await put(3, changed)).toBe(200);
    expect(await summary(device.ownerId, recipeId)).toEqual(
      [
        `${key} page:0 generated 1`,
        `${key} page:2 device 4`,
        `${key} handler:0 device 4`,
        `${key} marker:0 device 4`,
        // A layout with no recorded pages is one `page:0`.
        "1000 page:0 device 4",
      ].toSorted(),
    );
    for (const row of (await sources(device.ownerId, recipeId)).filter(
      (entry) => entry.origin === "device",
    ))
      expect(row).toMatchObject({
        provider: null,
        model: null,
        effort: null,
        speed: null,
        prompt_version: null,
        build: "test-revision",
        device_id: device.deviceId,
        log_id: null,
      });
    await digestsMatch(device.ownerId, recipeId);
    // A document without the handler, the marker and the other layout drops their rows.
    expect(
      await put(4, {
        ...changed,
        revision: 5,
        layouts: [{ ...changed.layouts[0]!, handlers: undefined, completion: undefined }],
      }),
    ).toBe(200);
    expect(await summary(device.ownerId, recipeId)).toEqual(
      [`${key} page:0 generated 1`, `${key} page:2 device 4`].toSorted(),
    );
    // A device's revocation deletes every row of the recipe.
    const revoked = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 5, state: "revoked" },
      "PUT",
    );
    expect(revoked.status).toBe(200);
    expect(await sources(device.ownerId, recipeId)).toEqual([]);
  });

  it("writes no row for a write that lost, and keeps the winner's", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    const { recipeId } = first.change;
    // Another device's write lands while the continuation's call runs.
    state.during = async () => {
      const head = (await storedHead(device.ownerId, recipeId)) as LoginRecipeDocument;
      const result = await writeRecipe(
        env.DB,
        device.ownerId,
        recipeId,
        {
          version: 1,
          expectedRevision: 1,
          state: "active",
          recipe: {
            ...head,
            revision: 2,
            layouts: [{ ...head.layouts[0]!, rejection: { by: "id", value: "error" } }],
          },
        },
        device.deviceId,
        { sources: { origin: "device" } },
      );
      expect(result.ok).toBe(true);
    };
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    await generate(device, passwordPage, { recipeId, revision: 1 });
    // The device's row replaced the first page's; the page that lost added none.
    expect(await summary(device.ownerId, recipeId)).toEqual([
      `${await layoutKey(device.ownerId, recipeId)} page:0 device 2`,
    ]);
  });
}
