import {
  createDefaultSettings,
  DEVICE_IDLE_LIMIT_MS,
  type LocalSettings,
  type LoginRecipe,
  type SyncRecipeChanges,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { KEPT_RECIPE_REVISIONS, MAX_ACTIVE_RECIPES } from "../src/limits";
import { awaitRoomInMinute } from "./limiter";

// Synthetic owners, devices and recipes only. Each test creates its own owner so
// results never depend on storage shared with another test.

type Device = { ownerId: string; deviceId: string; token: string };

async function enrollOwner(): Promise<Device> {
  const ownerId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(ownerId, Date.now())
    .run();
  return addDevice(ownerId);
}

async function addDevice(ownerId: string, lastUsedAt = Date.now()): Promise<Device> {
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.prepare(
    "INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default') ON CONFLICT DO NOTHING",
  )
    .bind(ownerId, ownerId)
    .run();
  await env.DB.prepare(
    "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(deviceId, ownerId, ownerId, await hashDeviceToken(token), lastUsedAt, lastUsedAt)
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
    connections: [],
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
    expect(await read.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 0,
      settings: null,
    });
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
      profileId: expect.any(String),
      revision: 0,
      settings: null,
    });

    const created = await put(device, "/v1/settings", {
      version: 1,
      expectedRevision: 0,
      settings: settings(),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      version: 1,
      profileId: expect.any(String),
      revision: 1,
      settings: settings(),
    });

    const duplicate = await put(device, "/v1/settings", {
      version: 1,
      expectedRevision: 0,
      settings: settings("other.example"),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, profileId: expect.any(String), revision: 1, settings: settings() },
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
      settings: { ...createDefaultSettings(), connections: [] },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, profileId: expect.any(String), revision: 2, settings: newer },
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
      profileId: expect.any(String),
      revision: 0,
      settings: null,
    });
    const crossWrite = await put(bob, "/v1/settings", {
      version: 1,
      expectedRevision: 1,
      settings: { ...createDefaultSettings(), connections: [] },
    });
    expect(crossWrite.status).toBe(409);
    expect(await (await api(alice, "/v1/settings")).json()).toEqual({
      version: 1,
      profileId: expect.any(String),
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

  it("fails closed without details when a stored recipe is corrupt", async () => {
    const device = await enrollOwner();
    await publish(device, "bank-login", 0);
    await env.DB.prepare("UPDATE recipe_revisions SET document = ? WHERE owner_id = ?")
      .bind(JSON.stringify({ synthetic: "corrupt" }), device.ownerId)
      .run();
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
    const first = await enrollOwner();
    const second = await addDevice(first.ownerId);
    await awaitRoomInMinute();
    const statuses: number[] = [];
    for (let request = 0; request < 120; request += 1)
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts sequential calls
      statuses.push((await api(request % 2 === 0 ? first : second, "/v1/settings")).status);
    expect(statuses.every((status) => status === 200)).toBe(true);

    const limited = await api(second, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await api(first, "/v1/recipes")).status).toBe(429);
    // Another owner is not counted against this one.
    expect((await api(await enrollOwner(), "/v1/settings")).status).toBe(200);
  }, 20_000);
});
