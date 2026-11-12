import { type SyncRecipeChanges } from "@pateat/contracts";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_IDLE_REVOCATIONS, RECIPE_IDLE_LIMIT_MS } from "../../src/limits";
import { writeRecipe } from "../../src/recipe-store";

import {
  type Device,
  enrollOwner,
  addDevice,
  DAY_MS,
  api,
  put,
  recipe,
  routeBody,
  publish,
  revisions,
} from "./harness";

export function registerRecipeRevocationTests() {
  describe("unused recipe revocation (ADR 0058)", () => {
    /** Sets when the owner's recipe was last used, standing in for days without use. */
    const lastUsedAgo = (ownerId: string, recipeId: string, age: number) =>
      env.DB.prepare(
        "UPDATE recipe_heads SET last_used_at = ? WHERE owner_id = ? AND recipe_id = ?",
      ).bind(Date.now() - age, ownerId, recipeId);
    const head = (ownerId: string, recipeId: string) =>
      env.DB.prepare(
        "SELECT revision, state, sequence, last_used_at FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
      )
        .bind(ownerId, recipeId)
        .first<{ revision: number; state: string; sequence: number; last_used_at: number }>();
    const activeIds = async (ownerId: string) =>
      (
        await env.DB.prepare(
          "SELECT recipe_id FROM recipe_heads WHERE owner_id = ? AND state = 'active' ORDER BY recipe_id",
        )
          .bind(ownerId)
          .all<{ recipe_id: string }>()
      ).results.map((row) => row.recipe_id);
    const sync = async (device: Device, path = "/v1/recipes"): Promise<SyncRecipeChanges> => {
      const response = await api(device, path);
      expect(response.status).toBe(200);
      return response.json();
    };
    const loginRecord = {
      version: 1,
      revision: 1,
      branch: "1000",
      outcome: "structural-mismatch",
      cause: "target-missing",
      extensionBuild: "1c42ad3",
      totalMs: 9000,
      serviceMs: 2600,
      networkMs: 200,
      personMs: 4000,
      pageMs: 1800,
    };
    const reportLogin = (device: Device, id: string, body: unknown) =>
      api(device, `/v1/recipes/${id}/logins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("revokes a recipe unused for 90 days on the next sync, in that sync's feed", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      expect((await publish(device, "shop-login", 0)).status).toBe(200);
      await env.DB.batch([
        lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
        lastUsedAgo(device.ownerId, "shop-login", RECIPE_IDLE_LIMIT_MS - DAY_MS),
      ]);
      const page = await sync(device);
      expect(page).toEqual({
        version: 1,
        changes: [
          { recipeId: "shop-login", revision: 1, state: "active", recipe: recipe("shop-login", 1) },
          { recipeId: "bank-login", revision: 3, state: "revoked" },
        ],
        cursor: 4,
        complete: true,
      });
      // An ordinary tombstone written by the service, keeping only itself.
      expect(
        (
          await env.DB.prepare(
            "SELECT revision, state, document, created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND recipe_id = 'bank-login'",
          )
            .bind(device.ownerId)
            .all()
        ).results,
      ).toEqual([{ revision: 3, state: "revoked", document: null, created_by_device_id: null }]);
      // A device that already synced past the old head receives only the tombstone.
      expect(await sync(device, "/v1/recipes?after=3")).toMatchObject({
        changes: [{ recipeId: "bank-login", revision: 3, state: "revoked" }],
      });
      // Nothing more to revoke: another sync writes nothing.
      expect(await sync(device, "/v1/recipes?after=4")).toEqual({
        version: 1,
        changes: [],
        cursor: 4,
        complete: true,
      });
      // The next visit generates it again as the revision after the tombstone.
      expect((await publish(device, "bank-login", 3)).status).toBe(200);
      expect(await head(device.ownerId, "bank-login")).toMatchObject({
        revision: 4,
        state: "active",
      });
    });

    it("never revokes an entry recipe (ADR 0031), however long unused", async () => {
      const device = await enrollOwner();
      const entry = {
        version: 1,
        id: "bank-entry",
        revision: 1,
        origin: "https://bank.example",
        entry: { path: "/", target: { by: "text", value: "Login" } },
      };
      expect(
        (
          await put(device, "/v1/recipes/bank-entry", {
            version: 1,
            expectedRevision: 0,
            state: "active",
            recipe: entry,
          })
        ).status,
      ).toBe(200);
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      await env.DB.batch([
        lastUsedAgo(device.ownerId, "bank-entry", 10 * RECIPE_IDLE_LIMIT_MS),
        lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
      ]);
      expect((await sync(device)).changes).toEqual([
        { recipeId: "bank-entry", revision: 1, state: "active", recipe: entry },
        { recipeId: "bank-login", revision: 2, state: "revoked" },
      ]);
      expect(await activeIds(device.ownerId)).toEqual(["bank-entry"]);
    });

    it("never revokes a recipe generated as confirm or unclear (ADR 0035), which never runs", async () => {
      const device = await enrollOwner();
      for (const [id, pageKind] of [
        ["bank-confirm", "confirm"],
        ["bank-unclear", "unclear"],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- Each write takes the next sequence.
        const written = await put(device, `/v1/recipes/${id}`, {
          version: 1,
          expectedRevision: 0,
          state: "active",
          // The layout keeps the page kind (ADR 0060).
          recipe: {
            ...recipe(id, 1),
            layouts: recipe(id, 1).layouts.map((layout) => ({ ...layout, pageKind })),
          },
        });
        expect(written.status).toBe(200);
      }
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      await env.DB.batch([
        lastUsedAgo(device.ownerId, "bank-confirm", 10 * RECIPE_IDLE_LIMIT_MS),
        lastUsedAgo(device.ownerId, "bank-unclear", 10 * RECIPE_IDLE_LIMIT_MS),
        lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
      ]);
      expect((await sync(device)).changes).toMatchObject([
        { recipeId: "bank-confirm", revision: 1, state: "active" },
        { recipeId: "bank-unclear", revision: 1, state: "active" },
        { recipeId: "bank-login", revision: 2, state: "revoked" },
      ]);
      expect(await activeIds(device.ownerId)).toEqual(["bank-confirm", "bank-unclear"]);
    });

    it("counts a reported login, also on an older revision, as use", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      expect((await publish(device, "shop-login", 0)).status).toBe(200);
      await env.DB.batch([
        lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
        lastUsedAgo(device.ownerId, "shop-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
      ]);
      const before = Date.now();
      // A failed login on revision 1 while revision 2 is the head still counts.
      expect((await reportLogin(device, "bank-login", loginRecord)).status).toBe(204);
      const used = await head(device.ownerId, "bank-login");
      expect(used?.last_used_at).toBeGreaterThanOrEqual(before);
      expect(used?.last_used_at).toBeLessThanOrEqual(Date.now());
      // Marking use writes no revision and takes no sequence number.
      expect(used).toMatchObject({ revision: 2, state: "active", sequence: 2 });
      await sync(device);
      expect(await activeIds(device.ownerId)).toEqual(["bank-login"]);
      expect(await head(device.ownerId, "shop-login")).toMatchObject({
        revision: 2,
        state: "revoked",
      });
    });

    it("counts every winning write as use, and a losing one as none", async () => {
      const device = await enrollOwner();
      const before = Date.now();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const written = (await head(device.ownerId, "bank-login"))!.last_used_at;
      expect(written).toBeGreaterThanOrEqual(before);
      expect(written).toBeLessThanOrEqual(Date.now());

      await lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS).run();
      const aged = (await head(device.ownerId, "bank-login"))!.last_used_at;
      expect((await publish(device, "bank-login", 0)).status).toBe(409);
      expect((await head(device.ownerId, "bank-login"))!.last_used_at).toBe(aged);

      const beforeUpdate = Date.now();
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      expect((await head(device.ownerId, "bank-login"))!.last_used_at).toBeGreaterThanOrEqual(
        beforeUpdate,
      );
      await sync(device);
      expect(await head(device.ownerId, "bank-login")).toMatchObject({
        revision: 2,
        state: "active",
      });
    });

    it("does not revoke a recipe used again after the idle check read it", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const lastUsedAt = Date.now() - RECIPE_IDLE_LIMIT_MS - DAY_MS;
      await env.DB.prepare(
        "UPDATE recipe_heads SET last_used_at = ? WHERE owner_id = ? AND recipe_id = 'bank-login'",
      )
        .bind(lastUsedAt, device.ownerId)
        .run();
      const revoke = { version: 1, expectedRevision: 1, state: "revoked" } as const;
      // Used at exactly the cutoff, or later, is not unused before it.
      for (const unusedBefore of [lastUsedAt, lastUsedAt - 1]) {
        // oxlint-disable-next-line no-await-in-loop -- each write reads the same head
        const refused = await writeRecipe(env.DB, device.ownerId, "bank-login", revoke, null, {
          unusedBefore,
        });
        expect(refused).toEqual({
          ok: false,
          limited: false,
          current: {
            recipeId: "bank-login",
            revision: 1,
            state: "active",
            recipe: recipe("bank-login", 1),
          },
        });
      }
      expect(await head(device.ownerId, "bank-login")).toMatchObject({
        revision: 1,
        state: "active",
        last_used_at: lastUsedAt,
      });
      expect(
        await writeRecipe(env.DB, device.ownerId, "bank-login", revoke, null, {
          unusedBefore: lastUsedAt + 1,
        }),
      ).toEqual({
        ok: true,
        change: { recipeId: "bank-login", revision: 2, state: "revoked" },
      });
    });

    it("revokes at most 50 recipes per check, the longest unused first", async () => {
      const device = await enrollOwner();
      const count = MAX_IDLE_REVOCATIONS + 5;
      const ids = Array.from(
        { length: count },
        (_, index) => `idle-${String(index).padStart(2, "0")}`,
      );
      for (const id of ids)
        // oxlint-disable-next-line no-await-in-loop -- each write takes the next owner sequence
        await writeRecipe(
          env.DB,
          device.ownerId,
          id,
          { version: 1, expectedRevision: 0, state: "active", recipe: recipe(id, 1) },
          device.deviceId,
        );
      // idle-00 is the longest unused; the last five were used most recently.
      await env.DB.batch(
        ids.map((id, index) =>
          lastUsedAgo(device.ownerId, id, RECIPE_IDLE_LIMIT_MS + (count - index) * DAY_MS),
        ),
      );
      const first = await sync(device);
      const revoked = first.changes.filter((change) => change.state === "revoked");
      expect(revoked).toHaveLength(MAX_IDLE_REVOCATIONS);
      expect(revoked.map((change) => change.recipeId).toSorted()).toEqual(
        ids.slice(0, MAX_IDLE_REVOCATIONS),
      );
      expect(await activeIds(device.ownerId)).toEqual(ids.slice(MAX_IDLE_REVOCATIONS));

      const second = await sync(device, `/v1/recipes?after=${first.cursor}`);
      expect(second.changes.map((change) => [change.recipeId, change.state])).toEqual(
        ids.slice(MAX_IDLE_REVOCATIONS).map((id) => [id, "revoked"]),
      );
      expect(await activeIds(device.ownerId)).toEqual([]);
    });

    it("leaves other owners' recipes alone", async () => {
      const alice = await enrollOwner();
      const bob = await enrollOwner();
      expect((await publish(alice, "bank-login", 0)).status).toBe(200);
      expect((await publish(bob, "bank-login", 0)).status).toBe(200);
      await env.DB.batch([
        lastUsedAgo(alice.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
        lastUsedAgo(bob.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
      ]);
      const bobBefore = await head(bob.ownerId, "bank-login");
      await sync(alice);
      expect(await head(alice.ownerId, "bank-login")).toMatchObject({ state: "revoked" });
      expect(await head(bob.ownerId, "bank-login")).toEqual(bobBefore);
      expect(await revisions(bob.ownerId, "bank-login")).toEqual([
        { revision: 1, state: "active" },
      ]);
      // Bob's own sync revokes his.
      expect((await sync(bob)).changes).toEqual([
        { recipeId: "bank-login", revision: 2, state: "revoked" },
      ]);
    });

    it("starts existing recipes from the newest of their last write and last login", async () => {
      const device = await enrollOwner();
      const stranger = await enrollOwner();
      for (const id of ["logged-in", "logged-earlier", "never-logged"])
        // oxlint-disable-next-line no-await-in-loop -- each write takes the next owner sequence
        expect((await publish(device, id, 0)).status).toBe(200);
      expect((await publish(stranger, "never-logged", 0)).status).toBe(200);
      const login = (by: Device, recipeId: string, createdAt: number) =>
        env.DB.prepare(
          "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, ?, '', 1, 'https://bank.example', 'authenticated', 'development', 1, 0, 0, 0, 0, ?)",
        ).bind(`login-${crypto.randomUUID()}`, by.ownerId, recipeId, createdAt);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE recipe_heads SET updated_at = 1000, last_used_at = 0 WHERE owner_id = ?",
        ).bind(device.ownerId),
        login(device, "logged-in", 3000),
        login(device, "logged-in", 5000),
        login(device, "logged-earlier", 500),
        // Another owner's login on the same recipe ID is not this owner's use.
        login(stranger, "never-logged", 9000),
      ]);
      const migration = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS.find(
        ({ name }) => name.startsWith("0021_"),
      );
      // The committed statement, without its comments or the column it fills.
      const backfill = migration?.queries
        .map((query) => query.replaceAll(/^--.*$/gm, "").trim())
        .find((query) => query.startsWith("UPDATE"));
      expect(backfill).toBeDefined();
      // Scoped to this owner so it leaves other tests' rows alone.
      await env.DB.prepare(`${backfill!.replace(/;$/, "")} WHERE owner_id = ?`)
        .bind(device.ownerId)
        .run();
      const { results } = await env.DB.prepare(
        "SELECT recipe_id, last_used_at FROM recipe_heads WHERE owner_id = ? ORDER BY recipe_id",
      )
        .bind(device.ownerId)
        .all();
      expect(results).toEqual([
        { recipe_id: "logged-earlier", last_used_at: 1000 },
        { recipe_id: "logged-in", last_used_at: 5000 },
        { recipe_id: "never-logged", last_used_at: 1000 },
      ]);
    });

    describe("use reports", () => {
      const reportUse = (
        device: Device | undefined,
        id: string,
        body: unknown,
        type = "application/json",
      ) =>
        api(device, `/v1/recipes/${id}/use`, {
          method: "POST",
          headers: { "Content-Type": type },
          body: typeof body === "string" ? body : JSON.stringify(body),
        });
      const use = { version: 1, revision: 1, layout: "1000" };
      const rowCount = async (table: string, ownerId: string) =>
        (
          await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`)
            .bind(ownerId)
            .first<{ n: number }>()
        )?.n;
      const chooser = {
        version: 1,
        id: "bank-chooser",
        revision: 1,
        origin: "https://bank.example",
        chooser: {
          path: "/login",
          layouts: [
            {
              key: "1000",
              createdAt: 1000,
              other: { by: "text", value: "Use another account" },
              afterAccount: routeBody(),
            },
          ],
        },
      };

      it("marks the head or an older revision used, writing no revision or record", async () => {
        const device = await enrollOwner();
        const other = await addDevice(device.ownerId);
        expect((await publish(device, "bank-login", 0)).status).toBe(200);
        expect((await publish(device, "bank-login", 1)).status).toBe(200);
        await lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS).run();
        const before = Date.now();
        const onHead = await reportUse(device, "bank-login", { ...use, revision: 2 });
        expect(onHead.status).toBe(204);
        expect(await onHead.text()).toBe("");
        const used = await head(device.ownerId, "bank-login");
        expect(used?.last_used_at).toBeGreaterThanOrEqual(before);
        expect(used?.last_used_at).toBeLessThanOrEqual(Date.now());
        expect(used).toMatchObject({ revision: 2, state: "active", sequence: 2 });

        // A device still on revision 1, another of the owner's, counts as well.
        await lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS).run();
        const beforeOlder = Date.now();
        expect((await reportUse(other, "bank-login", use)).status).toBe(204);
        const older = await head(device.ownerId, "bank-login");
        expect(older?.last_used_at).toBeGreaterThanOrEqual(beforeOlder);
        expect(older).toMatchObject({ revision: 2, state: "active", sequence: 2 });
        // A repeated report is another 204 and changes nothing else.
        expect((await reportUse(device, "bank-login", use)).status).toBe(204);
        expect(await revisions(device.ownerId, "bank-login")).toEqual([
          { revision: 1, state: "active" },
          { revision: 2, state: "active" },
        ]);
        expect(await rowCount("login_timings", device.ownerId)).toBe(0);
        expect(await rowCount("login_outcomes", device.ownerId)).toBe(0);
      });

      it("refuses a revision above the head, an unknown or another owner's recipe and a revoked head", async () => {
        const device = await enrollOwner();
        const stranger = await enrollOwner();
        expect((await publish(device, "bank-login", 0)).status).toBe(200);
        expect((await publish(stranger, "other-login", 0)).status).toBe(200);
        await env.DB.batch([
          lastUsedAgo(device.ownerId, "bank-login", DAY_MS),
          lastUsedAgo(stranger.ownerId, "other-login", DAY_MS),
        ]);
        const ownBefore = await head(device.ownerId, "bank-login");
        const strangerBefore = await head(stranger.ownerId, "other-login");
        const responses = await Promise.all([
          reportUse(device, "bank-login", { ...use, revision: 2 }),
          reportUse(device, "missing-login", use),
          reportUse(device, "other-login", use),
          reportUse(stranger, "bank-login", use),
        ]);
        expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
        expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
          responses.map(() => ({ error: "not_found" })),
        );
        expect(await head(device.ownerId, "bank-login")).toEqual(ownBefore);
        expect(await head(stranger.ownerId, "other-login")).toEqual(strangerBefore);
        // Another owner's report never creates a head for its recipe ID either.
        expect(await head(device.ownerId, "other-login")).toBeNull();

        expect(
          (
            await put(device, "/v1/recipes/bank-login", {
              version: 1,
              expectedRevision: 1,
              state: "revoked",
            })
          ).status,
        ).toBe(200);
        await lastUsedAgo(device.ownerId, "bank-login", DAY_MS).run();
        const revoked = await head(device.ownerId, "bank-login");
        // Revision 2 is the tombstone; revision 1 ran before the revocation, but the recipe
        // is gone and nothing keeps it now.
        expect((await reportUse(device, "bank-login", { ...use, revision: 2 })).status).toBe(404);
        expect((await reportUse(device, "bank-login", use)).status).toBe(404);
        expect(await head(device.ownerId, "bank-login")).toEqual(revoked);
      });

      it("refuses other bodies, oversized ones, other methods and no credential, changing nothing", async () => {
        const device = await enrollOwner();
        expect((await publish(device, "bank-login", 0)).status).toBe(200);
        await lastUsedAgo(device.ownerId, "bank-login", DAY_MS).run();
        const before = await head(device.ownerId, "bank-login");
        const bodies: unknown[] = [
          { ...use, revision: 0 },
          { ...use, revision: -1 },
          { ...use, revision: 1.5 },
          { ...use, revision: "1" },
          { version: 1 },
          { ...use, version: 2 },
          { revision: 1 },
          { version: 1, revision: 1 },
          { ...use, layout: "1000:account" },
          { ...use, origin: "https://bank.example" },
          { ...use, url: "https://bank.example/login?user=someone" },
          { ...use, branch: "other" },
          { ...use, at: 1 },
          [],
          "{",
        ];
        const responses = await Promise.all(
          bodies.map((body) => reportUse(device, "bank-login", body)),
        );
        expect(responses.map((response) => response.status)).toEqual(bodies.map(() => 400));
        expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
          bodies.map(() => ({ error: "bad_request" })),
        );
        expect((await reportUse(device, "bank-login", use, "text/plain")).status).toBe(415);
        const oversized = await reportUse(device, "bank-login", {
          ...use,
          padding: "x".repeat(300),
        });
        expect(oversized.status).toBe(413);
        expect(await oversized.json()).toEqual({ error: "payload_too_large" });
        expect((await reportUse(device, "not a recipe", use)).status).toBe(400);
        const anonymous = await reportUse(undefined, "bank-login", use);
        expect(anonymous.status).toBe(401);
        expect(await anonymous.json()).toEqual({ error: "unauthorized" });
        for (const method of ["GET", "PUT", "DELETE"]) {
          // oxlint-disable-next-line no-await-in-loop -- each method is its own request
          const wrong = await api(device, "/v1/recipes/bank-login/use", { method });
          expect(wrong.status).toBe(405);
          expect(wrong.headers.get("Allow")).toBe("POST");
        }
        expect(await head(device.ownerId, "bank-login")).toEqual(before);
      });

      it("keeps a recipe aged past 90 days that is used before the next sync", async () => {
        const device = await enrollOwner();
        expect((await publish(device, "bank-login", 0)).status).toBe(200);
        expect((await publish(device, "shop-login", 0)).status).toBe(200);
        await env.DB.batch([
          lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
          lastUsedAgo(device.ownerId, "shop-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
        ]);
        expect((await reportUse(device, "bank-login", use)).status).toBe(204);
        expect((await sync(device)).changes).toEqual([
          { recipeId: "bank-login", revision: 1, state: "active", recipe: recipe("bank-login", 1) },
          { recipeId: "shop-login", revision: 2, state: "revoked" },
        ]);
        expect(await activeIds(device.ownerId)).toEqual(["bank-login"]);
        // Marking use wrote no revision and took no sequence number.
        expect(await head(device.ownerId, "bank-login")).toMatchObject({
          revision: 1,
          state: "active",
          sequence: 1,
        });
      });

      it("keeps a chooser recipe whose branch login was recorded or started (ADR 0028)", async () => {
        const device = await enrollOwner();
        for (const id of ["bank-chooser", "shop-chooser"]) {
          const written = put(device, `/v1/recipes/${id}`, {
            version: 1,
            expectedRevision: 0,
            state: "active",
            recipe: { ...chooser, id },
          });
          // oxlint-disable-next-line no-await-in-loop -- each write takes the next owner sequence
          expect((await written).status).toBe(200);
        }
        expect((await publish(device, "idle-login", 0)).status).toBe(200);
        await env.DB.batch(
          ["bank-chooser", "shop-chooser", "idle-login"].map((id) =>
            lastUsedAgo(device.ownerId, id, RECIPE_IDLE_LIMIT_MS + DAY_MS),
          ),
        );
        // A login that ran the chooser's `other` branch.
        expect(
          (await reportLogin(device, "bank-chooser", { ...loginRecord, branch: "1000:other" }))
            .status,
        ).toBe(204);
        // A login that started on the other chooser, whatever branch it took.
        expect((await reportUse(device, "shop-chooser", use)).status).toBe(204);
        await sync(device);
        expect(await activeIds(device.ownerId)).toEqual(["bank-chooser", "shop-chooser"]);
        expect(await head(device.ownerId, "idle-login")).toMatchObject({ state: "revoked" });
      });

      it("revokes an active head whose document no longer validates once it is unused", async () => {
        const device = await enrollOwner();
        expect((await publish(device, "bank-login", 0)).status).toBe(200);
        expect((await publish(device, "shop-login", 0)).status).toBe(200);
        // Stands in for stored documents that a later, stricter contract refuses.
        await env.DB.prepare(
          "UPDATE recipe_revisions SET document = ? WHERE owner_id = ? AND recipe_id IN ('bank-login', 'shop-login')",
        )
          .bind(JSON.stringify({ synthetic: "unreadable" }), device.ownerId)
          .run();
        await env.DB.batch([
          lastUsedAgo(device.ownerId, "bank-login", RECIPE_IDLE_LIMIT_MS + DAY_MS),
          lastUsedAgo(device.ownerId, "shop-login", RECIPE_IDLE_LIMIT_MS - DAY_MS),
        ]);
        // Both read as revoked; only the unused one becomes a tombstone.
        expect(await sync(device)).toEqual({
          version: 1,
          changes: [
            { recipeId: "shop-login", revision: 1, state: "revoked" },
            { recipeId: "bank-login", revision: 2, state: "revoked" },
          ],
          cursor: 3,
          complete: true,
        });
        expect(await head(device.ownerId, "bank-login")).toMatchObject({
          revision: 2,
          state: "revoked",
        });
        expect(await revisions(device.ownerId, "bank-login")).toEqual([
          { revision: 2, state: "revoked" },
        ]);
        expect(await head(device.ownerId, "shop-login")).toMatchObject({
          revision: 1,
          state: "active",
        });
      });

      it("leaves a revoked head's last use alone when a login is reported on it", async () => {
        const device = await enrollOwner();
        expect((await publish(device, "bank-login", 0)).status).toBe(200);
        expect(
          (
            await put(device, "/v1/recipes/bank-login", {
              version: 1,
              expectedRevision: 1,
              state: "revoked",
            })
          ).status,
        ).toBe(200);
        await lastUsedAgo(device.ownerId, "bank-login", DAY_MS).run();
        const revoked = await head(device.ownerId, "bank-login");
        expect((await reportLogin(device, "bank-login", loginRecord)).status).toBe(404);
        expect(await head(device.ownerId, "bank-login")).toEqual(revoked);
        // Stands in for a revision document kept past the revocation: the record is kept
        // as one of a revision the owner held, but it marks no revoked recipe used.
        await env.DB.prepare(
          "INSERT INTO recipe_revisions (owner_id, recipe_id, revision, state, document, created_at, created_by_device_id) VALUES (?, 'bank-login', 1, 'active', ?, 0, NULL)",
        )
          .bind(device.ownerId, JSON.stringify(recipe("bank-login", 1)))
          .run();
        expect((await reportLogin(device, "bank-login", loginRecord)).status).toBe(204);
        expect(await rowCount("login_timings", device.ownerId)).toBe(1);
        expect(await head(device.ownerId, "bank-login")).toEqual(revoked);
      });
    });
  });
}
