import {
  DEFAULT_MODEL_CONFIG,
  devicePairResultSchema,
  manageModelsSchema,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveWifCredential } from "../src/claude/credentials";
import { roleChoices } from "../src/claude/models";
import {
  deviceApi,
  installAccessKeys,
  ORIGIN,
  owner,
  ownerIdFor,
  request,
  type Owner,
} from "./access-helpers";

installAccessKeys();

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MODELS_URL = "https://api.anthropic.com/v1/models";
/** The synthetic extension ID listed in vitest.config.ts. */
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const efforts = (levels: string[]) => ({
  supported: levels.length > 0,
  ...Object.fromEntries(levels.map((level) => [level, { supported: true }])),
});
const apiModel = (id: string, line: string, createdAt: string, levels = ["low", "medium"]) => ({
  type: "model",
  id,
  display_name: id,
  created_at: createdAt,
  line,
  capabilities: { effort: efforts(levels), structured_outputs: { supported: true } },
});
/** The Models API's answer, or an HTTP error status. */
let listed: unknown[] | number = [];
let modelRequests: Request[] = [];

beforeAll(() => {
  // After installAccessKeys' own mock, which serves the Access key set.
  const accessFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const outbound = new Request(input, init);
    if (outbound.url === TOKEN_URL)
      return Response.json({
        access_token: "synthetic-token",
        token_type: "Bearer",
        expires_in: 600,
      });
    if (outbound.url.startsWith(MODELS_URL)) {
      modelRequests.push(outbound);
      if (typeof listed === "number") return Response.json({ type: "error" }, { status: listed });
      // One model per page, so every listing reads several pages.
      const after = new URL(outbound.url).searchParams.get("after_id");
      const start =
        after === null
          ? 0
          : listed.findIndex((model) => (model as { id: string }).id === after) + 1;
      const page = listed.slice(start, start + 1) as { id: string }[];
      return Response.json({
        data: page,
        has_more: start + 1 < listed.length,
        first_id: page[0]?.id ?? null,
        last_id: page[0]?.id ?? null,
      });
    }
    return accessFetch(input, init);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  listed = [
    apiModel("claude-opus-5-5", "opus", "2026-09-21T16:24:00Z", ["low", "medium", "high"]),
    apiModel("claude-opus-4-8", "opus", "2026-05-28T00:00:00Z"),
    apiModel("claude-sonnet-5-5", "sonnet", "2026-09-28T00:00:00Z"),
    apiModel("claude-haiku-5-5", "haiku", "2026-10-07T18:00:00Z"),
  ];
  modelRequests = [];
});

/** An owner with a paired device and, unless `claude` is false, Claude credentials. */
async function pairedOwner({ claude = true } = {}) {
  const by = await owner();
  const response = await request("/pair", {
    method: "POST",
    access: by.token,
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ version: 1, label: "Test laptop" }),
  });
  expect(response.status).toBe(201);
  const device = v.parse(devicePairResultSchema, await response.json());
  const ownerId = (await ownerIdFor(by.subject))!;
  if (claude)
    await saveWifCredential(env.DB, ownerId, {
      federationRuleId: "fdrl_01SyntheticRule",
      organizationId: "00000000-0000-4000-8000-000000000000",
      serviceAccountId: "svac_01SyntheticAccount",
      workspaceId: "wrkspc_01SyntheticWorkspace",
    });
  return { ...by, ownerId, device };
}

const read = async (by: Owner) => {
  const response = await request("/manage/api/models", { access: by.token });
  expect(response.status).toBe(200);
  return v.parse(manageModelsSchema, await response.json());
};
const put = (by: Owner, config: unknown) =>
  request("/manage/api/models", {
    method: "PUT",
    access: by.token,
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ version: 1, config }),
  });
const choice = (model: string, effort = "low", speed = "standard") => ({
  provider: "anthropic",
  model,
  effort,
  speed,
});

