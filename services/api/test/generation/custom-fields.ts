import {
  type LoginObservation,
  type LoginRecipe,
  type RecipeGenerationResult,
  type SemanticSlot,
} from "@pateat/contracts";
import { expect, it } from "vitest";
import { generatedRecipeId } from "@pateat/generation";
import type { GenerationContext, Device } from "./context";

export function registerCustomFields(context: GenerationContext) {
  const {
    ORIGIN,
    slots,
    element,
    observation,
    route,
    plan,
    owner,
    post,
    documentOf,
    projected,
    rows,
    logRows,
    state,
  } = context;

  const branch: SemanticSlot = {
    id: "custom-1",
    kind: "identifier",
    description: "value of the user's vault field named in fieldName",
    fieldName: "Synthetic branch field",
  };
  const pin: SemanticSlot = {
    id: "custom-2",
    kind: "hidden",
    description: "concealed value of the user's vault field named in fieldName, such as a PIN",
    fieldName: "Synthetic PIN field",
  };
  const customSlots = [...slots, branch, pin];
  const branchPage = observation("/login", [
    element("email", "email", "Email"),
    element("branch", "text", "Branch"),
    element("next", "button", "Next"),
  ]);
  const pinPage = observation("/password", [
    { ...element("pin", "tel", "PIN"), maxLength: 4 },
    element("again", "text", "Branch again"),
    element("sign-in", "button", "Sign in"),
  ]);
  const named = (
    fields: { slot: string; candidate: string }[],
    action: string,
    purpose: "advance" | "submit",
  ) =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields,
        action: { candidate: action, purpose },
      },
    });
  async function generateCustom(device: Device, page: LoginObservation, base?: unknown) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      // A list of accounts is sent without slots (owner 2026-10-23 11:48 UTC).
      slots: page.accounts ? [] : customSlots,
      ...(base === undefined ? (page.accounts ? {} : { signedIn: false }) : { base }),
    });
    expect(response.status).toBe(200);
    return projected((await response.json()) as RecipeGenerationResult);
  }

  it("stores the page's name for the field and answers the mapping only to the call that wrote it", async () => {
    const device = await owner();
    state.replies.push({
      text: named(
        [
          { slot: "email", candidate: "email" },
          { slot: "custom-1", candidate: "branch" },
        ],
        "next",
        "advance",
      ),
    });
    const first = await generateCustom(device, branchPage);
    expect(first).toMatchObject({
      status: "recipe",
      change: { revision: 1, recipe: { slots: ["email", "Branch"] } },
      customSlots: [{ slot: "Branch", offered: "custom-1" }],
    });
    if (first.status !== "recipe") return;
    // The recipe never carries the vault field names.
    expect(JSON.stringify(first.change)).not.toContain("Synthetic");
    expect(route(first.change.recipe).steps[0]).toMatchObject({
      fields: [
        { slot: "email", target: { by: "id", value: "email" } },
        { slot: "Branch", target: { by: "id", value: "branch" } },
      ],
    });
    // A request answered with the stored recipe gets no mapping.
    const stored = await generateCustom(device, branchPage);
    expect(stored).toEqual({ version: 1, status: "recipe", change: first.change });
    expect(state.sent).toHaveLength(1);

    // A continuation maps only its own page's custom slots.
    state.replies.push({
      text: named([{ slot: "custom-2", candidate: "pin" }], "sign-in", "submit"),
    });
    const second = await generateCustom(device, pinPage, {
      recipeId: first.change.recipeId,
      revision: 1,
    });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["email", "Branch", "PIN"] } },
      customSlots: [{ slot: "PIN", offered: "custom-2" }],
    });
  });

  it("drops the alternatives of a continuation's answer, which name no slot", async () => {
    const device = await owner();
    state.replies.push({
      text: named([{ slot: "custom-1", candidate: "branch" }], "next", "advance"),
    });
    const first = await generateCustom(device, branchPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // An earlier field named the same, which only the dropped alternative fills, would
    // have taken the name and left `PIN 2` stored without a `PIN`.
    const twoPinPage = observation("/password", [
      element("old-pin", "text", "PIN"),
      ...pinPage.candidates,
    ]);
    state.replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "custom-2", candidate: "pin" }],
          action: { candidate: "sign-in", purpose: "submit" },
          alternatives: [
            {
              fields: [{ slot: "custom-1", candidate: "old-pin" }],
              action: { candidate: "sign-in", purpose: "submit" },
            },
          ],
        },
      }),
    });
    const second = await generateCustom(device, twoPinPage, {
      recipeId: first.change.recipeId,
      revision: 1,
    });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["Branch", "PIN"] } },
      customSlots: [{ slot: "PIN", offered: "custom-2" }],
    });
    if (second.status !== "recipe") return;
    expect(second.change.recipe).not.toHaveProperty("alternatives");
  });

  it("answers no mapping for a recipe without custom slots", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const result = await generateCustom(device, branchPage);
    expect(result).toMatchObject({ status: "recipe" });
    expect(result).not.toHaveProperty("customSlots");
  });

  it("fails a continuation that reuses a slot name the recipe already has", async () => {
    const device = await owner();
    state.replies.push({
      text: named([{ slot: "custom-1", candidate: "branch" }], "next", "advance"),
    });
    const first = await generateCustom(device, branchPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // Another offered field the next page names the same, in any case, would merge two
    // fields; it is refused, not numbered apart (ADR 0018).
    const branchPinPage = observation("/password", [
      { ...element("pin", "tel", "BRANCH"), maxLength: 4 },
      element("sign-in", "button", "Sign in"),
    ]);
    state.replies.push({
      text: named([{ slot: "custom-2", candidate: "pin" }], "sign-in", "submit"),
    });
    expect(
      await generateCustom(device, branchPinPage, {
        recipeId: first.change.recipeId,
        revision: 1,
      }),
    ).toEqual({ version: 1, status: "failed", error: "recipe-invalid" });
    const head = await rows(
      "SELECT revision FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ?",
      device.ownerId,
      first.change.recipeId,
    );
    expect(head).toEqual([{ revision: 1 }]);
  });

  it("answers no mapping with another device's recipe stored during the call", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const other = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      pageKind: "sign-in",
      slots: ["email", "Branch"],
      steps: [
        {
          kind: "fill",
          path: "/login",
          effect: "prepare",
          fields: [
            { slot: "email", target: { by: "id", value: "email" } },
            { slot: "Branch", target: { by: "id", value: "branch" } },
          ],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
      ],
      maxSubmissions: 1,
    };
    state.during = async () => {
      const stored = await post(
        device,
        `/v1/recipes/${recipeId}`,
        {
          version: 1,
          expectedRevision: 0,
          state: "active",
          recipe: documentOf(other as LoginRecipe),
        },
        "PUT",
      );
      expect(stored.status).toBe(200);
    };
    state.replies.push({
      text: named(
        [
          { slot: "email", candidate: "email" },
          { slot: "custom-1", candidate: "branch" },
        ],
        "next",
        "advance",
      ),
    });
    expect(await generateCustom(device, branchPage)).toEqual({
      version: 1,
      status: "recipe",
      change: { recipeId, revision: 1, state: "active", recipe: { ...other, layout: "1000" } },
    });
    // The call's own write lost, so its row names no revision.
    expect(await logRows(device.ownerId)).toMatchObject([
      { recipe_id: recipeId, base_revision: 0, revision: null, recipe_page: "first" },
    ]);
  });
}
