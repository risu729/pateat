import {
  createDefaultSettings,
  type LocalSettings,
  type LoginRecipeDocument,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { createDeviceToken, hashDeviceToken } from "../../src/auth";

// Synthetic owners, devices and recipes only. Each test creates its own owner so
// results never depend on storage shared with another test.

export type Device = { ownerId: string; deviceId: string; token: string };

export async function enrollOwner(): Promise<Device> {
  const ownerId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(ownerId, Date.now())
    .run();
  return addDevice(ownerId);
}

export async function addDevice(ownerId: string, lastUsedAt = Date.now()): Promise<Device> {
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

export async function recordedUse(device: Device): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT last_used_at FROM devices WHERE id = ?")
    .bind(device.deviceId)
    .first<{ last_used_at: number }>();
  return row?.last_used_at;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function api(device: Device | undefined, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (device) headers.set("Authorization", `Bearer ${device.token}`);
  return exports.default.fetch(`https://pateat.invalid${path}`, { ...init, headers });
}

export function put(device: Device, path: string, body: unknown) {
  return api(device, path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function settings(hostname = "excluded.example"): LocalSettings {
  return {
    ...createDefaultSettings(),
    connections: [],
    excludedSites: [{ hostname, includeSubdomains: true }],
  };
}

/** A link to the field that holds a login's personal detail (ADR 0061); references only. */
export function detailLink(origin = "https://bank.example", custom = "Birth date") {
  return {
    origin,
    provider: "bitwarden",
    server: "cloud-us",
    userId: "00000000-0000-4000-8000-000000000001",
    itemId: "item-1",
    detail: "birth-date" as const,
    source: { itemId: "identity-1", field: { custom } },
  };
}

/** A secret question's answer, linked with the question the owner confirmed. */
export function answerLink(custom = "Answer 1") {
  return {
    ...detailLink(),
    detail: "secret-answer" as const,
    source: { itemId: "item-1", field: { custom } },
    question: "what was your first pet",
  };
}

/** A stored recipe with one layout (ADR 0060). */
export function recipe(id: string, revision: number): LoginRecipeDocument {
  return {
    version: 1,
    id,
    revision,
    origin: "https://bank.example",
    layouts: [
      {
        key: "1000",
        language: "en",
        createdAt: 1000,
        pageKind: "sign-in",
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
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "submit" },
            purpose: "submit",
          },
        ],
        completion: [{ target: { by: "id", value: "welcome" } }],
        maxSubmissions: 1,
      },
    ],
  };
}

/** The fixture's one layout's route, as a chooser branch stores it. */
export const routeBody = () => {
  const {
    key: _key,
    language: _language,
    createdAt: _createdAt,
    ...body
  } = recipe("body", 1).layouts[0]!;
  return body;
};

export function publish(device: Device, id: string, expectedRevision: number) {
  return put(device, `/v1/recipes/${id}`, {
    version: 1,
    expectedRevision,
    state: "active",
    recipe: recipe(id, expectedRevision + 1),
  });
}

/** Adds `count` active recipe heads without history; only the active count reads them. */
export async function seedActiveRecipes(ownerId: string, count: number) {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at)
     SELECT ?, 'seeded-' || i, 1, 'active', 1000000 + i, 'seed-' || i, ? FROM n`,
  )
    .bind(count, ownerId, Date.now())
    .run();
}

export async function revisions(ownerId: string, recipeId: string) {
  const { results } = await env.DB.prepare(
    "SELECT revision, state FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ? ORDER BY revision",
  )
    .bind(ownerId, recipeId)
    .all<{ revision: number; state: string }>();
  return results;
}
