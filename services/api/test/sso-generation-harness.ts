import {
  toLoginLayout,
  type LoginObservation,
  type LoginRecipe,
  type ObservedCandidate,
  type RecipeGenerationResult,
  type SemanticSlot,
  type SsoGenerationResult,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";
import { writeRecipe } from "../src/recipe-store";

// The harness of the SSO generation tests (ADR 0026 amendment of 2026-11-12), which call
// the service's generation route. Synthetic owners, devices, federation identifiers and
// pages only; Anthropic's token endpoint and the Messages API are answered locally.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ORIGIN = "https://shop.example.test";

export const slots: SemanticSlot[] = [
  { id: "email", kind: "identifier", description: "account email address" },
  { id: "password", kind: "secret", description: "account password" },
];
export const element = (id: string, role: ObservedCandidate["role"], label: string) => ({
  id,
  role,
  target: { by: "id" as const, value: id },
  label,
});
export const observation = (path: string, candidates: ObservedCandidate[]): LoginObservation => ({
  version: 1,
  origin: ORIGIN,
  path,
  language: "en",
  complete: true,
  candidates,
});
export const emailPage = observation("/login", [
  element("email", "email", "Email"),
  element("next", "button", "Next"),
]);
/** A native first page's answer. */
export const plan = (
  fields: [string, string][],
  action: string,
  purpose: "advance" | "submit",
  page: { pageKind: "sign-in" | "confirm"; irreversible: "no" | "yes" } = {
    pageKind: "sign-in",
    irreversible: "no",
  },
) =>
  JSON.stringify({
    result: {
      decision: "plan",
      ...page,
      fields: fields.map(([slot, candidate]) => ({ slot, candidate })),
      action: { candidate: action, purpose },
    },
  });
/** An SSO answer naming each requested label, by its index, beside a candidate. */
export const ssoAnswer = (...candidates: string[]) =>
  JSON.stringify({
    result: {
      decision: "plan",
      page: "sign-in",
      entries: candidates.map((candidate, labelIndex) => ({ labelIndex, candidate })),
    },
  });

/** A text answer or a refusal with its category. */
type Reply = { text: string } | { refusal: string };
/**
 * The synthetic Messages API: the answers queued for the next calls, the calls sent, and
 * a hook that runs while the next call is in flight, before its answer.
 */
export const claude: {
  replies: Reply[];
  sent: { body: unknown }[];
  during: (() => Promise<void>) | undefined;
} = { replies: [], sent: [], during: undefined };
const originalFetch = globalThis.fetch;

/** Answers the token endpoint and the Messages API locally for the file's tests. */
export function useSyntheticClaude() {
  beforeAll(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const outbound = new Request(input, init);
      if (outbound.url === TOKEN_URL)
        return Response.json({
          access_token: "synthetic-access-token",
          token_type: "Bearer",
          expires_in: 600,
        });
      if (outbound.url === MESSAGES_URL) {
        const body = (await outbound.json()) as { model: string };
        claude.sent.push({ body });
        const reply = claude.replies.shift();
        if (reply === undefined) throw new Error("No synthetic reply queued");
        const hook = claude.during;
        claude.during = undefined;
        await hook?.();
        return Response.json({
          id: "msg_synthetic",
          type: "message",
          role: "assistant",
          model: body.model,
          ...("refusal" in reply
            ? {
                content: [],
                stop_reason: "refusal",
                stop_details: {
                  type: "refusal",
                  category: reply.refusal,
                  explanation: "synthetic",
                },
              }
            : { content: [{ type: "text", text: reply.text }], stop_reason: "end_turn" }),
          stop_sequence: null,
          usage: { input_tokens: 3_000, output_tokens: 900 },
        });
      }
      return originalFetch(input, init);
    });
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    claude.replies.length = 0;
    claude.sent.length = 0;
    claude.during = undefined;
  });
}

export type Device = { ownerId: string; deviceId: string; token: string };

/** The owner's call slots (ADR 0018), held by another request for the next minute. */
export const holdSlots = (ownerId: string) =>
  env.DB.batch(
    [0, 1, 2, 3, 4].map((slot) =>
      env.DB.prepare(
        "INSERT INTO inference_locks (owner_id, slot, lock_id, expires_at) VALUES (?, ?, 'other', ?)",
      ).bind(ownerId, slot, Date.now() + 60_000),
    ),
  );

export async function owner({ claude: configured = true } = {}): Promise<Device> {
  const ownerId = crypto.randomUUID();
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')").bind(
      ownerId,
      ownerId,
    ),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(deviceId, ownerId, ownerId, await hashDeviceToken(token), Date.now(), Date.now()),
  ]);
  if (configured)
    await saveWifCredential(env.DB, ownerId, {
      federationRuleId: "fdrl_01SyntheticRule",
      organizationId: "00000000-0000-4000-8000-000000000000",
      serviceAccountId: "svac_01SyntheticAccount",
      workspaceId: "wrkspc_01SyntheticWorkspace",
    });
  return { ownerId, deviceId, token };
}

export const post = (device: Device, path: string, body: unknown) =>
  exports.default.fetch(`https://pateat.invalid${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** The owner's stored head document of a recipe, as the service keeps it. */
export async function storedHead(ownerId: string, recipeId: string): Promise<unknown> {
  const document = await env.DB.prepare(
    `SELECT r.document FROM recipe_heads h JOIN recipe_revisions r
      ON r.owner_id = h.owner_id AND r.recipe_id = h.recipe_id AND r.revision = h.revision
      WHERE h.owner_id = ? AND h.recipe_id = ?`,
  )
    .bind(ownerId, recipeId)
    .first<string>("document");
  return document === null ? null : JSON.parse(document);
}

/** A route recipe stored back as a recipe document with that one layout (ADR 0060). */
export const documentOf = (recipe: LoginRecipe): StoredLoginRecipe => ({
  version: 1,
  id: recipe.id,
  revision: recipe.revision,
  origin: recipe.origin,
  layouts: [toLoginLayout(recipe, { key: recipe.layout ?? "1000", createdAt: 1000 })],
});

/** A first page's generation request, as a device sends it, and its answer. */
export async function generate(
  device: Device,
  page: LoginObservation,
  extra: Record<string, unknown> = {},
) {
  const response = await post(device, "/v1/recipes/generate", {
    version: 1,
    observation: page,
    slots,
    signedIn: false,
    ...extra,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RecipeGenerationResult;
}

/** An SSO generation request for `labels` on `page`, and its answer. */
export async function generateSso(
  device: Device,
  page: LoginObservation,
  labels: string[],
  extra: Record<string, unknown> = {},
) {
  const response = await post(device, "/v1/recipes/generate", {
    version: 1,
    kind: "sso",
    observation: page,
    labels,
    ...extra,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SsoGenerationResult;
}

/** Stores `recipe` as the device wrote it, over `expectedRevision`. */
export async function seed(device: Device, recipe: StoredLoginRecipe, expectedRevision = 0) {
  const written = await writeRecipe(
    env.DB,
    device.ownerId,
    recipe.id,
    { version: 1, state: "active", expectedRevision, recipe },
    device.deviceId,
  );
  expect(written.ok).toBe(true);
}

/** The columns the assertions read by name; other columns are compared whole. */
type Row = Record<string, unknown> & Partial<Record<"request" | "result" | "branch", unknown>>;
export const rows = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .all<Row>()
    .then((result) => result.results);
export const day = () => new Date().toISOString().slice(0, 10);
