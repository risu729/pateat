import {
  createDefaultSettings,
  DEVICE_IDLE_LIMIT_MS,
  MAX_ACTIVE_RECIPE_BYTES,
  type LocalSettings,
  type LoginRecipe,
  type SyncRecipeChanges,
} from "@pateat/contracts";
import type { D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import {
  KEPT_RECIPE_REVISIONS,
  MAX_ACTIVE_RECIPES,
  MAX_IDLE_REVOCATIONS,
  RECIPE_IDLE_LIMIT_MS,
} from "../src/limits";
import { writeRecipe } from "../src/recipe-store";
import { documentBytes, seedRecipeBytes, storedRecipeBytes } from "./recipe-byte-helpers";
import { OWNER_LIMIT, withLimiter } from "./limiter";

// Synthetic owners, devices and recipes only. Each test creates its own owner so
// results never depend on storage shared with another test.

type Device = { ownerId: string; deviceId: string; token: string };

async function enrollOwner(): Promise<Device> {
  const ownerId = `owner-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(ownerId, Date.now())
    .run();
  return addDevice(ownerId);
}

async function addDevice(ownerId: string, lastUsedAt = Date.now()): Promise<Device> {
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.prepare(
    "INSERT INTO devices (id, owner_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(deviceId, ownerId, await hashDeviceToken(token), lastUsedAt, lastUsedAt)
    .run();
  return { ownerId, deviceId, token };
}

async function recordedUse(device: Device): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT last_used_at FROM devices WHERE id = ?")
    .bind(device.deviceId)
    .first<{ last_used_at: number }>();
  return row?.last_used_at;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function api(device: Device | undefined, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (device) headers.set("Authorization", `Bearer ${device.token}`);
  return exports.default.fetch(`https://pateat.invalid${path}`, { ...init, headers });
}

function put(device: Device, path: string, body: unknown) {
  return api(device, path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function settings(hostname = "excluded.example"): LocalSettings {
  return {
    ...createDefaultSettings(),
    excludedSites: [{ hostname, includeSubdomains: true }],
  };
}

function recipe(id: string, revision: number): LoginRecipe {
  return {
    version: 1,
    id,
    revision,
    origin: "https://bank.example",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [
          { slot: "username", target: { by: "id", value: "username" } },
          { slot: "password", target: { by: "id", value: "password" } },
        ],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "submit" }, purpose: "submit" },
    ],
    completion: [{ target: { by: "id", value: "welcome" } }],
    maxSubmissions: 1,
  };
}

function publish(device: Device, id: string, expectedRevision: number) {
  return put(device, `/v1/recipes/${id}`, {
    version: 1,
    expectedRevision,
    state: "active",
    recipe: recipe(id, expectedRevision + 1),
  });
}

