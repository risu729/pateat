import { describe, expect, it, vi } from "vitest";
import {
  OPENAI_DEVICE_MODEL_URL,
  MAX_DEVICE_MODEL_CALLS,
  MAX_DEVICE_MODEL_RESPONSE_BYTES,
  deviceModelRequestHash,
  type DeviceModel,
  type DeviceModelCall,
} from "@pateat/contracts";
import {
  callCostMicroUsd,
  createDeviceModel,
  currentSpend,
  parseDeviceModelSetting,
  type DeviceModelSpend,
} from "./device-model";
import type { ServiceTransport } from "./transport";

const key = "synthetic-openai-device-key";
const now = Date.UTC(2026, 10, 11);
const body = JSON.stringify({
  model: "gpt-6.1-sol",
  input: [
    { role: "developer", content: "Synthetic instructions" },
    { role: "user", content: [{ type: "input_text", text: "Synthetic page" }] },
  ],
  max_output_tokens: 1_024,
  store: false,
  service_tier: "default",
  reasoning: { effort: "low" },
  include: ["reasoning.encrypted_content"],
  text: {
    format: { type: "json_schema", name: "synthetic", strict: false, schema: { type: "object" } },
  },
});
const call: DeviceModelCall = {
  version: 1,
  status: "model-call",
  call: {
    index: 0,
    provider: "openai",
    headers: { "content-type": "application/json" },
    body,
  },
};
const usage = {
  input_tokens: 12_000,
  output_tokens: 100,
  input_tokens_details: {
    cached_tokens: 4_000,
    cache_write_tokens: 7_000,
    cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
  },
  output_tokens_details: { reasoning_tokens: 80 },
};
const answer = JSON.stringify({ usage });
const done = { version: 1, status: "unavailable", reason: "busy" } as const;
const routes = ["generateRecipe", "generateEntry", "generateLogout", "judgeCompletion"] as const;
type Route = (typeof routes)[number];
function setup(
  options: {
    calls?: unknown[];
    stored?: unknown;
    clef?: unknown;
    dailyUsd?: number;
    fetch?: typeof globalThis.fetch;
    spend?: DeviceModelSpend;
  } = {},
) {
  const replies = [...(options.calls ?? [call, done])];
  const requests: { route: Route; deviceModel: DeviceModel | undefined }[] = [];
  let spend: unknown = options.spend;
  const fetch = vi.fn<typeof globalThis.fetch>(options.fetch ?? (async () => new Response(answer)));
  const model = createDeviceModel({
    storage: {
      read: async () =>
        "stored" in options ? options.stored : { version: 1, provider: "openai", apiKey: key },
      write: async () => {},
      clear: async () => {},
    },
    spend: {
      read: async () => spend,
      write: async (value) => {
        spend = value;
      },
    },
    clef: { read: async () => options.clef },
    limits: async () => ({ dailyUsd: options.dailyUsd ?? 100, monthlyUsd: 1_000 }),
    fetch,
    now: () => now,
  });
  const service = Object.fromEntries(
    routes.map((route) => [
      route,
      async (...args: unknown[]) => {
        const request = args.at(-1) as { deviceModel?: DeviceModel };
        requests.push({ route, deviceModel: structuredClone(request.deviceModel) });
        const result = replies.shift() as { status?: string } | undefined;
        return {
          kind: "result",
          result:
            route === "judgeCompletion" && result?.status === "model-call"
              ? { ...result, judgement: { id: request.deviceModel!.judgement!.id, startedAt: now } }
              : result,
        };
      },
    ]),
  ) as unknown as Pick<ServiceTransport, Route>;
  const wrapped = model.wrap(service);
  const invoke = (route: Route = "generateRecipe") =>
    route === "judgeCompletion"
      ? wrapped.judgeCompletion(
          "https://service.example",
          "synthetic-device-token",
          "recipe",
          {} as never,
        )
      : wrapped[route]("https://service.example", "synthetic-device-token", {} as never);
  return { invoke, fetch, requests, spent: () => currentSpend(spend, now) };
}

