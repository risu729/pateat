import {
  type LoginObservation,
  type ObservedCandidate,
  type RecipeCompletionResult,
  type RecipeGenerationResult,
  type SemanticSlot,
} from "@pateat/contracts";
import { generatedRecipeId } from "@pateat/generation";
import { expect, it } from "vitest";
import type { Device, GenerationContext } from "./context";

// Synthetic pages in the shape of a site that shows its sign-in form on whatever page it
// guards (ADR 0060 amendment of 2026-11-18): the recipe was learned where the site
// returned after its terms page, and the form shows on the site's top page later.

export function registerStartAliasCases({
  ORIGIN,
  element,
  observation,
  plan,
  owner,
  post,
  storedHead,
  rows,
  state,
}: Pick<
  GenerationContext,
  "ORIGIN" | "element" | "observation" | "plan" | "owner" | "post" | "storedHead" | "rows" | "state"
>) {
  const LEARNED = "/student/Usi/Forgotten/Success";
  const CODE = "/student/SecondFactor/ChooseAndVerifyOtp";
  const slots: SemanticSlot[] = [
    { id: "username", kind: "identifier", description: "account username" },
    { id: "password", kind: "secret", description: "account password" },
  ];
  const loginButton: ObservedCandidate = {
    id: "login",
    role: "button",
    target: { by: "text", value: "Login" },
    label: "Login",
  };
  /** The sign-in form on `path`, with `extra` candidates beside it. */
  const form = (path: string, extra: ObservedCandidate[] = []): LoginObservation =>
    observation(path, [
      element("UserName", "text", "USI or Email"),
      element("Password", "password", "Password"),
      loginButton,
      element("forgotten", "link", "Forgotten USI"),
      ...extra,
    ]);
  const layout = (key: string, path: string) => ({
    key,
    language: "en" as const,
    createdAt: Number(key),
    pageKind: "sign-in" as const,
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill" as const,
        path,
        effect: "prepare" as const,
        fields: [
          { slot: "username", target: { by: "id" as const, value: "UserName" } },
          { slot: "password", target: { by: "id" as const, value: "Password" } },
        ],
      },
      {
        kind: "click" as const,
        path,
        target: { by: "text" as const, value: "Login" },
        purpose: "submit" as const,
      },
    ],
    handlers: [
      {
        kind: "totp" as const,
        path: CODE,
        field: { by: "id" as const, value: "MfaOptions_OneTimePasscode" },
        target: { by: "id" as const, value: "nextButton" },
      },
    ],
    maxSubmissions: 2,
  });
  /** A recipe learned on `path`, written as a device writes one, with `starts` if any. */
  async function learned(device: Device, path = LEARNED, starts?: string[]) {
    const recipeId = await generatedRecipeId(ORIGIN, path);
    const document = {
      version: 1 as const,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      layouts: [layout("1700000000000", path)],
      ...(starts ? { starts } : {}),
    };
    const written = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 0, state: "active", recipe: document },
      "PUT",
    );
    expect(written.status).toBe(200);
    return { recipeId, document };
  }
  async function generate(device: Device, page: LoginObservation, extra: object = {}) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      slots,
      signedIn: false,
      ...extra,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  }
  const heads = (device: Device) =>
    rows(
      "SELECT recipe_id, revision FROM recipe_heads WHERE owner_id = ? ORDER BY recipe_id",
      device.ownerId,
    );

  it("starts the learned recipe on another path that shows its form, with no model call", async () => {
    const device = await owner();
    const { recipeId, document } = await learned(device);
    // No reply is queued: a model call would fail the request.
    const answer = await generate(device, form("/student"));
    expect(answer).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 2, state: "active" },
    });
    // The handler for the code page and the layout stay as they were learned.
    expect(await storedHead(device.ownerId, recipeId)).toEqual({
      ...document,
      revision: 2,
      starts: ["/student"],
    });
    expect(state.sent).toEqual([]);
    // No recipe of its own starts on the path.
    expect(await heads(device)).toEqual([{ recipe_id: recipeId, revision: 2 }]);
    expect(
      await rows(
        "SELECT recipe_id, outcome, path FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ recipe_id: recipeId, outcome: "recipe", path: "/student" }]);
    // The path is one of the recipe's now: it answers as it is, without another write.
    expect(await generate(device, form("/student"))).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 2 },
    });
    expect(await heads(device)).toEqual([{ recipe_id: recipeId, revision: 2 }]);
  });

  it("answers a page of another kind on such a path with its recipe too", async () => {
    const device = await owner();
    const { recipeId } = await learned(device, LEARNED, ["/student"]);
    const list = {
      ...observation("/student", [element("other", "button", "Use another account")]),
      accounts: ["Taro [email]"],
    };
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: list,
      slots: [],
    });
    expect(await response.json()).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 1 },
    });
    expect(state.sent).toEqual([]);
  });

  /** A page on `path` that is generated as before: one model call, a recipe of its own. */
  async function generatesOwn(device: Device, page: LoginObservation) {
    state.replies.push({
      text: plan(
        [
          ["username", "UserName"],
          ["password", "Password"],
        ],
        "login",
        "submit",
      ),
    });
    const answer = await generate(device, page);
    expect(answer).toMatchObject({
      status: "recipe",
      change: { recipeId: await generatedRecipeId(ORIGIN, page.path), revision: 1 },
    });
    expect(state.sent).toHaveLength(1);
  }

  it("generates a form with another password input, as one that changes the password", async () => {
    const device = await owner();
    const { recipeId, document } = await learned(device);
    await generatesOwn(
      device,
      form("/student/ChangePassword", [element("NewPassword", "password", "New password")]),
    );
    expect(await storedHead(device.ownerId, recipeId)).toEqual(document);
  });

  it("generates a page whose element of the form has another role or is missing", async () => {
    const device = await owner();
    await learned(device);
    const numbered = observation("/student/a", [
      element("UserName", "number", "USI"),
      element("Password", "password", "Password"),
      loginButton,
    ]);
    await generatesOwn(device, numbered);
    state.sent = [];
    const buttonless = observation("/student/b", [
      element("UserName", "text", "USI or Email"),
      element("Password", "password", "Password"),
      element("login", "button", "Sign in"),
    ]);
    await generatesOwn(device, buttonless);
  });

  it("generates a page whose form two recipes of the origin start with", async () => {
    const device = await owner();
    await learned(device);
    await learned(device, "/student/other");
    await generatesOwn(device, form("/student"));
  });

  it("generates a page once the recipe starts on eight paths", async () => {
    const device = await owner();
    const full = Array.from({ length: 7 }, (_, index) => `/student/page-${index}`);
    const { recipeId, document } = await learned(device, LEARNED, full);
    await generatesOwn(device, form("/student"));
    expect(await storedHead(device.ownerId, recipeId)).toEqual(document);
  });

  it("repairs the start page from one of its other start paths onto its start path", async () => {
    const device = await owner();
    const { recipeId } = await learned(device, LEARNED, ["/student"]);
    const redesigned = observation("/student", [
      element("Usi", "text", "USI or Email"),
      element("Secret", "password", "Password"),
      element("go", "button", "Log in"),
    ]);
    state.replies.push({
      text: plan(
        [
          ["username", "Usi"],
          ["password", "Secret"],
        ],
        "go",
        "submit",
      ),
    });
    const answer = await generate(device, redesigned, { repair: { recipeId, revision: 1 } });
    if (answer.status !== "recipe" || !("layouts" in answer.change.recipe))
      throw new Error(answer.status);
    const { layouts, starts } = answer.change.recipe;
    expect(starts).toEqual(["/student"]);
    expect(layouts?.map((entry) => entry.steps.map((step) => step.path))).toEqual([
      [LEARNED, LEARNED],
      [LEARNED, LEARNED],
    ]);
  });

  it("judges a page on one of its other start paths as one on its start path", async () => {
    const device = await owner();
    const { recipeId } = await learned(device, LEARNED, ["/student"]);
    const keyPage = observation("/student", [element("key", "button", "Use a security key")]);
    state.replies.push({
      text: JSON.stringify({ result: { decision: "challenge", passkeyButton: "key" } }),
    });
    const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
      version: 1,
      revision: 1,
      route: "password",
      observation: keyPage,
      slots: [],
    });
    const answer = (await response.json()) as RecipeCompletionResult;
    expect(answer).toMatchObject({ status: "challenge", change: { revision: 2 } });
    const head = (await storedHead(device.ownerId, recipeId)) as {
      layouts: { handlers: { kind: string; path: string }[] }[];
    };
    expect(head.layouts[0]!.handlers.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "totp", path: CODE },
      { kind: "passkey", path: LEARNED },
    ]);
    expect(
      await rows("SELECT path FROM page_judgements WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: LEARNED }]);
  });
}
