import { manageRecipesSchema, type LoginRecipeDocument, type PageKind } from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { expect, it } from "vitest";
import { deviceApi, ORIGIN, owner, ownerIdFor, request, type Owner } from "../access-helpers";
import { writeRecipe } from "../../src/recipe-store";
import type { OwnerTestHelpers } from "../owner.test";

export function registerOwnerRecipeCases({ manageApi, pairDevice }: OwnerTestHelpers) {
  /** A recipe with a layout (ADR 0060) for each key, created when `created` says. */
  function recipe(
    id: string,
    revision: number,
    origin = "https://bank.example",
    layouts: { key: string; createdAt: number; pageKind?: PageKind }[] = [
      { key: "1000", createdAt: 1000 },
    ],
  ): LoginRecipeDocument {
    return {
      version: 1,
      id,
      revision,
      origin,
      layouts: layouts.map(({ key, createdAt, pageKind = "sign-in" }) => ({
        key,
        createdAt,
        pageKind,
        slots: ["username", "password"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/login",
            fields: [
              { slot: "username", target: { by: "id", value: "username" } },
              { slot: "password", target: { by: "id", value: `password-${key}` } },
            ],
          },
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "submit" },
            purpose: "submit",
          },
        ],
        completion: [{ target: { by: "id", value: "welcome" } }],
        maxSubmissions: 1,
      })),
    };
  }
  const publish = (credential: string, id: string, expectedRevision: number) =>
    deviceApi(credential, `/v1/recipes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        expectedRevision,
        state: "active",
        recipe: recipe(id, expectedRevision + 1),
      }),
    });
  const revoke = (
    by: Owner,
    id: string,
    expectedRevision: number,
    origin: string | null = ORIGIN,
  ) =>
    request(`/manage/api/recipes/${id}/revoke`, {
      method: "POST",
      access: by.token,
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ version: 1, expectedRevision }),
    });
  const revokeLayout = (by: Owner, id: string, layout: string, expectedRevision: number) =>
    request(`/manage/api/recipes/${id}/layouts/${layout}/revoke`, {
      method: "POST",
      access: by.token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ version: 1, expectedRevision }),
    });
  const list = async (by: Owner) =>
    v.parse(
      manageRecipesSchema,
      await (await request("/manage/api/recipes", { access: by.token })).json(),
    );
  /** Which units of the owner's recipes the service has a record of (ADR 0060). */
  const unitSources = async (ownerId: string) =>
    (
      await env.DB.prepare(
        "SELECT recipe_id, layout, unit FROM recipe_unit_sources WHERE owner_id = ? ORDER BY recipe_id, layout, unit",
      )
        .bind(ownerId)
        .all()
    ).results;

  it("lists only the owner's recipes, most recently changed first, with their documents", async () => {
    const first = await owner();
    const second = await owner();
    const [device, other] = await Promise.all([pairDevice(first), pairDevice(second)]);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "shop-signin", 0)).status).toBe(200);
    expect((await publish(other.credential, "other-signin", 0)).status).toBe(200);
    // Writes in the same millisecond are common; the order comes from the write sequence.
    const sameTime = () => env.DB.prepare("UPDATE recipe_heads SET updated_at = 0").run();
    await sameTime();
    const { recipes } = await list(first);
    expect(recipes.map((entry) => entry.change.recipeId)).toEqual(["shop-signin", "bank-signin"]);
    // A revocation is the latest change, so that recipe moves to the top.
    expect((await revoke(first, "bank-signin", 1)).status).toBe(200);
    await sameTime();
    expect((await list(first)).recipes.map((entry) => entry.change.recipeId)).toEqual([
      "bank-signin",
      "shop-signin",
    ]);
    expect(recipes.find((entry) => entry.change.recipeId === "bank-signin")!.change).toEqual({
      recipeId: "bank-signin",
      revision: 1,
      state: "active",
      recipe: recipe("bank-signin", 1),
    });
  });

  it("shows an identity without a paired device no recipes and creates no owner", async () => {
    const by = await owner();
    expect(await list(by)).toEqual({ version: 1, recipes: [], unreadable: [] });
    expect((await revoke(by, "bank-signin", 1)).status).toBe(404);
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("revokes a recipe as a tombstone devices receive, recorded as written by the web UI", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    const response = await revoke(by, "bank-signin", 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      change: { recipeId: "bank-signin", revision: 2, state: "revoked" },
    });
    const feed = await (await deviceApi(device.credential, "/v1/recipes")).json();
    expect(feed).toMatchObject({
      changes: [{ recipeId: "bank-signin", revision: 2, state: "revoked" }],
    });
    const rows = await env.DB.prepare(
      "SELECT revision, state, created_by_device_id FROM recipe_revisions WHERE owner_id = ? ORDER BY revision",
    )
      .bind(await ownerIdFor(by.subject))
      .all();
    // A revoked recipe keeps only its tombstone, and no record of its units (ADR 0060).
    expect(rows.results).toEqual([{ revision: 2, state: "revoked", created_by_device_id: null }]);
    expect(await unitSources((await ownerIdFor(by.subject))!)).toEqual([]);
    // A device may still publish an explicit replacement after the tombstone.
    expect((await publish(device.credential, "bank-signin", 2)).status).toBe(200);
  });

  it("lists a recipe whose stored document no longer validates apart, and revokes it", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "shop-signin", 0)).status).toBe(200);
    const ownerId = await ownerIdFor(by.subject);
    // Stands in for a stored document that a later, stricter contract refuses.
    await env.DB.prepare(
      "UPDATE recipe_revisions SET document = ? WHERE owner_id = ? AND recipe_id = 'bank-signin'",
    )
      .bind(JSON.stringify({ synthetic: "unreadable" }), ownerId)
      .run();
    await env.DB.prepare("UPDATE recipe_heads SET updated_at = 5 WHERE owner_id = ?")
      .bind(ownerId)
      .run();
    const listed = await list(by);
    expect(listed.recipes.map((entry) => entry.change.recipeId)).toEqual(["shop-signin"]);
    expect(listed.unreadable).toEqual([{ recipeId: "bank-signin", revision: 1, updatedAt: 5 }]);
    const response = await revoke(by, "bank-signin", 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      change: { recipeId: "bank-signin", revision: 2, state: "revoked" },
    });
    const after = await list(by);
    expect(after.unreadable).toEqual([]);
    expect(after.recipes.map((entry) => entry.change)).toContainEqual({
      recipeId: "bank-signin",
      revision: 2,
      state: "revoked",
    });
  });

  it("refuses a stale or repeated revocation and returns the current head", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "bank-signin", 1)).status).toBe(200);
    const stale = await revoke(by, "bank-signin", 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "recipe_conflict",
      current: {
        recipeId: "bank-signin",
        revision: 2,
        state: "active",
        recipe: recipe("bank-signin", 2),
      },
    });
    expect((await revoke(by, "bank-signin", 2)).status).toBe(200);
    const again = await revoke(by, "bank-signin", 3);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "recipe_conflict",
      current: { recipeId: "bank-signin", revision: 3, state: "revoked" },
    });
  });

  it("never revokes another owner's recipe, an unknown one or from another origin", async () => {
    const first = await owner();
    const second = await owner();
    const [device] = await Promise.all([pairDevice(first), pairDevice(second)]);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    const responses = await Promise.all([
      revoke(second, "bank-signin", 1),
      revoke(first, "missing-signin", 1),
      revoke(first, "not a recipe id", 1),
      revoke(first, "bank-signin", 1, "https://attacker.example"),
      revoke(first, "bank-signin", 1, null),
      revoke(first, "bank-signin", 0),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 403, 403, 400]);
    expect((await list(first)).recipes[0]!.change.state).toBe("active");
  });

  it("revokes recipes unused for 90 days before listing them (ADR 0058)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "shop-signin", 0)).status).toBe(200);
    const ownerId = await ownerIdFor(by.subject);
    await env.DB.prepare(
      "UPDATE recipe_heads SET last_used_at = ? WHERE owner_id = ? AND recipe_id = 'bank-signin'",
    )
      .bind(Date.now() - 91 * 24 * 60 * 60 * 1000, ownerId)
      .run();
    const { recipes } = await list(by);
    // The list no longer offers it as active; it shows as the service's tombstone.
    expect(recipes.map((entry) => entry.change)).toEqual([
      { recipeId: "bank-signin", revision: 2, state: "revoked" },
      { recipeId: "shop-signin", revision: 1, state: "active", recipe: recipe("shop-signin", 1) },
    ]);
    const rows = await env.DB.prepare(
      "SELECT revision, state, created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND recipe_id = 'bank-signin'",
    )
      .bind(ownerId)
      .all();
    expect(rows.results).toEqual([{ revision: 2, state: "revoked", created_by_device_id: null }]);
    // Only the recipe still active keeps the record of its units (ADR 0060).
    expect((await unitSources(ownerId!)).map((row) => row["recipe_id"])).toEqual([
      "shop-signin",
      "shop-signin",
    ]);
    expect(await (await deviceApi(device.credential, "/v1/recipes?after=2")).json()).toMatchObject({
      changes: [{ recipeId: "bank-signin", revision: 2, state: "revoked" }],
    });
  });

  it("lists each layout's last use and removes one layout at a time (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const created = Date.now();
    const two = recipe("bank-signin", 1, "https://bank.example", [
      { key: "1000", createdAt: created },
      { key: "2000", createdAt: created },
    ]);
    const written = await deviceApi(device.credential, "/v1/recipes/bank-signin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 0, state: "active", recipe: two }),
    });
    expect(written.status).toBe(200);
    const before = Date.now();
    const used = await deviceApi(device.credential, "/v1/recipes/bank-signin/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, revision: 1, layout: "2000" }),
    });
    expect(used.status).toBe(204);
    // A layout the recipe does not have is no use of one.
    await deviceApi(device.credential, "/v1/recipes/bank-signin/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, revision: 1, layout: "3000" }),
    });
    const [listed] = (await list(by)).recipes;
    // A device wrote both layouts, so no model made their first pages (ADR 0060).
    const byDevice = { origin: "device", model: null, createdAt: expect.any(Number) };
    expect(listed!.layouts).toEqual([
      { key: "1000", lastUsedAt: null, firstPage: byDevice },
      { key: "2000", lastUsedAt: expect.any(Number), firstPage: byDevice },
    ]);
    expect(listed!.layouts[1]!.lastUsedAt).toBeGreaterThanOrEqual(before);
    const ownerId = await ownerIdFor(by.subject);
    const lastUsed = async () =>
      (
        await env.DB.prepare(
          "SELECT last_used_at FROM recipe_heads WHERE owner_id = ? AND recipe_id = 'bank-signin'",
        )
          .bind(ownerId)
          .first<{ last_used_at: number }>()
      )?.last_used_at;
    const usedAt = await lastUsed();
    // An unknown or malformed layout, or a stale revision, changes nothing.
    const refused = await Promise.all([
      revokeLayout(by, "bank-signin", "3000", 1),
      revokeLayout(by, "bank-signin", "latest", 1),
      revokeLayout(by, "missing-signin", "1000", 1),
    ]);
    expect(refused.map((response) => response.status)).toEqual([404, 404, 404]);
    const stale = await revokeLayout(by, "bank-signin", "1000", 2);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "recipe_conflict",
      current: { revision: 1 },
    });
    // The next revision keeps the other layout, and removing one is no use of the recipe.
    const removed = await revokeLayout(by, "bank-signin", "1000", 1);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      version: 1,
      change: {
        recipeId: "bank-signin",
        revision: 2,
        state: "active",
        recipe: { ...two, revision: 2, layouts: [two.layouts[1]] },
      },
    });
    expect(await lastUsed()).toBe(usedAt);
    expect((await list(by)).recipes[0]!.layouts).toEqual([
      { key: "2000", lastUsedAt: expect.any(Number), firstPage: byDevice },
    ]);
    // The removed layout's units go with it (ADR 0060).
    expect(await unitSources(ownerId!)).toEqual([
      { recipe_id: "bank-signin", layout: "2000", unit: "marker:0" },
      { recipe_id: "bank-signin", layout: "2000", unit: "page:0" },
    ]);
    // Removing the last layout revokes the recipe, and its layouts' uses go with it.
    const last = await revokeLayout(by, "bank-signin", "2000", 2);
    expect(await last.json()).toEqual({
      version: 1,
      change: { recipeId: "bank-signin", revision: 3, state: "revoked" },
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM recipe_layout_uses WHERE owner_id = ?")
        .bind(ownerId)
        .first("n"),
    ).toBe(0);
    expect(await unitSources(ownerId!)).toEqual([]);
  });

  it("removes a layout unused for 90 days while another is used (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const now = Date.now();
    const old = now - 91 * 24 * 60 * 60 * 1000;
    const layouts = [
      { key: "1000", createdAt: old },
      { key: "2000", createdAt: old },
      { key: "3000", createdAt: now },
    ];
    const stored = recipe("bank-signin", 1, "https://bank.example", layouts);
    const written = await deviceApi(device.credential, "/v1/recipes/bank-signin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 0, state: "active", recipe: stored }),
    });
    expect(written.status).toBe(200);
    // The second old layout ran a login this week.
    const record = await deviceApi(device.credential, "/v1/recipes/bank-signin/logins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        revision: 1,
        branch: "2000",
        outcome: "authenticated",
        extensionBuild: "development",
        totalMs: 4000,
        serviceMs: 0,
        networkMs: 0,
        personMs: 0,
        pageMs: 0,
      }),
    });
    expect(record.status).toBe(204);
    const { recipes } = await list(by);
    expect(recipes.map((entry) => entry.change)).toEqual([
      {
        recipeId: "bank-signin",
        revision: 2,
        state: "active",
        recipe: { ...stored, revision: 2, layouts: stored.layouts.slice(1) },
      },
    ]);
    const rows = await env.DB.prepare(
      "SELECT revision, created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND revision = 2",
    )
      .bind(await ownerIdFor(by.subject))
      .all();
    expect(rows.results).toEqual([{ revision: 2, created_by_device_id: null }]);
    // The removed layout's units go with it (ADR 0060).
    expect([
      ...new Set((await unitSources((await ownerIdFor(by.subject))!)).map((row) => row["layout"])),
    ]).toEqual(["2000", "3000"]);
  });

  it("keeps the idle layouts of a recipe generated as a verification, which never runs (ADR 0035, ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const now = Date.now();
    const old = now - 91 * 24 * 60 * 60 * 1000;
    const put = (layouts: { key: string; createdAt: number; pageKind?: PageKind }[]) =>
      deviceApi(device.credential, "/v1/recipes/bank-signin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          expectedRevision: 0,
          state: "active",
          recipe: recipe("bank-signin", 1, "https://bank.example", layouts),
        }),
      });
    // Every layout of a recipe has its start page's kind, so a document mixing them is
    // refused.
    expect(
      (
        await put([
          { key: "1000", createdAt: old, pageKind: "confirm" },
          { key: "2000", createdAt: now },
        ])
      ).status,
    ).toBe(400);
    const layouts = [
      { key: "1000", createdAt: old, pageKind: "confirm" as const },
      { key: "2000", createdAt: now, pageKind: "confirm" as const },
    ];
    expect((await put(layouts)).status).toBe(200);
    // No layout goes, and the recipe itself is never revoked as idle.
    const { recipes } = await list(by);
    expect(recipes.map((entry) => entry.change)).toEqual([
      {
        recipeId: "bank-signin",
        revision: 1,
        state: "active",
        recipe: recipe("bank-signin", 1, "https://bank.example", layouts),
      },
    ]);
  });

  it("keeps an idle layout whose use arrives while it is removed (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const now = Date.now();
    const unusedBefore = now - 90 * 24 * 60 * 60 * 1000;
    const layouts = [
      { key: "1000", createdAt: unusedBefore - 1000 },
      { key: "2000", createdAt: now },
    ];
    const stored = recipe("bank-signin", 1, "https://bank.example", layouts);
    const written = await deviceApi(device.credential, "/v1/recipes/bank-signin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 0, state: "active", recipe: stored }),
    });
    expect(written.status).toBe(200);
    const ownerId = (await ownerIdFor(by.subject))!;
    // The idle check read no use of layout 1000; a login reports one before it writes.
    await env.DB.prepare(
      "INSERT INTO recipe_layout_uses (owner_id, recipe_id, layout, last_used_at) VALUES (?, 'bank-signin', '1000', ?)",
    )
      .bind(ownerId, now)
      .run();
    const removal = (keys: string[]) =>
      writeRecipe(
        env.DB,
        ownerId,
        "bank-signin",
        {
          version: 1,
          expectedRevision: 1,
          state: "active",
          recipe: { ...stored, revision: 2, layouts: stored.layouts.slice(1) },
        },
        null,
        { used: false, idleLayouts: { keys, before: unusedBefore } },
      );
    expect(await removal(["1000"])).toMatchObject({ ok: false, limited: false });
    const uses = () =>
      env.DB.prepare("SELECT layout FROM recipe_layout_uses WHERE owner_id = ?")
        .bind(ownerId)
        .all()
        .then(({ results }) => results);
    expect(await uses()).toEqual([{ layout: "1000" }]);
    // The refused removal keeps the layout's units, which the same batch would drop.
    const layoutsWithUnits = async () => [
      ...new Set((await unitSources(ownerId)).map((row) => row["layout"])),
    ];
    expect(await layoutsWithUnits()).toEqual(["1000", "2000"]);
    // Once that use is old again, the removal wins and the use row goes with the layout.
    await env.DB.prepare("UPDATE recipe_layout_uses SET last_used_at = ? WHERE owner_id = ?")
      .bind(unusedBefore - 1, ownerId)
      .run();
    expect(await removal(["1000"])).toMatchObject({ ok: true, change: { revision: 2 } });
    expect(await uses()).toEqual([]);
    expect(await layoutsWithUnits()).toEqual(["2000"]);
  });

  it("lists the model and time of each layout's first page that the service generated (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    // Stands in for the row a generated first page leaves.
    await env.DB.prepare(
      "UPDATE recipe_unit_sources SET origin = 'generated', provider = 'anthropic', model = 'claude-synthetic', created_at = 1234 WHERE owner_id = ? AND unit = 'page:0'",
    )
      .bind(await ownerIdFor(by.subject))
      .run();
    expect((await list(by)).recipes[0]!.layouts).toEqual([
      {
        key: "1000",
        lastUsedAt: null,
        firstPage: { origin: "generated", model: "claude-synthetic", createdAt: 1234 },
      },
    ]);
  });

  it("refuses other methods on the recipes API", async () => {
    const { token } = await owner();
    expect((await manageApi("/manage/api/recipes", token, "PUT")).status).toBe(405);
  });
}
