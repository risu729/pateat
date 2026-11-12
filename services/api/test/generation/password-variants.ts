import { type RecipeGenerationResult, type SemanticSlot } from "@pateat/contracts";
import { expect, it } from "vitest";
import type { GenerationContext, Device } from "./context";

export function registerPasswordVariants(context: GenerationContext) {
  const {
    ORIGIN,
    slots,
    element,
    observation,
    passwordPage,
    homePage,
    owner,
    post,
    documentOf,
    projected,
    generate,
    complete,
    rows,
    state,
  } = context;

  const custom = (id: string, fieldName: string): SemanticSlot => ({
    id,
    kind: "identifier",
    description: "value of the user's vault field named in fieldName",
    fieldName,
  });
  const variantSlots = [
    ...slots,
    custom("custom-1", "Synthetic branch field"),
    custom("custom-2", "Synthetic account field"),
    custom("custom-3", "Synthetic contract field"),
  ];
  const twoSetsPage = observation("/login", [
    element("branch", "text", "Branch"),
    element("account", "text", "Account"),
    element("contract", "text", "Or contract number"),
    element("password", "password", "Password"),
    element("sign-in", "button", "Sign in"),
  ]);
  const byBranch = [
    { slot: "custom-1", candidate: "branch" },
    { slot: "custom-2", candidate: "account" },
    { slot: "password", candidate: "password" },
  ];
  const byContract = [
    { slot: "custom-3", candidate: "contract" },
    { slot: "password", candidate: "password" },
  ];
  const twoSets = (alternative = byContract, purpose: "advance" | "submit" = "submit") =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields: byBranch,
        action: { candidate: "sign-in", purpose: "submit" },
        alternatives: [{ fields: alternative, action: { candidate: "sign-in", purpose } }],
      },
    });
  async function generateVariants(device: Device) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: twoSetsPage,
      slots: variantSlots,
      signedIn: false,
    });
    expect(response.status).toBe(200);
    return projected((await response.json()) as RecipeGenerationResult);
  }

  it("stores each identifier set as a variant and maps the custom slots of all of them", async () => {
    const device = await owner();
    state.replies.push({ text: twoSets() });
    const result = await generateVariants(device);
    expect(result).toMatchObject({
      status: "recipe",
      change: {
        revision: 1,
        recipe: {
          slots: ["Branch", "Account", "password"],
          alternatives: [{ slots: ["Or contract number", "password"] }],
          maxSubmissions: 1,
        },
      },
      // The password slot is named in both sets but is no custom slot; each name once.
      customSlots: [
        { slot: "Branch", offered: "custom-1" },
        { slot: "Account", offered: "custom-2" },
        { slot: "Or contract number", offered: "custom-3" },
      ],
    });
    if (result.status !== "recipe") return;
    expect(JSON.stringify(result.change)).not.toContain("Synthetic");
    // The request log keeps the sets the model returned, with the names the page gave.
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    const [branch, account, password] = byBranch;
    expect(JSON.parse(String(logged!.result))).toEqual({
      pageKind: "sign-in",
      irreversible: "no",
      fields: [{ ...branch, name: "Branch" }, { ...account, name: "Account" }, password],
      action: { candidate: "sign-in", purpose: "submit" },
      alternatives: [
        {
          fields: [{ ...byContract[0], name: "Or contract number" }, byContract[1]],
          action: { candidate: "sign-in", purpose: "submit" },
        },
      ],
    });
    // A recipe whose sets all submit is never continued.
    expect(
      await generate(device, passwordPage, { recipeId: result.change.recipeId, revision: 1 }),
    ).toEqual({ version: 1, status: "unavailable", reason: "recipe-conflict" });
    expect(state.sent).toHaveLength(1);
  });

  it("fails the whole plan when an alternative does not pass the checks", async () => {
    const device = await owner();
    state.replies.push({ text: twoSets(byContract, "advance") });
    expect(await generateVariants(device)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "variant-advance" },
    });
    const other = await owner();
    state.replies.push({
      text: twoSets([
        { slot: "custom-3", candidate: "branch" },
        { slot: "password", candidate: "password" },
      ]),
    });
    expect(await generateVariants(other)).toMatchObject({
      status: "failed",
      rejection: { check: "plan", reason: "inconsistent-candidate" },
    });
    expect(
      await rows(
        "SELECT * FROM recipe_revisions WHERE owner_id IN (?, ?)",
        device.ownerId,
        other.ownerId,
      ),
    ).toEqual([]);
  });

  it("does not judge a page that shows any variant's fill field, and never takes a variant", async () => {
    const device = await owner();
    state.replies.push({ text: twoSets() });
    const result = await generateVariants(device);
    if (result.status !== "recipe") throw new Error(result.status);
    const calls = state.sent.length;
    const contractAgain = observation("/error", [
      element("contract", "text", "Contract number"),
      element("retry", "button", "Try again"),
    ]);
    expect((await complete(device, result.change.recipeId, 1, contractAgain)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    const named = await post(device, `/v1/recipes/${result.change.recipeId}/completion`, {
      version: 1,
      slots: [],
      revision: 1,
      route: "password",
      variant: 1,
      observation: homePage,
    });
    expect(named.status).toBe(400);
    expect(state.sent).toHaveLength(calls);
    // A signed-in page elsewhere learns the completion and keeps the alternatives.
    state.replies.push({
      text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }),
    });
    expect((await complete(device, result.change.recipeId, 1)).body).toMatchObject({
      status: "signed-in",
      change: {
        revision: 2,
        recipe: {
          completion: [{ target: { by: "id", value: "logout" } }],
          alternatives: [{ slots: ["Or contract number", "password"] }],
        },
      },
    });
    const [logged] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      route: "password",
      loginPaths: ["/login"],
    });
    expect(JSON.parse(String(logged!.request))).not.toHaveProperty("variant");
  });

  it("maps a custom slot that several sets share once", async () => {
    const device = await owner();
    // Both sets ask for the branch number; the second adds a contract number instead of
    // the account number.
    state.replies.push({
      text: twoSets([
        { slot: "custom-1", candidate: "branch" },
        { slot: "custom-3", candidate: "contract" },
        { slot: "password", candidate: "password" },
      ]),
    });
    expect(await generateVariants(device)).toMatchObject({
      status: "recipe",
      change: {
        recipe: {
          slots: ["Branch", "Account", "password"],
          alternatives: [{ slots: ["Branch", "Or contract number", "password"] }],
        },
      },
      customSlots: [
        { slot: "Branch", offered: "custom-1" },
        { slot: "Account", offered: "custom-2" },
        { slot: "Or contract number", offered: "custom-3" },
      ],
    });
  });

  it("names every variant's path to the judge and refuses a page on any of them", async () => {
    const device = await owner();
    // An owner-written recipe whose second variant continues on its own page.
    const recipeId = "shop-variants";
    const fill = (path: string, slot: string) => ({
      kind: "fill" as const,
      effect: "prepare" as const,
      path,
      fields: [{ slot, target: { by: "id" as const, value: slot } }],
    });
    const click = (path: string, value: string, purpose: "advance" | "submit") => ({
      kind: "click" as const,
      path,
      target: { by: "id" as const, value },
      purpose,
    });
    const stored = await post(
      device,
      `/v1/recipes/${recipeId}`,
      {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: documentOf({
          version: 1,
          id: recipeId,
          revision: 1,
          origin: ORIGIN,
          pageKind: "sign-in",
          slots: ["email"],
          steps: [fill("/login", "email"), click("/login", "sign-in", "submit")],
          alternatives: [
            {
              slots: ["member", "pin"],
              steps: [
                fill("/login", "member"),
                click("/login", "next", "advance"),
                fill("/verify", "pin"),
                click("/verify", "confirm", "submit"),
              ],
            },
          ],
          maxSubmissions: 2,
        }),
      },
      "PUT",
    );
    expect(stored.status).toBe(200);
    // The alternative's later field, shown on another path, is still a sign-in page.
    const pinAgain = observation("/retry", [element("pin", "password", "PIN")]);
    expect((await complete(device, recipeId, 1, pinAgain)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(state.sent).toEqual([]);
    state.replies.push({
      text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }),
    });
    expect((await complete(device, recipeId, 1)).body).toMatchObject({ status: "signed-in" });
    const [logged] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      loginPaths: ["/login", "/verify"],
    });
  });
}