describe("owner model configuration", () => {
  it("tells an identity without a paired device to pair one", async () => {
    const by = await owner();
    const response = await request("/manage/api/models", { access: by.token });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_paired" });
  });

  it("offers the newest model of each line from the Models API, with the owner's token", async () => {
    const by = await pairedOwner();
    const view = await read(by);
    expect(view).toMatchObject({
      saved: false,
      catalog: "models-api",
      config: DEFAULT_MODEL_CONFIG,
    });
    expect(view.models.map((model) => model.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(view.models[0]).toEqual({
      provider: "anthropic",
      id: "claude-opus-5-5",
      displayName: "claude-opus-5-5",
      efforts: ["low", "medium", "high"],
      rates: { input: 4, output: 20 },
      fast: "available",
      fastRates: { input: 8, output: 40 },
    });
    expect(modelRequests[0]?.headers.get("authorization")).toBe("Bearer synthetic-token");
    // Four models, one page each, each page after the previous one's last model.
    expect(modelRequests.map((entry) => new URL(entry.url).searchParams.get("after_id"))).toEqual([
      null,
      "claude-opus-5-5",
      "claude-opus-4-8",
      "claude-sonnet-5-5",
    ]);
  });

  it("shows a new model without a price as unavailable, beside its line's newest priced one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listed = [
      apiModel("claude-opus-9", "opus", "2027-01-01T00:00:00Z"),
      apiModel("claude-opus-5-5", "opus", "2026-09-21T16:24:00Z"),
    ];
    const by = await pairedOwner();
    const view = await read(by);
    expect(view.models.map((model) => [model.id, model.rates])).toEqual([
      ["claude-opus-9", null],
      ["claude-opus-5-5", { input: 4, output: 20 }],
      // Configured, so listed though the API no longer names it: nothing to choose.
      ["claude-sonnet-5-5", { input: 2, output: 10 }],
    ]);
    expect(view.models[2]?.efforts).toEqual([]);
    expect(warn).toHaveBeenCalledWith("Claude model has no price", { model: "claude-opus-9" });
    warn.mockRestore();
  });

  it("lists the pricing page's models when the Models API cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listed = 403;
    const by = await pairedOwner();
    const view = await read(by);
    expect(view.catalog).toBe("pricing");
    expect(view.models.map((model) => model.id)).toContain("claude-opus-5-5");
    // Only the newest of each line: no Opus 5 or Opus 4.8.
    expect(view.models.map((model) => model.id)).not.toContain("claude-opus-4-8");
    warn.mockRestore();
  });

  it("saves an offered configuration and refuses one the list does not offer", async () => {
    const by = await pairedOwner();
    const config = {
      generate: [choice("claude-opus-5-5", "medium", "fast"), choice("claude-haiku-5-5")],
      judge: [choice("claude-sonnet-5-5")],
    };
    const saved = await put(by, config);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ saved: true, config });
    expect(await read(by)).toMatchObject({ saved: true, config });

    for (const refused of [
      // Sonnet 5.5 has no fast mode.
      { ...config, judge: [choice("claude-sonnet-5-5", "low", "fast")] },
      // Haiku 5.5 is listed without high effort.
      { ...config, judge: [choice("claude-haiku-5-5", "high")] },
      // Not the newest of its line, nor configured.
      { ...config, judge: [choice("claude-opus-4-8")] },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each write reads the list again.
      const response = await put(by, refused);
      expect(response.status).toBe(400);
      // oxlint-disable-next-line no-await-in-loop
      expect(await response.json()).toEqual({ error: "model_unavailable" });
    }
    // The same model twice in a role is not a configuration.
    expect(
      (await put(by, { ...config, judge: [choice("claude-opus-5-5"), choice("claude-opus-5-5")] }))
        .status,
    ).toBe(400);
    expect(await read(by)).toMatchObject({ config });
  });

  it("marks fast mode unavailable once the owner's last fast calls of a model failed", async () => {
    const by = await pairedOwner();
    const now = Date.now();
    await env.DB.batch(
      ["rate-limited", "timeout", "rate-limited"].map((outcome, index) =>
        env.DB.prepare(
          "INSERT INTO inference_log (id, owner_id, role, provider, model_id, speed, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'claude-opus-5-5', 'fast', 'https://a.test', '/', '{}', ?, 0, ?)",
        ).bind(crypto.randomUUID(), by.ownerId, outcome, now - index * 1000),
      ),
    );
    const view = await read(by);
    expect(view.models.find((model) => model.id === "claude-opus-5-5")?.fast).toBe("failing");
    const response = await put(by, {
      generate: [choice("claude-opus-5-5", "low", "fast")],
      judge: [choice("claude-opus-5-5")],
    });
    expect(response.status).toBe(400);
  });

  it("cannot be read or written with a device token", async () => {
    const by = await pairedOwner();
    const [get, write] = await Promise.all([
      deviceApi(by.device.credential, "/manage/api/models"),
      deviceApi(by.device.credential, "/manage/api/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ version: 1, config: DEFAULT_MODEL_CONFIG }),
      }),
    ]);
    expect([get.status, write.status]).toEqual([401, 401]);
  });
});

describe("roleChoices", () => {
  it("skips a choice the pricing page does not price and keeps the order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const choices = roleChoices(
      {
        generate: [
          choice("claude-opus-9") as never,
          choice("claude-sonnet-5-5", "medium", "standard") as never,
        ],
        judge: DEFAULT_MODEL_CONFIG.judge,
      },
      "generate",
    );
    expect(choices).toEqual([
      {
        modelId: "claude-sonnet-5-5",
        effort: "medium",
        rates: { input: 2, output: 10 },
        speed: "standard",
      },
    ]);
    expect(warn).toHaveBeenCalledWith("Configured Claude model has no price", {
      role: "generate",
      model: "claude-opus-9",
      speed: "standard",
    });
    warn.mockRestore();
  });

  it("asks the defaults when no configured choice is priced", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const choices = roleChoices(
      { generate: [choice("claude-opus-9") as never], judge: DEFAULT_MODEL_CONFIG.judge },
      "generate",
    );
    expect(choices.map((entry) => entry.modelId)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    warn.mockRestore();
  });
});