/** Adds `count` active recipe heads without history; only the active count reads them. */
async function seedActiveRecipes(ownerId: string, count: number) {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at)
     SELECT ?, 'seeded-' || i, 1, 'active', 1000000 + i, 'seed-' || i, ? FROM n`,
  )
    .bind(count, ownerId, Date.now())
    .run();
}

async function revisions(ownerId: string, recipeId: string) {
  const { results } = await env.DB.prepare(
    "SELECT revision, state FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ? ORDER BY revision",
  )
    .bind(ownerId, recipeId)
    .all<{ revision: number; state: string }>();
  return results;
}

describe("device authentication", () => {
  it.each([
    ["no credential", undefined],
    ["a non-bearer scheme", "Basic c3ludGhldGljOnVudXNlZA=="],
    ["a malformed token", "Bearer synthetic-token"],
    ["an unknown token", `Bearer ${createDeviceToken()}`],
  ])("rejects %s without revealing data", async (_, authorization) => {
    const response = await exports.default.fetch("https://pateat.invalid/v1/settings", {
      headers: authorization ? { Authorization: authorization } : {},
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="pateat"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("stops a revoked device without affecting the owner's other devices", async () => {
    const first = await enrollOwner();
    const second = await addDevice(first.ownerId);
    await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), first.deviceId)
      .run();

    const write = await put(first, "/v1/settings", {
      version: 1,
      expectedRevision: 0,
      settings: settings(),
    });
    expect(write.status).toBe(401);
    expect(await write.json()).toEqual({ error: "device_revoked" });
    expect((await api(first, "/v1/recipes")).status).toBe(401);

    const read = await api(second, "/v1/settings");
    expect(await read.json()).toEqual({ version: 1, revision: 0, settings: null });
  });

  it("renews a device used 89 days ago", async () => {
    const owner = await enrollOwner();
    const device = await addDevice(owner.ownerId, Date.now() - 89 * DAY_MS);
    const before = Date.now();
    expect((await api(device, "/v1/settings")).status).toBe(200);
    expect(await recordedUse(device)).toBeGreaterThanOrEqual(before);
  });

  it("expires a device unused for more than 90 days", async () => {
    const owner = await enrollOwner();
    const idleSince = Date.now() - DEVICE_IDLE_LIMIT_MS - 60_000;
    const device = await addDevice(owner.ownerId, idleSince);
    const response = await api(device, "/v1/settings");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="pateat"');
    expect(await response.json()).toEqual({ error: "device_expired" });
    // A refused request does not renew the credential.
    expect(await recordedUse(device)).toBe(idleSince);
    expect((await api(owner, "/v1/settings")).status).toBe(200);
  });

  it("does not rewrite a device used within the last day", async () => {
    const owner = await enrollOwner();
    const recent = Date.now() - DAY_MS + 60_000;
    const device = await addDevice(owner.ownerId, recent);
    expect((await api(device, "/v1/settings")).status).toBe(200);
    expect(await recordedUse(device)).toBe(recent);
  });

  it("reports a revoked device as revoked even after it went idle", async () => {
    const owner = await enrollOwner();
    const device = await addDevice(owner.ownerId, Date.now() - DEVICE_IDLE_LIMIT_MS - DAY_MS);
    await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), device.deviceId)
      .run();
    const response = await api(device, "/v1/settings");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "device_revoked" });
  });

  it("accepts the bearer scheme case-insensitively", async () => {
    const device = await enrollOwner();
    const response = await exports.default.fetch("https://pateat.invalid/v1/settings", {
      headers: { Authorization: `bearer ${device.token}` },
    });
    expect(response.status).toBe(200);
  });

  it("authenticates before reading a request body", async () => {
    const response = await exports.default.fetch("https://pateat.invalid/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not json".repeat(20_000),
    });
    expect(response.status).toBe(401);
  });

  it("does not offer cross-origin access", async () => {
    const device = await enrollOwner();
    const response = await api(device, "/v1/settings", {
      headers: { Origin: "https://attacker.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("settings sync", () => {
  it("starts empty and accepts the first write only at revision 0", async () => {
    const device = await enrollOwner();
    expect(await (await api(device, "/v1/settings")).json()).toEqual({
      version: 1,
      revision: 0,
      settings: null,
    });

    const created = await put(device, "/v1/settings", {
      version: 1,
      expectedRevision: 0,
      settings: settings(),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ version: 1, revision: 1, settings: settings() });

    const duplicate = await put(device, "/v1/settings", {
      version: 1,
      expectedRevision: 0,
      settings: settings("other.example"),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, revision: 1, settings: settings() },
    });
  });

  it("never lets a stale device overwrite a newer restriction", async () => {
    const laptop = await enrollOwner();
    const desktop = await addDevice(laptop.ownerId);
    await put(laptop, "/v1/settings", { version: 1, expectedRevision: 0, settings: settings() });

    const newer = settings("newer.example");
    expect(
      (await put(desktop, "/v1/settings", { version: 1, expectedRevision: 1, settings: newer }))
        .status,
    ).toBe(200);
    const stale = await put(laptop, "/v1/settings", {
      version: 1,
      expectedRevision: 1,
      settings: createDefaultSettings(),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, revision: 2, settings: newer },
    });
  });

  it("accepts exactly one of two concurrent writes from the same revision", async () => {
    const device = await enrollOwner();
    await put(device, "/v1/settings", { version: 1, expectedRevision: 0, settings: settings() });
    const responses = await Promise.all(
      ["a.example", "b.example"].map((hostname) =>
        put(device, "/v1/settings", {
          version: 1,
          expectedRevision: 1,
          settings: settings(hostname),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await (await api(device, "/v1/settings")).json()).toMatchObject({ revision: 2 });
  });

  it("isolates owners even when another owner's revision would match", async () => {
    const alice = await enrollOwner();
    const bob = await enrollOwner();
    await put(alice, "/v1/settings", { version: 1, expectedRevision: 0, settings: settings() });

    expect(await (await api(bob, "/v1/settings")).json()).toEqual({
      version: 1,
      revision: 0,
      settings: null,
    });
    const crossWrite = await put(bob, "/v1/settings", {
      version: 1,
      expectedRevision: 1,
      settings: createDefaultSettings(),
    });
    expect(crossWrite.status).toBe(409);
    expect(await (await api(alice, "/v1/settings")).json()).toEqual({
      version: 1,
      revision: 1,
      settings: settings(),
    });
  });

  it.each([
    ["an unsupported schema version", { version: 2, expectedRevision: 0, settings: settings() }],
    [
      "device-local field policies",
      { version: 1, expectedRevision: 0, settings: settings(), fieldPolicies: [] },
    ],
    [
      "a value-bearing setting",
      {
        version: 1,
        expectedRevision: 0,
        settings: { ...settings(), password: "synthetic-forbidden-value" },
      },
    ],
    ["a negative revision", { version: 1, expectedRevision: -1, settings: settings() }],
  ])("rejects %s", async (_, body) => {
    const device = await enrollOwner();
    const response = await put(device, "/v1/settings", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(await (await api(device, "/v1/settings")).json()).toMatchObject({ revision: 0 });
  });

  it("rejects non-JSON media, malformed JSON and oversized bodies", async () => {
    const device = await enrollOwner();
    const body = JSON.stringify({ version: 1, expectedRevision: 0, settings: settings() });
    const text = await api(device, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body,
    });
    expect(text.status).toBe(415);
    expect(await text.json()).toEqual({ error: "unsupported_media_type" });

    const suffixed = await api(device, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/synthetic+json" },
      body: "{",
    });
    expect(suffixed.status).toBe(415);

    const malformed = await api(device, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "bad_request" });

    const oversized = await api(device, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(200 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "payload_too_large" });
  });

  it("fails closed without details when a stored document is corrupt", async () => {
    const device = await enrollOwner();
    await env.DB.prepare(
      "INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id) VALUES (?, 1, ?, 0, ?)",
    )
      .bind(device.ownerId, JSON.stringify({ synthetic: "corrupt" }), device.deviceId)
      .run();
    const response = await api(device, "/v1/settings");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  it("limits each path to its supported methods", async () => {
    const device = await enrollOwner();
    const response = await api(device, "/v1/settings", { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, PUT");
  });
});

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
        env.DB.prepare(`UPDATE ${table} SET revision = 0 WHERE owner_id = ?`).bind(device.ownerId),
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
    const varied = { ...recipe("bank-variants", 1), alternatives: [contract] };
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
    const elsewhere = await put(device, "/v1/recipes/bank-elsewhere", {
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: {
        ...recipe("bank-elsewhere", 1),
        alternatives: [
          { ...contract, steps: contract.steps.map((step) => ({ ...step, path: "/contract" })) },
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
    const { slots, steps, maxSubmissions } = recipe("bank-mixed", 1);
    const mixed = await put(device, "/v1/recipes/bank-mixed", {
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: { ...entry, id: "bank-mixed", slots, steps, maxSubmissions },
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
    const chooser = {
      version: 1,
      id: "bank-chooser",
      revision: 1,
      origin: "https://bank.example",
      chooser: {
        path: "/login",
        other: { by: "text", value: "Use another account" },
        afterAccount: recipe("bank-chooser", 1),
      },
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
    const stray = await put(device, "/v1/recipes/bank-stray", {
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: { ...chooser, id: "bank-stray" },
    });
    // Its branch still carries the chooser's own ID.
    expect(stray.status).toBe(400);
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
    japanese.completion = [{ target: { by: "text", value: "ようこそ".repeat(20) } }];
    const bytes = documentBytes(japanese);
    expect(bytes).toBeGreaterThan(JSON.stringify(japanese).length);
    await seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES - bytes);
    const write = (document: LoginRecipe, expectedRevision: number) =>
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
      completion: [{ target: { by: "text" as const, value: "ようこそ".repeat(21) } }],
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
describe("login outcomes", () => {
  const report = { version: 1, revision: 1, outcome: "unknown-submit", cause: "settled", step: 1 };
  const send = (device: Device | undefined, id: string, body: unknown, type = "application/json") =>
    api(device, `/v1/recipes/${id}/outcome`, {
      method: "POST",
      headers: { "Content-Type": type },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const stored = async (ownerId: string) =>
    (
      await env.DB.prepare(
        "SELECT recipe_id, branch, revision, outcome, cause, step FROM login_outcomes WHERE owner_id = ? ORDER BY recipe_id, revision",
      )
        .bind(ownerId)
        .all()
    ).results;

  it("keeps the first code of each revision, from any of the owner's devices", async () => {
    const device = await enrollOwner();
    const other = await addDevice(device.ownerId);
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    expect((await publish(device, "bank-login", 1)).status).toBe(200);
    const before = Date.now();
    const first = await send(device, "bank-login", report);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    // A repeat, or another device's later login of the same revision, changes nothing.
    expect((await send(other, "bank-login", { ...report, outcome: "authenticated" })).status).toBe(
      204,
    );
    expect(
      (
        await send(other, "bank-login", {
          version: 1,
          revision: 2,
          outcome: "authenticated",
          step: 2,
        })
      ).status,
    ).toBe(204);
    expect(
      (await send(device, "bank-login", { ...report, branch: "other", cause: "target-missing" }))
        .status,
    ).toBe(204);
    expect(await stored(device.ownerId)).toEqual([
      {
        recipe_id: "bank-login",
        branch: "",
        revision: 1,
        outcome: "unknown-submit",
        cause: "settled",
        step: 1,
      },
      {
        recipe_id: "bank-login",
        branch: "other",
        revision: 1,
        outcome: "unknown-submit",
        cause: "target-missing",
        step: 1,
      },
      {
        recipe_id: "bank-login",
        branch: "",
        revision: 2,
        outcome: "authenticated",
        cause: null,
        step: 2,
      },
    ]);
    // The service stamps the time itself.
    const { results } = await env.DB.prepare(
      "SELECT created_at FROM login_outcomes WHERE owner_id = ?",
    )
      .bind(device.ownerId)
      .all<{ created_at: number }>();
    expect(results.every((row) => row.created_at >= before && row.created_at <= Date.now())).toBe(
      true,
    );
  });

  it("refuses a recipe or revision the owner never had, and a revoked head", async () => {
    const device = await enrollOwner();
    const stranger = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    expect((await publish(stranger, "other-login", 0)).status).toBe(200);
    const statuses = await Promise.all([
      send(device, "missing-login", report),
      send(device, "other-login", report),
      send(stranger, "bank-login", report),
      send(device, "bank-login", { ...report, revision: 2 }),
    ]);
    expect(statuses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(await statuses[0]!.json()).toEqual({ error: "not_found" });
    expect(
      (
        await put(device, "/v1/recipes/bank-login", {
          version: 1,
          expectedRevision: 1,
          state: "revoked",
        })
      ).status,
    ).toBe(200);
    // Revision 2 is the tombstone; revision 1 ran before the revocation.
    expect((await send(device, "bank-login", { ...report, revision: 2 })).status).toBe(404);
    expect((await send(device, "bank-login", report)).status).toBe(204);
    expect(await stored(device.ownerId)).toHaveLength(1);
    expect(await stored(stranger.ownerId)).toEqual([]);
  });

  it("refuses anything but the codes, without echoing the input", async () => {
    const device = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    const bodies: unknown[] = [
      { ...report, url: "https://bank.example/login?user=someone" },
      { ...report, reason: "Password for someone@example.com was wrong" },
      { ...report, recipeId: "bank-login" },
      { ...report, createdAt: 1 },
      { ...report, outcome: "wrong password" },
      { ...report, cause: "Wrong password" },
      { ...report, branch: "list" },
      { ...report, revision: 0 },
      { ...report, step: 41 },
      { ...report, version: 2 },
      "{",
    ];
    const responses = await Promise.all(bodies.map((body) => send(device, "bank-login", body)));
    expect(responses.map((response) => response.status)).toEqual(bodies.map(() => 400));
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
      bodies.map(() => ({ error: "bad_request" })),
    );
    expect((await send(device, "bank-login", report, "text/plain")).status).toBe(415);
    expect(
      (await send(device, "bank-login", { ...report, padding: "x".repeat(2_000) })).status,
    ).toBe(413);
    expect((await send(device, "not a recipe", report)).status).toBe(400);
    expect(await stored(device.ownerId)).toEqual([]);
  });

  it("requires a device credential and answers other methods with 405", async () => {
    const device = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    const anonymous = await send(undefined, "bank-login", report);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized" });
    const wrong = await api(device, "/v1/recipes/bank-login/outcome", { method: "GET" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("Allow")).toBe("POST");
    expect(await stored(device.ownerId)).toEqual([]);
  });

  it("deletes codes older than a year when recipes are read or a code is kept", async () => {
    const device = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    expect((await publish(device, "bank-login", 1)).status).toBe(200);
    expect((await publish(device, "bank-login", 2)).status).toBe(200);
    const insert = (revision: number, age: number) =>
      env.DB.prepare(
        "INSERT INTO login_outcomes (owner_id, recipe_id, branch, revision, outcome, step, created_at) VALUES (?, 'bank-login', '', ?, 'authenticated', 1, ?)",
      ).bind(device.ownerId, revision, Date.now() - age);
    await env.DB.batch([insert(1, 366 * DAY_MS), insert(2, 364 * DAY_MS)]);
    expect((await api(device, "/v1/recipes")).status).toBe(200);
    expect((await stored(device.ownerId)).map((row) => row["revision"])).toEqual([2]);
    await insert(1, 366 * DAY_MS).run();
    expect((await send(device, "bank-login", { ...report, revision: 3 })).status).toBe(204);
    expect((await stored(device.ownerId)).map((row) => row["revision"])).toEqual([2, 3]);
  });
});

// ADR 0055: every ended login's result and times, with the site the service reads itself.
describe("login records", () => {
  const record = {
    version: 1,
    revision: 1,
    outcome: "authenticated",
    extensionBuild: "1c42ad3",
    totalMs: 9000,
    serviceMs: 2600,
    networkMs: 200,
    personMs: 4000,
    pageMs: 1800,
  };
  const send = (device: Device | undefined, id: string, body: unknown, type = "application/json") =>
    api(device, `/v1/recipes/${id}/logins`, {
      method: "POST",
      headers: { "Content-Type": type },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const stored = async (ownerId: string) =>
    (
      await env.DB.prepare(
        "SELECT recipe_id, branch, revision, origin, outcome, cause, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms FROM login_timings WHERE owner_id = ? ORDER BY created_at, total_ms",
      )
        .bind(ownerId)
        .all()
    ).results;

  it("keeps one row per login, from any of the owner's devices, with the recipe's own site", async () => {
    const device = await enrollOwner();
    const other = await addDevice(device.ownerId);
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    expect((await publish(device, "bank-login", 1)).status).toBe(200);
    const before = Date.now();
    const first = await send(device, "bank-login", record);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    // The same login sent again, or another login of the same revision, is another row.
    expect((await send(device, "bank-login", record)).status).toBe(204);
    expect(
      (
        await send(other, "bank-login", {
          ...record,
          revision: 2,
          branch: "other",
          outcome: "structural-mismatch",
          cause: "target-missing",
          totalMs: 12_000,
        })
      ).status,
    ).toBe(204);
    const rows = await stored(device.ownerId);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      recipe_id: "bank-login",
      branch: "",
      revision: 1,
      origin: "https://bank.example",
      outcome: "authenticated",
      cause: null,
      extension_build: "1c42ad3",
      total_ms: 9000,
      service_ms: 2600,
      network_ms: 200,
      person_ms: 4000,
      page_ms: 1800,
    });
    expect(rows.find((row) => row["revision"] === 2)).toMatchObject({
      branch: "other",
      origin: "https://bank.example",
      outcome: "structural-mismatch",
      cause: "target-missing",
    });
    // The service stamps the time and the row's ID itself.
    const { results } = await env.DB.prepare(
      "SELECT id, created_at FROM login_timings WHERE owner_id = ?",
    )
      .bind(device.ownerId)
      .all<{ id: string; created_at: number }>();
    expect(new Set(results.map((row) => row.id)).size).toBe(3);
    expect(results.every((row) => row.created_at >= before && row.created_at <= Date.now())).toBe(
      true,
    );
    // Login records are apart from the first login result codes.
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM login_outcomes WHERE owner_id = ?")
          .bind(device.ownerId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("refuses a recipe or revision the owner never had, and a revoked head", async () => {
    const device = await enrollOwner();
    const stranger = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    expect((await publish(stranger, "other-login", 0)).status).toBe(200);
    const statuses = await Promise.all([
      send(device, "missing-login", record),
      send(device, "other-login", record),
      send(stranger, "bank-login", record),
      send(device, "bank-login", { ...record, revision: 2 }),
    ]);
    expect(statuses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(await statuses[0]!.json()).toEqual({ error: "not_found" });
    expect(
      (
        await put(device, "/v1/recipes/bank-login", {
          version: 1,
          expectedRevision: 1,
          state: "revoked",
        })
      ).status,
    ).toBe(200);
    // Revision 2 is the tombstone. Revision 1 ran before the revocation, but a revoked
    // recipe keeps no document, so the service can no longer name its site.
    expect((await send(device, "bank-login", { ...record, revision: 2 })).status).toBe(404);
    expect((await send(device, "bank-login", record)).status).toBe(404);
    expect(await stored(device.ownerId)).toEqual([]);
    expect(await stored(stranger.ownerId)).toEqual([]);
  });

  it("takes the site from the newest kept revision once the reported one is pruned", async () => {
    const device = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    expect((await publish(device, "bank-login", 1)).status).toBe(200);
    await env.DB.prepare(
      "DELETE FROM recipe_revisions WHERE owner_id = ? AND recipe_id = 'bank-login' AND revision = 1",
    )
      .bind(device.ownerId)
      .run();
    expect((await send(device, "bank-login", record)).status).toBe(204);
    expect((await stored(device.ownerId)).map((row) => [row["revision"], row["origin"]])).toEqual([
      [1, "https://bank.example"],
    ]);
  });

  it("refuses a site, values, typing time and anything beyond the record, without echoing it", async () => {
    const device = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    const bodies: unknown[] = [
      { ...record, origin: "https://bank.example" },
      { ...record, url: "https://bank.example/login?user=someone" },
      { ...record, reason: "Password for someone@example.com was wrong" },
      { ...record, typingMs: 120 },
      { ...record, otherMs: 2400 },
      { ...record, createdAt: 1 },
      { ...record, outcome: "wrong password" },
      { ...record, cause: "Wrong password" },
      { ...record, extensionBuild: "someone@example.com" },
      { ...record, totalMs: -1 },
      { ...record, totalMs: 86_400_001 },
      { ...record, serviceMs: 1.5 },
      { ...record, pageMs: -1 },
      { ...record, pageMs: undefined },
      { ...record, branch: "list" },
      { ...record, revision: 0 },
      { ...record, version: 2 },
      "{",
    ];
    const responses = await Promise.all(bodies.map((body) => send(device, "bank-login", body)));
    expect(responses.map((response) => response.status)).toEqual(bodies.map(() => 400));
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
      bodies.map(() => ({ error: "bad_request" })),
    );
    expect((await send(device, "bank-login", record, "text/plain")).status).toBe(415);
    expect(
      (await send(device, "bank-login", { ...record, padding: "x".repeat(2_000) })).status,
    ).toBe(413);
    expect((await send(device, "not a recipe", record)).status).toBe(400);
    expect(await stored(device.ownerId)).toEqual([]);
  });

  it("requires a device credential and answers other methods with 405", async () => {
    const device = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    const anonymous = await send(undefined, "bank-login", record);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized" });
    const wrong = await api(device, "/v1/recipes/bank-login/logins", { method: "GET" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("Allow")).toBe("POST");
    expect(await stored(device.ownerId)).toEqual([]);
  });

  it("deletes records older than a year when recipes are read or a record is kept", async () => {
    const device = await enrollOwner();
    expect((await publish(device, "bank-login", 0)).status).toBe(200);
    const insert = (totalMs: number, age: number) =>
      env.DB.prepare(
        "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, 'bank-login', '', 1, 'https://bank.example', 'authenticated', 'development', ?, 0, 0, 0, 0, ?)",
      ).bind(`login-${crypto.randomUUID()}`, device.ownerId, totalMs, Date.now() - age);
    await env.DB.batch([insert(1, 366 * DAY_MS), insert(2, 364 * DAY_MS)]);
    expect((await api(device, "/v1/recipes")).status).toBe(200);
    expect((await stored(device.ownerId)).map((row) => row["total_ms"])).toEqual([2]);
    await insert(3, 366 * DAY_MS).run();
    expect((await send(device, "bank-login", record)).status).toBe(204);
    expect((await stored(device.ownerId)).map((row) => row["total_ms"])).toEqual([2, 9000]);
  });
});

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
    expect(await revisions(bob.ownerId, "bank-login")).toEqual([{ revision: 1, state: "active" }]);
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
    const use = { version: 1, revision: 1 };
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
        other: { by: "text", value: "Use another account" },
        afterAccount: recipe("bank-chooser", 1),
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
      const oversized = await reportUse(device, "bank-login", { ...use, padding: "x".repeat(300) });
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
          recipe: { ...chooser, id, chooser: { ...chooser.chooser, afterAccount: recipe(id, 1) } },
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
        (await reportLogin(device, "bank-chooser", { ...loginRecord, branch: "other" })).status,
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
