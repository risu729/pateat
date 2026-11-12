import {
  type LoginObservation,
  type RecipeGenerationResult,
  type SemanticSlot,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { writeRecipe } from "../../src/recipe-store";
import { generatedRecipeId } from "@pateat/generation";
import type { GenerationContext, Device } from "./context";

export function registerSavedSlotNames(context: GenerationContext) {
  const {
    ORIGIN,
    slots,
    element,
    observation,
    emailPage,
    route,
    plan,
    owner,
    post,
    projected,
    generate,
    rows,
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
  const branchPage = (label = "Branch code") =>
    observation("/login", [
      element("email", "email", "Email"),
      element("branch", "text", label),
      element("next", "button", "Next"),
    ]);
  const pinPage = (label = "PIN") =>
    observation("/password", [
      { ...element("pin", "tel", label), maxLength: 4 },
      element("sign-in", "button", "Sign in"),
    ]);
  const fields = (...pairs: [string, string][]) =>
    pairs.map(([slot, candidate]) => ({ slot, candidate }));
  const named = (
    filled: { slot: string; candidate: string }[],
    action: string,
    purpose: "advance" | "submit",
  ) =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields: filled,
        action: { candidate: action, purpose },
      },
    });
  const branchField = { custom: "Synthetic branch field" };
  const pinField = { custom: "Synthetic PIN field" };
  type Entry = { slot: string; field: unknown };
  /** One synthetic account's saved binding of `recipeId`, with the email as its username. */
  const binding = (recipeId: string, item: string, ...entries: Entry[]) => ({
    recipeId,
    origin: ORIGIN,
    provider: "bitwarden",
    server: "cloud-us",
    userId: "user-1",
    itemId: item,
    itemName: `Synthetic ${item}`,
    slots: [{ slot: "email", field: "username" }, ...entries],
  });
  async function saveBindings(device: Device, ...bindings: ReturnType<typeof binding>[]) {
    const response = await post(
      device,
      "/v1/settings",
      {
        version: 1,
        expectedRevision: 0,
        settings: {
          connections: [],
          accountPolicies: [],
          itemPolicies: [],
          customFieldReviews: [],
          excludedSites: [],
          passkeyBrowserSites: [],
          siteDefaults: [],
          bindings,
        },
      },
      "PUT",
    );
    expect(response.status).toBe(200);
  }
  async function generateCustom(
    device: Device,
    page: LoginObservation,
    base?: unknown,
    branchName?: string,
  ) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      // A list of accounts is sent without slots (owner 2026-10-23 11:48 UTC).
      slots: page.accounts ? [] : customSlots,
      ...(base === undefined ? (page.accounts ? {} : { signedIn: false }) : { base }),
      ...(branchName === undefined ? {} : { branch: branchName }),
    });
    expect(response.status).toBe(200);
    return projected((await response.json()) as RecipeGenerationResult);
  }
  /** The prompt of the last model call, as sent. */
  const lastPrompt = () => JSON.stringify(state.sent.at(-1)?.body);

  it("keeps a revoked recipe's slot name when its page is generated again with new wording", async () => {
    const device = await owner();
    state.replies.push({
      text: named(fields(["email", "email"], ["custom-1", "branch"]), "next", "advance"),
    });
    const first = await generateCustom(device, branchPage("店番"));
    expect(first).toMatchObject({ change: { recipe: { slots: ["email", "店番"] } } });
    if (first.status !== "recipe") throw new Error(first.status);
    const { recipeId } = first.change;
    // A binding of another recipe or origin names the same field otherwise, and is not read.
    const elsewhere = binding("gen-other", "item-1", { slot: "支店", field: branchField });
    await saveBindings(
      device,
      binding(recipeId, "item-1", { slot: "店番", field: branchField }),
      elsewhere,
      { ...elsewhere, recipeId, origin: "https://other.example.test" },
    );
    expect(
      await writeRecipe(
        env.DB,
        device.ownerId,
        recipeId,
        { version: 1, expectedRevision: 1, state: "revoked" },
        null,
      ),
    ).toMatchObject({ ok: true });

    state.replies.push({
      text: named(fields(["email", "email"], ["custom-1", "branch"]), "next", "advance"),
    });
    const again = await generateCustom(device, branchPage("支店コード (半角)"));
    expect(again).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 3, recipe: { slots: ["email", "店番"] } },
      customSlots: [{ slot: "店番", offered: "custom-1" }],
    });
    if (again.status !== "recipe") return;
    expect(route(again.change.recipe).steps[0]).toMatchObject({
      fields: [
        { slot: "email", target: { by: "id", value: "email" } },
        { slot: "店番", target: { by: "id", value: "branch" } },
      ],
    });
    // Nothing of the bindings reaches the model, and no vault field name the recipe.
    expect(lastPrompt()).not.toContain("店番");
    expect(lastPrompt()).not.toContain("item-1");
    expect(JSON.stringify(again.change)).not.toContain("Synthetic");
    // The accepted plan's logged result has the carried name (ADR 0012).
    const [, logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate' ORDER BY created_at",
      device.ownerId,
    );
    expect(String(logged?.result)).toContain("店番");
  });

  it("carries a name on a continuation page", async () => {
    const device = await owner();
    state.replies.push({ text: named(fields(["email", "email"]), "next", "advance") });
    const first = await generateCustom(device, branchPage());
    if (first.status !== "recipe") throw new Error(first.status);
    await saveBindings(
      device,
      binding(first.change.recipeId, "item-1", { slot: "暗証", field: pinField }),
    );
    state.replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
    expect(
      await generateCustom(device, pinPage(), { recipeId: first.change.recipeId, revision: 1 }),
    ).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["email", "暗証"] } },
      customSlots: [{ slot: "暗証", offered: "custom-2" }],
    });
  });

  it("carries a name on a chooser branch's page", async () => {
    const device = await owner();
    const listPage: LoginObservation = {
      ...observation("/login", [element("other", "button", "Use another account")]),
      accounts: ["[email]"],
    };
    state.replies.push({
      text: JSON.stringify({ result: { decision: "account-list", other: "other" } }),
    });
    const list = await generateCustom(device, listPage);
    if (list.status !== "recipe") throw new Error(list.status);
    await saveBindings(
      device,
      binding(list.change.recipeId, "item-1", { slot: "店番", field: branchField }),
    );
    state.replies.push({
      text: named(fields(["email", "email"], ["custom-1", "branch"]), "next", "advance"),
    });
    expect(
      await generateCustom(
        device,
        branchPage(),
        { recipeId: list.change.recipeId, revision: 1 },
        "other",
      ),
    ).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { chooser: { afterOther: { slots: ["email", "店番"] } } } },
      customSlots: [{ slot: "店番", offered: "custom-1" }],
    });
  });

  /** A first page generated after `bindings` of its recipe were saved, without a recipe. */
  async function firstPageAfter(
    page: LoginObservation,
    filled: [string, string][],
    ...entries: Entry[][]
  ) {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, page.path);
    await saveBindings(
      device,
      ...entries.map((entry, index) => binding(recipeId, `item-${index + 1}`, ...entry)),
    );
    state.replies.push({ text: named(fields(...filled), "next", "advance") });
    return generateCustom(device, page);
  }

  it("carries nothing for a field two accounts' bindings name differently", async () => {
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "店番", field: branchField }],
        [{ slot: "支店", field: branchField }],
      ),
    ).toMatchObject({ status: "recipe", change: { recipe: { slots: ["Branch code"] } } });
  });

  it("keeps the page's name over a carried name that is not a custom slot ID or is taken", async () => {
    // A request slot ID, in another case.
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "CUSTOM-2", field: branchField }],
      ),
    ).toMatchObject({ change: { recipe: { slots: ["Branch code"] } } });
    // A built-in slot.
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "Password", field: branchField }],
      ),
    ).toMatchObject({ change: { recipe: { slots: ["Branch code"] } } });
  });

  it("takes a carried name before the page's text names another field the same", async () => {
    const page = observation("/login", [
      element("branch", "text", "店番"),
      { ...element("pin", "tel", "暗証番号"), maxLength: 4 },
      element("next", "button", "Next"),
    ]);
    expect(
      await firstPageAfter(
        page,
        [
          ["custom-1", "branch"],
          ["custom-2", "pin"],
        ],
        [{ slot: "店番", field: pinField }],
      ),
    ).toMatchObject({
      status: "recipe",
      change: { recipe: { slots: ["店番 2", "店番"] } },
      customSlots: [
        { slot: "店番 2", offered: "custom-1" },
        { slot: "店番", offered: "custom-2" },
      ],
    });
  });

  it("carries a name two accounts' bindings agree on", async () => {
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "店番", field: branchField }],
        [{ slot: "店番", field: branchField }],
      ),
    ).toMatchObject({ status: "recipe", change: { recipe: { slots: ["店番"] } } });
  });

  it("reads no other owner's bindings of the same origin and recipe", async () => {
    const other = await owner();
    await saveBindings(
      other,
      binding(await generatedRecipeId(ORIGIN, "/login"), "item-1", {
        slot: "店番",
        field: branchField,
      }),
    );
    expect(await firstPageAfter(branchPage(), [["custom-1", "branch"]])).toMatchObject({
      status: "recipe",
      change: { recipe: { slots: ["Branch code"] } },
    });
  });

  it("fails without a model call when the stored settings fail their schema", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO settings (owner_id, revision, document, updated_at) VALUES (?, 1, ?, ?)",
    )
      .bind(device.ownerId, JSON.stringify({ bindings: "synthetic" }), Date.now())
      .run();
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: branchPage(),
      slots: customSlots,
      signedIn: false,
    });
    expect(response.status).toBe(500);
    expect(state.sent).toHaveLength(0);
    // A list of accounts and a page without a custom-field offer never read the settings.
    state.replies.push({
      text: JSON.stringify({ result: { decision: "account-list", other: "other" } }),
    });
    expect(
      await generateCustom(device, {
        ...observation("/accounts", [element("other", "button", "Use another account")]),
        accounts: ["[email]"],
      }),
    ).toMatchObject({ status: "recipe" });
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(state.sent).toHaveLength(2);
  });

  it("reserves a later page's carried name on the first page, so the later page keeps it", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    await saveBindings(device, binding(recipeId, "item-1", { slot: "店番", field: pinField }));
    // The first page's unbound field reads as the PIN's carried name.
    state.replies.push({ text: named(fields(["custom-1", "branch"]), "next", "advance") });
    const first = await generateCustom(device, branchPage("店番"));
    expect(first).toMatchObject({
      change: { recipe: { slots: ["店番 2"] } },
      customSlots: [{ slot: "店番 2", offered: "custom-1" }],
    });
    if (first.status !== "recipe") throw new Error(first.status);
    state.replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
    expect(await generateCustom(device, pinPage(), { recipeId, revision: 1 })).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["店番 2", "店番"] } },
      customSlots: [{ slot: "店番", offered: "custom-2" }],
    });
  });

  it("ignores bindings of built-in fields", async () => {
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [
          { slot: "店番", field: "password" },
          { slot: "暗証", field: "totp" },
        ],
      ),
    ).toMatchObject({ change: { recipe: { slots: ["Branch code"] } } });
  });

  describe("a continuation's clash with the recipe it continues", () => {
    /** The first page, named `Branch` from the page, with `bindings` saved after it. */
    async function continued(...entries: Entry[]) {
      const device = await owner();
      state.replies.push({ text: named(fields(["custom-1", "branch"]), "next", "advance") });
      const first = await generateCustom(device, branchPage("Branch"));
      if (first.status !== "recipe") throw new Error(first.status);
      await saveBindings(
        device,
        binding(
          first.change.recipeId,
          "item-1",
          { slot: "Branch", field: branchField },
          ...entries,
        ),
      );
      return { device, base: { recipeId: first.change.recipeId, revision: 1 } };
    }
    const refused = { version: 1, status: "failed", error: "recipe-invalid" };

    it("refuses a carried name the recipe already has", async () => {
      const { device, base } = await continued({ slot: "branch", field: pinField });
      state.replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
      expect(await generateCustom(device, pinPage(), base)).toEqual(refused);
    });

    it("refuses a page whose own text the recipe already has, whatever it carries", async () => {
      const { device, base } = await continued({ slot: "暗証", field: pinField });
      state.replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
      expect(await generateCustom(device, pinPage("BRANCH"), base)).toEqual(refused);
    });

    it("refuses the recipe's field asked again under its carried name", async () => {
      const { device, base } = await continued();
      state.replies.push({ text: named(fields(["custom-1", "branch"]), "next", "advance") });
      expect(
        await generateCustom(
          device,
          observation("/again", [
            element("branch", "text", "Branch again"),
            element("next", "button", "Next"),
          ]),
          base,
        ),
      ).toEqual(refused);
    });
  });
}