describe("OpenAI calls relayed by a paired device", () => {
  it("rereads a replaced provider/key for the next request and preserves aggregate spend", async () => {
    const anthropic = {
      ...call,
      call: {
        index: 0,
        provider: "anthropic",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 1_024,
          messages: [{ role: "user", content: "Synthetic" }],
        }),
      },
    };
    const options = {
      stored: { version: 1, provider: "anthropic", apiKey: "synthetic-anthropic-key" },
      calls: [anthropic, done, call, done],
    };
    const { invoke, fetch, requests, spent } = setup(options);
    await invoke();
    expect(spent().dayMicroUsd).toBe(50_000);
    options.stored = { version: 1, provider: "openai", apiKey: key };
    await invoke();
    expect(requests.map((entry) => entry.deviceModel?.provider)).toEqual([
      "anthropic",
      "anthropic",
      "openai",
      "openai",
    ]);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe(
      "synthetic-anthropic-key",
    );
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${key}`,
    );
    expect(spent().dayMicroUsd).toBe(80_900);
  });
  it.each(routes)(
    "binds %s and its replay to the selected provider without sending the key to the service",
    async (route) => {
      const { invoke, fetch, requests, spent } = setup();
      expect(await invoke(route)).toEqual({ kind: "result", result: done });
      const judgement =
        route === "judgeCompletion" ? requests[0]!.deviceModel!.judgement : undefined;
      expect(requests).toEqual([
        {
          route,
          deviceModel: { provider: "openai", responses: [], ...(judgement ? { judgement } : {}) },
        },
        {
          route,
          deviceModel: {
            provider: "openai",
            ...(judgement ? { judgement: { ...judgement, startedAt: now } } : {}),
            responses: [
              {
                kind: "response",
                request: await deviceModelRequestHash(body),
                status: 200,
                body: answer,
              },
            ],
          },
        },
      ]);
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe(OPENAI_DEVICE_MODEL_URL);
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", body });
      const headers = new Headers(init?.headers);
      expect([...headers]).toEqual([
        ["authorization", `Bearer ${key}`],
        ["content-type", "application/json"],
      ]);
      expect(JSON.stringify(requests)).not.toContain(key);
      expect(spent()).toEqual({ dayMicroUsd: 30_900, monthMicroUsd: 30_900 });
    },
  );

  it("keeps OpenAI metadata and the server grant in a locally refused judge cancellation", async () => {
    const unsafe = {
      ...call,
      call: {
        ...call.call,
        body: JSON.stringify({ ...JSON.parse(body), tools: [{ type: "web_search" }] }),
      },
    };
    const { invoke, fetch, requests } = setup({ calls: [unsafe, done] });
    expect(await invoke("judgeCompletion")).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.deviceModel).toEqual({
      provider: "openai",
      responses: [],
      judgement: { id: expect.any(String) },
    });
    expect(requests[1]!.deviceModel).toEqual({
      provider: "openai",
      responses: [],
      judgement: { ...requests[0]!.deviceModel!.judgement, startedAt: now, cancel: true },
    });
  });

  it("preserves one server grant while relaying an OpenAI judge fallback", async () => {
    const second = {
      ...call,
      call: { ...call.call, index: 1, body: body.replace("gpt-6.1-sol", "gpt-6.1-terra") },
    };
    const { invoke, fetch, requests } = setup({ calls: [call, second, done] });
    expect(await invoke("judgeCompletion")).toEqual({ kind: "result", result: done });
    const judgement = { ...requests[0]!.deviceModel!.judgement, startedAt: now };
    expect(requests.slice(1).map((request) => request.deviceModel!.judgement)).toEqual([
      judgement,
      judgement,
    ]);
    expect(requests.map((request) => request.deviceModel!.provider)).toEqual([
      "openai",
      "openai",
      "openai",
    ]);
    expect(requests[2]!.deviceModel!.responses.map((response) => response.request)).toEqual([
      await deviceModelRequestHash(body),
      await deviceModelRequestHash(second.call.body),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      OPENAI_DEVICE_MODEL_URL,
      OPENAI_DEVICE_MODEL_URL,
    ]);
  });

  it.each(["anthropic", "cloudflare", undefined])(
    "rejects a mismatched %s call before using an OpenAI key",
    async (provider) => {
      const { invoke, fetch } = setup({ calls: [{ ...call, call: { ...call.call, provider } }] });
      expect(await invoke()).toEqual({ kind: "failed", error: "unexpected-response" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["tools", { tools: [{ type: "web_search" }] }],
    ["streaming", { stream: true }],
    ["storage", { store: true }],
    ["conversation", { previous_response_id: "resp_other" }],
    ["an endpoint", { base_url: "https://attacker.example/v1" }],
    ["too many output tokens", { max_output_tokens: 1_025 }],
    ["an unpriced model", { model: "gpt-unknown" }],
    [
      "remote input",
      {
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "https://attacker.example/image" }],
          },
        ],
      },
    ],
    ["assistant history", { input: [{ role: "assistant", content: "Synthetic" }] }],
    ["a reasoning summary", { reasoning: { effort: "low", summary: "auto" } }],
  ])("refuses service requests for %s", async (_, extra) => {
    const { invoke, fetch } = setup({
      calls: [
        {
          ...call,
          call: { ...call.call, body: JSON.stringify({ ...JSON.parse(body), ...extra }) },
        },
      ],
    });
    expect(await invoke()).toEqual({ kind: "failed", error: "unexpected-response" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { authorization: "Bearer service-secret" },
    { "anthropic-version": "2023-06-01" },
    { "content-type": "text/plain" },
  ])("refuses unapproved service headers %#", async (headers) => {
    const { invoke, fetch } = setup({ calls: [{ ...call, call: { ...call.call, headers } }] });
    expect(await invoke()).toEqual({ kind: "failed", error: "unexpected-response" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never uses an outbound URL supplied alongside an otherwise permitted call", async () => {
    const { invoke, fetch } = setup({
      calls: [{ ...call, call: { ...call.call, url: "https://attacker.example/collect" } }, done],
    });
    await invoke();
    expect(fetch.mock.calls[0]?.[0]).toBe(OPENAI_DEVICE_MODEL_URL);
  });

  it("rewrites duplicate JSON keys to the checked body but hashes the original for replay", async () => {
    const duplicate = body.replace(
      '"max_output_tokens":1024',
      '"max_output_tokens":64000,"max_output_tokens":1024',
    );
    const { invoke, fetch, requests } = setup({
      calls: [{ ...call, call: { ...call.call, body: duplicate } }, done],
    });
    await invoke();
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(body);
    expect(requests[1]?.deviceModel?.responses[0]?.request).toBe(
      await deviceModelRequestHash(duplicate),
    );
  });

  it("replaces responses from the replay index instead of retaining stale later replies", async () => {
    const next = {
      ...call,
      call: { ...call.call, body: body.replace("Synthetic page", "Changed page") },
    };
    const { invoke, requests, fetch } = setup({ calls: [call, next, done] });
    await invoke();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests[2]?.deviceModel?.responses).toEqual([
      {
        kind: "response",
        status: 200,
        body: answer,
        request: await deviceModelRequestHash(next.call.body),
      },
    ]);
  });

  it("bounds repeated calls and refuses replay indexes beyond the available responses", async () => {
    const loop = setup({
      calls: Array.from({ length: 2 * MAX_DEVICE_MODEL_CALLS + 1 }, () => call),
    });
    expect(await loop.invoke()).toEqual({ kind: "failed", error: "unexpected-response" });
    expect(loop.fetch).toHaveBeenCalledTimes(2 * MAX_DEVICE_MODEL_CALLS);
    const skipped = setup({ calls: [{ ...call, call: { ...call.call, index: 1 } }] });
    expect(await skipped.invoke()).toEqual({ kind: "failed", error: "unexpected-response" });
    expect(skipped.fetch).not.toHaveBeenCalled();
  });

  it("counts oversized replies before withholding them from the service", async () => {
    const { invoke, requests, spent } = setup({
      fetch: async () =>
        Response.json({ usage, padding: "x".repeat(MAX_DEVICE_MODEL_RESPONSE_BYTES) }),
    });
    await invoke();
    expect(requests[1]?.deviceModel?.responses[0]?.kind).toBe("unreachable");
    expect(spent().dayMicroUsd).toBe(30_900);
  });

  it("preserves the shared spend stop when an OpenAI provider is selected", async () => {
    const { invoke, fetch } = setup({
      dailyUsd: 1,
      spend: {
        version: 1,
        day: "2026-11-11",
        dayMicroUsd: 1_000_000,
        month: "2026-11",
        monthMicroUsd: 1_000_000,
      },
    });
    expect(await invoke()).toEqual({
      kind: "result",
      result: { version: 1, status: "unavailable", reason: "daily-limit" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps Clef independently authorized and uses its own token before OpenAI", async () => {
    const clef = {
      version: 1,
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "synthetic-clef-token",
    };
    const clefBody = JSON.stringify({
      model: "clef",
      state: { page: "Synthetic" },
      questions: { signin: { type: "noul", instructions: "Sign in?" } },
    });
    const clefCall = {
      ...call,
      call: {
        index: 0,
        provider: "cloudflare",
        headers: { "content-type": "application/json" },
        body: clefBody,
      },
    };
    const { invoke, fetch, requests } = setup({
      clef,
      calls: [clefCall, { ...call, call: { ...call.call, index: 1 } }, done],
    });
    await invoke();
    expect(requests[0]?.deviceModel).toEqual({ provider: "openai", responses: [], clef: true });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef",
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer synthetic-clef-token",
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(OPENAI_DEVICE_MODEL_URL);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${key}`,
    );
    expect(JSON.stringify(requests)).not.toContain(clef.apiToken);
    expect(JSON.stringify(requests)).not.toContain(key);
  });
});

describe("provider-tagged local key and cost boundaries", () => {
  it("requires an explicit supported provider, with no credential reinterpretation", () => {
    expect(parseDeviceModelSetting({ version: 1, provider: "openai", apiKey: ` ${key} ` })).toEqual(
      { version: 1, provider: "openai", apiKey: key },
    );
    for (const provider of [undefined, "proxy", "cloudflare"])
      expect(parseDeviceModelSetting({ version: 1, provider, apiKey: key })).toBeUndefined();
  });
  it("prices reported cache writes and unknown details conservatively", () => {
    expect(
      callCostMicroUsd(
        body,
        { kind: "response", request: "", status: 200, body: answer },
        "openai",
      ),
    ).toBe(30_900);
    expect(
      callCostMicroUsd(
        body,
        {
          kind: "response",
          request: "",
          status: 200,
          body: JSON.stringify({ usage: { input_tokens: 12_000, output_tokens: 100 } }),
        },
        "openai",
      ),
    ).toBe(61_000);
    expect(callCostMicroUsd(body, { kind: "unreachable", request: "" }, "openai")).toBe(0);
    expect(callCostMicroUsd(body, { kind: "timeout", request: "" }, "openai")).toBeGreaterThan(0);
  });
});
