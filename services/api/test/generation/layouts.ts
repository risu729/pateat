import {
  type RecipeCompletionResult,
  type RecipeGenerationResult,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { expect, it } from "vitest";
import { documentUnits, buildLoginLayout, generatedRecipeId } from "@pateat/generation";
import type { GenerationContext, Device } from "./context";

export function registerLayouts(context: GenerationContext) {
  const {
    ORIGIN,
    slots,
    emailPage,
    passwordPage,
    homePage,
    route,
    plan,
    owner,
    layoutKey,
    post,
    storedHead,
    generate,
    rows,
    state,
  } = context;

  const judgeReply = (result: unknown) => ({ text: JSON.stringify({ result }) });
  const layoutUses = (ownerId: string) =>
    rows(
      "SELECT recipe_id, layout FROM recipe_layout_uses WHERE owner_id = ? ORDER BY layout",
      ownerId,
    );
  /** A stored email page that advances, as layout `key`, beside another finished layout. */
  async function twoLayouts(device: Device) {
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const email = {
      key: "1000",
      language: "ja" as const,
      createdAt: 1000,
      pageKind: "sign-in" as const,
      slots: ["email"],
      steps: [
        {
          kind: "fill" as const,
          path: "/login",
          effect: "prepare" as const,
          fields: [{ slot: "email", target: { by: "id" as const, value: "email" } }],
        },
        {
          kind: "click" as const,
          path: "/login",
          target: { by: "id" as const, value: "next" },
          purpose: "advance" as const,
        },
      ],
      maxSubmissions: 1,
    };
    const together = {
      key: "2000",
      createdAt: 2000,
      pageKind: "sign-in" as const,
      slots: ["email", "password"],
      steps: [
        {
          kind: "fill" as const,
          path: "/login",
          effect: "prepare" as const,
          fields: [
            { slot: "email", target: { by: "id" as const, value: "user" } },
            { slot: "password", target: { by: "id" as const, value: "pass" } },
          ],
        },
        {
          kind: "click" as const,
          path: "/login",
          target: { by: "id" as const, value: "go" },
          purpose: "submit" as const,
        },
      ],
      maxSubmissions: 1,
    };
    const document = {
      version: 1 as const,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      layouts: [email, together],
    };
    const written = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 0, state: "active", recipe: document },
      "PUT",
    );
    expect(written.status).toBe(200);
    return { recipeId, document, email, together };
  }
  /** A later page of the recipe, sent as the login of `branch` sends it. */
  const continueAs = async (device: Device, recipeId: string, branch: string) =>
    (await (
      await post(device, "/v1/recipes/generate", {
        version: 1,
        observation: passwordPage,
        slots,
        base: { recipeId, revision: 1 },
        branch,
      })
    ).json()) as RecipeGenerationResult;

  it("stores a first page as the recipe's one layout, keyed by its creation and language", async () => {
    const device = await owner();
    const before = Date.now();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    const key = (await layoutKey(device.ownerId, first.change.recipeId))!;
    expect(Number(key)).toBeGreaterThanOrEqual(before);
    expect(Number(key)).toBeLessThanOrEqual(Date.now());
    expect(await storedHead(device.ownerId, first.change.recipeId)).toEqual({
      version: 1,
      id: first.change.recipeId,
      revision: 1,
      origin: ORIGIN,
      layouts: [
        {
          key,
          language: "en",
          createdAt: Number(key),
          pageKind: "sign-in",
          slots: ["email"],
          steps: route(first.change.recipe).steps,
          maxSubmissions: 1,
        },
      ],
    });
    // The answer is the stored document; a device projects the layout it runs.
    expect(first.change.recipe).toMatchObject({ layout: key });
    // The request log names the layout the first page's answer created.
    expect(
      await rows(
        "SELECT layout, branch, recipe_page, revision FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ layout: key, branch: "", recipe_page: "first", revision: 1 }]);
    // The revision records the device whose request generated it.
    expect(
      await rows(
        "SELECT revision, created_by_device_id FROM recipe_revisions WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ revision: 1, created_by_device_id: device.deviceId }]);
    // A page in both languages gives its layout none.
    const mixed = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const both = await generate(mixed, { ...emailPage, language: "mixed" });
    if (both.status !== "recipe") throw new Error(both.status);
    expect(await storedHead(mixed.ownerId, both.change.recipeId)).toMatchObject({
      layouts: [{ key: expect.any(String), createdAt: expect.any(Number) }],
    });
    expect(
      (
        (await storedHead(mixed.ownerId, both.change.recipeId)) as {
          layouts: Record<string, unknown>[];
        }
      ).layouts[0],
    ).not.toHaveProperty("language");
  });

  it("continues the layout the login ran, keeps the others and marks it used", async () => {
    const device = await owner();
    const { recipeId, document, email, together } = await twoLayouts(device);
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const continued = await continueAs(device, recipeId, "1000");
    expect(continued).toMatchObject({ status: "recipe", change: { revision: 2 } });
    expect(await storedHead(device.ownerId, recipeId)).toEqual({
      ...document,
      revision: 2,
      layouts: [
        {
          ...email,
          slots: ["email", "password"],
          steps: [
            ...email.steps,
            {
              kind: "fill",
              path: "/password",
              effect: "prepare",
              fields: [{ slot: "password", target: { by: "id", value: "password" } }],
            },
            {
              kind: "click",
              path: "/password",
              target: { by: "id", value: "sign-in" },
              purpose: "submit",
            },
          ],
          maxSubmissions: 2,
        },
        together,
      ],
    });
    expect(await layoutUses(device.ownerId)).toEqual([{ recipe_id: recipeId, layout: "1000" }]);
    expect(
      await rows(
        "SELECT branch, base_revision FROM generation_attempts WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ branch: "1000", base_revision: 1 }]);
    // The request log names the layout the continuation was for.
    expect(
      await rows("SELECT layout, branch FROM inference_log WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ layout: "1000", branch: "1000" }]);
  });

  it("keeps a continuation written during the call onto another layout's newer revision", async () => {
    const device = await owner();
    const { recipeId, document, together } = await twoLayouts(device);
    const completion = [{ target: { by: "id" as const, value: "logout" } }];
    // While the page of layout 1000 is generated, a judgement of layout 2000 on another
    // device stores revision 2.
    state.during = async () => {
      const put = await post(
        device,
        `/v1/recipes/${recipeId}`,
        {
          version: 1,
          expectedRevision: 1,
          state: "active",
          recipe: {
            ...document,
            revision: 2,
            layouts: [document.layouts[0], { ...together, completion }],
          },
        },
        "PUT",
      );
      expect(put.status).toBe(200);
    };
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(await continueAs(device, recipeId, "1000")).toMatchObject({
      status: "recipe",
      change: { revision: 3 },
    });
    // The paid answer lands on the newer revision, which keeps the other layout's marker.
    expect(await storedHead(device.ownerId, recipeId)).toMatchObject({
      revision: 3,
      layouts: [
        { key: "1000", slots: ["email", "password"] },
        { key: "2000", completion },
      ],
    });
    expect(state.sent).toHaveLength(1);
    // The rebased write records its page at the step it starts on, with the digest of that
    // page in the revision it stored (ADR 0060).
    const recorded = (await rows(
      "SELECT layout, unit, digest FROM recipe_unit_sources WHERE owner_id = ? AND recipe_id = ? AND origin = 'generated' AND revision = 3",
      device.ownerId,
      recipeId,
    )) as { layout: string | null; unit: string; digest: string }[];
    expect(recorded.map(({ layout, unit }) => ({ layout, unit }))).toEqual([
      { layout: "1000", unit: "page:2" },
    ]);
    const units = await documentUnits(
      (await storedHead(device.ownerId, recipeId)) as StoredLoginRecipe,
      recorded,
    );
    expect(units).toContainEqual(recorded[0]);
    // A write of the continued layout itself meanwhile still wins over the page.
    const other = await owner();
    const second = await twoLayouts(other);
    state.during = async () => {
      const put = await post(
        other,
        `/v1/recipes/${second.recipeId}`,
        {
          version: 1,
          expectedRevision: 1,
          state: "active",
          recipe: {
            ...second.document,
            revision: 2,
            layouts: [{ ...second.email, completion }, second.together],
          },
        },
        "PUT",
      );
      expect(put.status).toBe(200);
    };
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(await continueAs(other, second.recipeId, "1000")).toMatchObject({
      status: "recipe",
      change: { revision: 2 },
    });
    expect(await storedHead(other.ownerId, second.recipeId)).toMatchObject({
      revision: 2,
      layouts: [{ key: "1000", slots: ["email"], completion }, { key: "2000" }],
    });
  });

  it("refuses to continue a layout the recipe does not have, or one that submitted", async () => {
    const device = await owner();
    const { recipeId } = await twoLayouts(device);
    const conflict = { version: 1, status: "unavailable", reason: "recipe-conflict" };
    // Removed meanwhile, as from the management page, or never there.
    expect(await continueAs(device, recipeId, "3000")).toEqual(conflict);
    // The other layout submitted on its first page.
    expect(await continueAs(device, recipeId, "2000")).toEqual(conflict);
    // A chooser branch of a login recipe.
    expect(await continueAs(device, recipeId, "1000:account")).toEqual(conflict);
    expect(state.sent).toEqual([]);
  });

  it("judges each layout on its own and learns its marker into that layout only", async () => {
    const device = await owner();
    const { recipeId, document, email, together } = await twoLayouts(device);
    const judge = (branch: string) =>
      post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        revision: 1,
        route: "password",
        branch,
        observation: homePage,
        slots: [],
      }).then(async (response) => (await response.json()) as RecipeCompletionResult);
    state.replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect(await judge("2000")).toMatchObject({ status: "signed-in", change: { revision: 2 } });
    const marker = [{ target: { by: "id", value: "logout" } }];
    expect(await storedHead(device.ownerId, recipeId)).toEqual({
      ...document,
      revision: 2,
      layouts: [email, { ...together, completion: marker }],
    });
    expect(
      await rows("SELECT branch, revision FROM page_judgements WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ branch: "2000", revision: 1 }]);
    expect(await layoutUses(device.ownerId)).toEqual([{ recipe_id: recipeId, layout: "2000" }]);
    // The request log names the judged layout.
    expect(
      await rows(
        "SELECT role, layout, branch FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ role: "judge", layout: "2000", branch: "2000" }]);
    // The judged marker's revision records the device whose login sent the page, and a
    // later removal of an idle layout by the service records none (owner.test.ts).
    expect(
      await rows(
        "SELECT revision, created_by_device_id FROM recipe_revisions WHERE owner_id = ? ORDER BY revision",
        device.ownerId,
      ),
    ).toEqual([
      { revision: 1, created_by_device_id: device.deviceId },
      { revision: 2, created_by_device_id: device.deviceId },
    ]);
  });

  it("builds a layout from the model's answer without writing it", async () => {
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const device = await owner();
    // The same answer, stored by the route, is what the builder makes of it.
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    const stored = route(first.change.recipe);
    const built = buildLoginLayout(
      undefined,
      {
        id: stored.id,
        origin: ORIGIN,
        observation: emailPage,
        slots,
        value: {
          fields: [{ slot: "email", candidate: "email" }],
          action: { candidate: "next", purpose: "advance" },
          steps: stored.steps,
        },
        startPage: true,
        carriedNames: new Map(),
        pageKind: "sign-in",
      },
      { key: "5000", language: "en", createdAt: 5000 },
    );
    expect(built).toMatchObject({
      ok: true,
      layout: {
        key: "5000",
        language: "en",
        createdAt: 5000,
        pageKind: "sign-in",
        steps: stored.steps,
      },
      customSlots: [],
    });
    expect(
      await rows("SELECT revision FROM recipe_heads WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ revision: 1 }]);
  });
}
