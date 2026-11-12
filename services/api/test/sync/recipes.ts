import {
  MAX_ACTIVE_RECIPE_BYTES,
  type LoginRecipeDocument,
  type SyncRecipeChanges,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { KEPT_RECIPE_REVISIONS, MAX_ACTIVE_RECIPES } from "../../src/limits";
import { writeRecipe } from "../../src/recipe-store";
import { documentBytes, seedRecipeBytes, storedRecipeBytes } from "../recipe-byte-helpers";
import { OWNER_LIMIT, withLimiter } from "../limiter";

import {
  type Device,
  enrollOwner,
  addDevice,
  api,
  put,
  recipe,
  routeBody,
  publish,
  seedActiveRecipes,
  revisions,
} from "./harness";

export function registerRecipeSyncTests() {
  describe("recipe sync", () => {
    it("publishes revisions conditionally and keeps immutable history", async () => {
      const device = await enrollOwner();
      const created = await publish(device, "bank-login", 0);
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        version: 1,
        change: {
          recipeId: "bank-login",
          revision: 1,
          state: "active",
          recipe: recipe("bank-login", 1),
        },
      });
      expect((await publish(device, "bank-login", 1)).status).toBe(200);

      const stale = await publish(device, "bank-login", 1);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error: "recipe_conflict",
        current: {
          recipeId: "bank-login",
          revision: 2,
          state: "active",
          recipe: recipe("bank-login", 2),
        },
      });

      const history = await env.DB.prepare(
        "SELECT * FROM recipe_revisions WHERE owner_id = ? ORDER BY revision",
      )
        .bind(device.ownerId)
        .all();
      // Every column, since the history row is filled positionally by INSERT ... SELECT.
      expect(
        history.results.map((row) => ({ ...row, document: JSON.parse(row["document"] as string) })),
      ).toEqual(
        [1, 2].map((revision) => ({
          owner_id: device.ownerId,
          recipe_id: "bank-login",
          revision,
          state: "active",
          document: recipe("bank-login", revision),
          created_at: expect.any(Number),
          created_by_device_id: device.deviceId,
        })),
      );
      for (const row of history.results)
        expect(Math.abs((row["created_at"] as number) - Date.now())).toBeLessThan(60_000);
    });

    it("syncs tombstones and allows an explicit later republish", async () => {
      const device = await enrollOwner();
      await publish(device, "bank-login", 0);
      const revoked = await put(device, "/v1/recipes/bank-login", {
        version: 1,
        expectedRevision: 1,
        state: "revoked",
      });
      expect(await revoked.json()).toEqual({
        version: 1,
        change: { recipeId: "bank-login", revision: 2, state: "revoked" },
      });

      const changes = await (await api(device, "/v1/recipes")).json();
      expect(changes).toEqual({
        version: 1,
        changes: [{ recipeId: "bank-login", revision: 2, state: "revoked" }],
        cursor: 2,
        complete: true,
      });
      expect((await publish(device, "bank-login", 2)).status).toBe(200);
      const after = await (await api(device, "/v1/recipes?after=2")).json();
      expect(after).toMatchObject({
        changes: [{ recipeId: "bank-login", revision: 3, state: "active" }],
        cursor: 3,
      });
    });

    it("does not revoke a tombstone again", async () => {
      const device = await enrollOwner();
      await publish(device, "bank-login", 0);
      const revoke = { version: 1, expectedRevision: 1, state: "revoked" };
      expect((await put(device, "/v1/recipes/bank-login", revoke)).status).toBe(200);
      const again = await put(device, "/v1/recipes/bank-login", { ...revoke, expectedRevision: 2 });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({
        error: "recipe_conflict",
        current: { recipeId: "bank-login", revision: 2, state: "revoked" },
      });
    });

    it("sends a recipe whose stored document no longer validates as revoked", async () => {
      const device = await enrollOwner();
      await publish(device, "bank-login", 0);
      await publish(device, "shop-login", 0);
      // Stands in for a stored document that a later, stricter contract refuses.
      await env.DB.prepare(
        "UPDATE recipe_revisions SET document = ? WHERE owner_id = ? AND recipe_id = 'bank-login'",
      )
        .bind(JSON.stringify({ synthetic: "unreadable" }), device.ownerId)
        .run();
      const response = await api(device, "/v1/recipes");
      expect(response.status).toBe(200);
      const page: SyncRecipeChanges = await response.json();
      expect(page.changes[0]).toEqual({ recipeId: "bank-login", revision: 1, state: "revoked" });
      expect(page).toMatchObject({
        changes: [{}, { recipeId: "shop-login", revision: 1, state: "active" }],
        cursor: 2,
        complete: true,
      });
      // A device may replace it with a readable revision.
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      expect(await (await api(device, "/v1/recipes?after=2")).json()).toMatchObject({
        changes: [{ recipeId: "bank-login", revision: 2, state: "active" }],
      });
    });

    it("fails closed without details when a stored recipe head is corrupt", async () => {
      const device = await enrollOwner();
      await publish(device, "bank-login", 0);
      // A revision the contract refuses cannot be sent even as revoked.
      await env.DB.batch(
        ["recipe_heads", "recipe_revisions"].map((table) =>
          env.DB.prepare(`UPDATE ${table} SET revision = 0 WHERE owner_id = ?`).bind(
            device.ownerId,
          ),
        ),
      );
      const response = await api(device, "/v1/recipes");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
    });

    it("does not create a tombstone for a recipe that does not exist", async () => {
      const device = await enrollOwner();
      const response = await put(device, "/v1/recipes/missing", {
        version: 1,
        expectedRevision: 1,
        state: "revoked",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "recipe_conflict", current: null });
    });

    it("pages changes by cursor and returns only the latest state per recipe", async () => {
      const device = await enrollOwner();
      // Sequential on purpose: each publish takes the next owner sequence.
      await publish(device, "one", 0);
      await publish(device, "two", 0);
      await publish(device, "three", 0);
      await publish(device, "one", 1);

      const first: SyncRecipeChanges = await (await api(device, "/v1/recipes?limit=2")).json();
      expect(first).toMatchObject({
        changes: [{ recipeId: "two" }, { recipeId: "three" }],
        complete: false,
      });
      const second: SyncRecipeChanges = await (
        await api(device, `/v1/recipes?after=${first.cursor}&limit=2`)
      ).json();
      expect(second).toMatchObject({
        changes: [{ recipeId: "one", revision: 2 }],
        complete: true,
      });
      const empty = await (await api(device, `/v1/recipes?after=${second.cursor}`)).json();
      expect(empty).toEqual({ version: 1, changes: [], cursor: second.cursor, complete: true });
    });

    it("accepts exactly one of two concurrent creates", async () => {
      const device = await enrollOwner();
      const responses = await Promise.all([
        publish(device, "bank-login", 0),
        publish(device, "bank-login", 0),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const history = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM recipe_revisions WHERE owner_id = ?",
      )
        .bind(device.ownerId)
        .first();
      expect(history).toEqual({ count: 1 });
    });

    it("isolates owners that use the same recipe identifier", async () => {
      const alice = await enrollOwner();
      const bob = await enrollOwner();
      await publish(alice, "bank-login", 0);

      expect(await (await api(bob, "/v1/recipes")).json()).toEqual({
        version: 1,
        changes: [],
        cursor: 0,
        complete: true,
      });
      const crossUpdate = await publish(bob, "bank-login", 1);
      expect(crossUpdate.status).toBe(409);
      expect(await crossUpdate.json()).toEqual({ error: "recipe_conflict", current: null });
      expect((await publish(bob, "bank-login", 0)).status).toBe(200);
      expect(await (await api(alice, "/v1/recipes")).json()).toMatchObject({
        changes: [{ recipeId: "bank-login", revision: 1 }],
      });
    });

    it.each([
      ["a recipe whose revision skips ahead", { recipe: recipe("bank-login", 3) }],
      ["a recipe for another path identifier", { recipe: recipe("other-login", 1) }],
      ["a recipe with executable content", { recipe: { ...recipe("bank-login", 1), script: "x" } }],
    ])("rejects %s", async (_, override) => {
      const device = await enrollOwner();
      const response = await put(device, "/v1/recipes/bank-login", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        ...override,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    });

    it.each([
      "/v1/recipes?limit=0",
      "/v1/recipes?limit=101",
      "/v1/recipes?after=-1",
      "/v1/recipes?owner=x",
    ])("rejects the invalid query %s", async (path) => {
      const device = await enrollOwner();
      const response = await api(device, path);
      expect(response.status).toBe(400);
    });

    it("never echoes a rejected body, query or path value", async () => {
      const device = await enrollOwner();
      const sentinel = "synthetic-rejected-value";
      // A space fails the recipe ID pattern, so the path parameter itself is rejected.
      const rejectedId = encodeURIComponent(`${sentinel} id`);
      const rejected = [
        await put(device, "/v1/settings", { version: 1, expectedRevision: 0, password: sentinel }),
        await put(device, "/v1/recipes/bank-login", { version: 1, state: sentinel }),
        await api(device, `/v1/recipes?owner=${sentinel}`),
        await put(device, `/v1/recipes/${rejectedId}`, {
          version: 1,
          expectedRevision: 0,
          state: "active",
          recipe: recipe("bank-login", 1),
        }),
      ];
      expect(rejected.map((response) => response.status)).toEqual([400, 400, 400, 400]);
      const texts = await Promise.all(rejected.map((response) => response.text()));
      expect(texts).toEqual(
        Array.from({ length: 4 }, () => JSON.stringify({ error: "bad_request" })),
      );
    });

    it("syncs a recipe with password route variants and refuses an unchecked variant", async () => {
      const device = await enrollOwner();
      const contract = {
        slots: ["contract", "password"],
        steps: [
          {
            kind: "fill" as const,
            effect: "prepare" as const,
            path: "/login",
            fields: [
              { slot: "contract", target: { by: "id" as const, value: "contract" } },
              { slot: "password", target: { by: "id" as const, value: "password" } },
            ],
          },
          {
            kind: "click" as const,
            path: "/login",
            target: { by: "id" as const, value: "submit" },
            purpose: "submit" as const,
          },
        ],
      };
      const base = recipe("bank-variants", 1);
      const varied = { ...base, layouts: [{ ...base.layouts[0]!, alternatives: [contract] }] };
      const written = await put(device, "/v1/recipes/bank-variants", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: varied,
      });
      expect(written.status).toBe(200);
      const changes = await api(device, "/v1/recipes");
      expect(await changes.json()).toMatchObject({
        changes: [{ recipeId: "bank-variants", recipe: varied }],
      });
      // A variant on another start path is refused like any other invalid recipe.
      const other = recipe("bank-elsewhere", 1);
      const elsewhere = await put(device, "/v1/recipes/bank-elsewhere", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: {
          ...other,
          layouts: [
            {
              ...other.layouts[0]!,
              alternatives: [
                {
                  ...contract,
                  steps: contract.steps.map((step) => ({ ...step, path: "/contract" })),
                },
              ],
            },
          ],
        },
      });
      expect(elsewhere.status).toBe(400);
    });

    it("stores, syncs and revokes an entry recipe (ADR 0031), and refuses a mixed one", async () => {
      const device = await enrollOwner();
      const entry = {
        version: 1,
        id: "bank-entry",
        revision: 1,
        origin: "https://bank.example",
        entry: { path: "/", target: { by: "text", value: "Login" } },
      };
      const written = await put(device, "/v1/recipes/bank-entry", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: entry,
      });
      expect(written.status).toBe(200);
      expect(await (await api(device, "/v1/recipes")).json()).toMatchObject({
        changes: [{ recipeId: "bank-entry", revision: 1, state: "active", recipe: entry }],
      });
      const { layouts } = recipe("bank-mixed", 1);
      const mixed = await put(device, "/v1/recipes/bank-mixed", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: { ...entry, id: "bank-mixed", layouts },
      });
      expect(mixed.status).toBe(400);
      const revoked = await put(device, "/v1/recipes/bank-entry", {
        version: 1,
        expectedRevision: 1,
        state: "revoked",
      });
      expect(revoked.status).toBe(200);
      expect(await (await api(device, "/v1/recipes")).json()).toMatchObject({
        changes: [{ recipeId: "bank-entry", revision: 2, state: "revoked" }],
      });
    });

    it("stores and syncs a chooser recipe (ADR 0028) with a branch", async () => {
      const device = await enrollOwner();
      const layout = (key: string) => ({
        key,
        createdAt: Number(key),
        other: { by: "text", value: "Use another account" },
        afterAccount: routeBody(),
      });
      const chooser = {
        version: 1,
        id: "bank-chooser",
        revision: 1,
        origin: "https://bank.example",
        chooser: { path: "/login", layouts: [layout("1000")] },
      };
      const written = await put(device, "/v1/recipes/bank-chooser", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: chooser,
      });
      expect(written.status).toBe(200);
      expect(await (await api(device, "/v1/recipes")).json()).toMatchObject({
        changes: [{ recipeId: "bank-chooser", revision: 1, state: "active", recipe: chooser }],
      });
      const crowded = await put(device, "/v1/recipes/bank-crowded", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: {
          ...chooser,
          id: "bank-crowded",
          chooser: { path: "/login", layouts: ["1", "2", "3", "4"].map(layout) },
        },
      });
      // A recipe holds at most three layouts (ADR 0060).
      expect(crowded.status).toBe(400);
    });

    it("rejects an invalid recipe identifier and unsupported methods", async () => {
      const device = await enrollOwner();
      const invalid = await put(device, "/v1/recipes/bad%20id", {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: recipe("bank-login", 1),
      });
      expect(invalid.status).toBe(400);
      const collection = await api(device, "/v1/recipes", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "synthetic",
      });
      expect(collection.status).toBe(405);
      expect(collection.headers.get("Allow")).toBe("GET");
      const remove = await api(device, "/v1/recipes/bank-login", { method: "DELETE" });
      expect(remove.status).toBe(405);
      expect(remove.headers.get("Allow")).toBe("PUT");
    });
  });
}

export function registerOwnerLimitTests() {
  describe("per-owner limits", () => {
    it("refuses a recipe that would exceed the active recipe limit", async () => {
      const device = await enrollOwner();
      await seedActiveRecipes(device.ownerId, MAX_ACTIVE_RECIPES - 2);
      expect((await publish(device, "last", 0)).status).toBe(200);
      expect((await publish(device, "kept", 0)).status).toBe(200);

      const over = await publish(device, "over", 0);
      expect(over.status).toBe(409);
      expect(await over.json()).toEqual({ error: "recipe_limit" });
      expect(await revisions(device.ownerId, "over")).toEqual([]);
      // Updating or revoking an active recipe adds none.
      expect((await publish(device, "kept", 1)).status).toBe(200);
      const revoke = { version: 1, expectedRevision: 1, state: "revoked" };
      expect((await put(device, "/v1/recipes/last", revoke)).status).toBe(200);
      // The revoked recipe's place is free again, so the tombstone cannot come back once
      // another recipe takes it.
      expect((await publish(device, "over", 0)).status).toBe(200);
      const reactivate = await publish(device, "last", 2);
      expect(reactivate.status).toBe(409);
      expect(await reactivate.json()).toEqual({ error: "recipe_limit" });
      // A stale write is still a conflict, not the limit.
      const stale = await publish(device, "last", 1);
      expect(await stale.json()).toMatchObject({ error: "recipe_conflict" });

      // Another owner has its own limit.
      expect((await publish(await enrollOwner(), "over", 0)).status).toBe(200);
    });

    it("caps UTF-8 head bytes for creates and growth, while equal, shrinking and revoke writes pass", async () => {
      const device = await enrollOwner();
      const japanese = recipe("japanese", 1);
      japanese.layouts[0]!.completion = [{ target: { by: "text", value: "ようこそ".repeat(20) } }];
      const bytes = documentBytes(japanese);
      expect(bytes).toBeGreaterThan(JSON.stringify(japanese).length);
      await seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES - bytes);
      const write = (document: LoginRecipeDocument, expectedRevision: number) =>
        put(device, `/v1/recipes/${document.id}`, {
          version: 1,
          state: "active",
          expectedRevision,
          recipe: document,
        });
      expect((await write(japanese, 0)).status).toBe(200);
      expect(await storedRecipeBytes(device.ownerId)).toBe(MAX_ACTIVE_RECIPE_BYTES);
      const growing = {
        ...japanese,
        revision: 2,
        layouts: [
          {
            ...japanese.layouts[0]!,
            completion: [{ target: { by: "text" as const, value: "ようこそ".repeat(21) } }],
          },
        ],
      };
      const refused = await write(growing, 1);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "recipe_limit" });
      expect(await revisions(device.ownerId, japanese.id)).toEqual([
        { revision: 1, state: "active" },
      ]);
      const over = await publish(device, "over-bytes", 0);
      expect(await over.json()).toEqual({ error: "recipe_limit" });
      expect(await revisions(device.ownerId, "over-bytes")).toEqual([]);
      expect((await write({ ...japanese, revision: 2 }, 1)).status).toBe(200);
      // Only the current head counts, despite two retained revisions.
      expect(await storedRecipeBytes(device.ownerId)).toBe(MAX_ACTIVE_RECIPE_BYTES);
      expect((await publish(device, japanese.id, 2)).status).toBe(200);
      expect(await storedRecipeBytes(device.ownerId)).toBeLessThan(MAX_ACTIVE_RECIPE_BYTES);
      // Growth that fits replaces its old head, rather than counting both documents.
      expect((await write({ ...japanese, revision: 4 }, 3)).status).toBe(200);
      expect(await storedRecipeBytes(device.ownerId)).toBe(MAX_ACTIVE_RECIPE_BYTES);
      const stale = await write(growing, 1);
      expect(await stale.json()).toMatchObject({ error: "recipe_conflict" });
      expect(
        (
          await put(device, "/v1/recipes/byte-seed", {
            version: 1,
            expectedRevision: 1,
            state: "revoked",
          })
        ).status,
      ).toBe(200);
      expect(await storedRecipeBytes(device.ownerId)).toBe(
        documentBytes({ ...japanese, revision: 4 }),
      );
      expect((await publish(device, "over-bytes", 0)).status).toBe(200);
      expect((await publish(await enrollOwner(), "isolated", 0)).status).toBe(200);
    });

    it("allows equal and shrinking repairs even when existing active bytes exceed the cap", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "repair", 0)).status).toBe(200);
      await seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES);
      expect((await publish(device, "repair", 1)).status).toBe(200);
      const smaller = { ...recipe("repair", 3), completion: undefined };
      expect(
        (
          await put(device, "/v1/recipes/repair", {
            version: 1,
            expectedRevision: 2,
            state: "active",
            recipe: smaller,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await put(device, "/v1/recipes/repair", {
            version: 1,
            expectedRevision: 3,
            state: "revoked",
          })
        ).status,
      ).toBe(200);
      const republished = await publish(device, "repair", 4);
      expect(await republished.json()).toEqual({ error: "recipe_limit" });
    });

    it("serializes competing claims for the last available bytes", async () => {
      const device = await enrollOwner();
      const first = recipe("race-one", 1);
      const second = recipe("race-two", 1);
      await seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES - documentBytes(first));
      const results = await Promise.all(
        [first, second].map((document) =>
          writeRecipe(
            env.DB,
            device.ownerId,
            document.id,
            {
              version: 1,
              expectedRevision: 0,
              state: "active",
              recipe: document,
            },
            device.deviceId,
          ),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.limited)).toHaveLength(1);
      expect(await storedRecipeBytes(device.ownerId)).toBe(MAX_ACTIVE_RECIPE_BYTES);
    });

    it("keeps the newest revisions of a recipe and only the tombstone of a revoked one", async () => {
      const device = await enrollOwner();
      const writes = KEPT_RECIPE_REVISIONS + 2;
      for (let revision = 0; revision < writes; revision += 1)
        // oxlint-disable-next-line no-await-in-loop -- each write needs the previous revision
        expect((await publish(device, "bank-login", revision)).status).toBe(200);
      expect((await revisions(device.ownerId, "bank-login")).map((row) => row.revision)).toEqual(
        Array.from(
          { length: KEPT_RECIPE_REVISIONS },
          (_, index) => writes - KEPT_RECIPE_REVISIONS + index + 1,
        ),
      );
      // A losing write deletes nothing.
      expect((await publish(device, "bank-login", 1)).status).toBe(409);
      expect(await revisions(device.ownerId, "bank-login")).toHaveLength(KEPT_RECIPE_REVISIONS);

      const revoke = { version: 1, expectedRevision: writes, state: "revoked" };
      expect((await put(device, "/v1/recipes/bank-login", revoke)).status).toBe(200);
      expect(await revisions(device.ownerId, "bank-login")).toEqual([
        { revision: writes + 1, state: "revoked" },
      ]);
      expect((await publish(device, "bank-login", writes + 1)).status).toBe(200);
      expect(await revisions(device.ownerId, "bank-login")).toEqual([
        { revision: writes + 1, state: "revoked" },
        { revision: writes + 2, state: "active" },
      ]);
    });

    it("rate limits requests per owner across its devices, before reading bodies", async () => {
      const limitedEnv = withLimiter("OWNER_LIMITER", OWNER_LIMIT);
      const send = (device: Device, path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${device.token}`);
        return app.request(`https://pateat.invalid${path}`, { ...init, headers }, limitedEnv);
      };
      const first = await enrollOwner();
      const second = await addDevice(first.ownerId);
      const statuses: number[] = [];
      for (let request = 0; request < OWNER_LIMIT; request += 1)
        // oxlint-disable-next-line no-await-in-loop -- the limiter counts sequential calls
        statuses.push((await send(request % 2 === 0 ? first : second, "/v1/settings")).status);
      expect(statuses.every((status) => status === 200)).toBe(true);

      const limited = await send(second, "/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect(await limited.json()).toEqual({ error: "rate_limited" });
      expect((await send(first, "/v1/recipes")).status).toBe(429);
      expect(
        (
          await send(first, "/v1/recipes/bank-login/outcome", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{",
          })
        ).status,
      ).toBe(429);
      // Another owner is not counted against this one.
      expect((await send(await enrollOwner(), "/v1/settings")).status).toBe(200);
    });
  });

  // ADR 0019 and ADR 0012, amended 2026-10-18: how the first login of a revision ended.
}
