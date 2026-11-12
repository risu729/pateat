import {
  DEVICE_MODEL_URL,
  MAX_DEVICE_MODEL_CALLS,
  deviceModelRequestHash,
  type DeviceModel,
  type DeviceModelCall,
  type LogoutGenerationRequest,
  type LogoutGenerationResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  callCostMicroUsd,
  clefCallCostMicroUsd,
  createDeviceModel,
  currentSpend,
  parseDeviceClefSetting,
  parseSpendLimits,
  type DeviceModelSetting,
  type DeviceModelSpend,
} from "./device-model";
import type { InferenceResult, ServiceTransport } from "./transport";

// A synthetic key, service and Anthropic; nothing leaves the test.

const KEY = "sk-ant-synthetic-0000-abcd";
const ORIGIN = "https://pateat.example.com";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;
const NOW = Date.UTC(2026, 9, 23, 20, 0);
const SETTING: DeviceModelSetting = {
  version: 1,
  provider: "anthropic",
  apiKey: KEY,
};
const REQUEST = {
  version: 1,
  observation: {
    version: 1,
    origin: "https://shop.example.test",
    path: "/login",
    language: "en",
    complete: true,
    candidates: [],
  },
  slots: [{ id: "password", kind: "secret", description: "account password" }],
  signedIn: false,
} as unknown as RecipeGenerationRequest;
const BODY = JSON.stringify({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  system: "Synthetic instructions.",
  messages: [{ role: "user", content: [{ type: "text", text: "A synthetic page." }] }],
});
const CALL: DeviceModelCall = {
  version: 1,
  status: "model-call",
  call: {
    provider: "anthropic",
    index: 0,
    headers: { "anthropic-version": "2023-06-01" },
    body: BODY,
  },
};
const RECIPE = { version: 1, status: "abstained", reason: "no-login-form" } as const;
const ANSWER = JSON.stringify({ usage: { input_tokens: 1_000_000, output_tokens: 0 } });

function setup(
  options: {
    setting?: DeviceModelSetting | undefined;
    spend?: DeviceModelSpend;
    readSpend?: () => Promise<unknown>;
    writeSpend?: (value: DeviceModelSpend) => Promise<void>;
    readKey?: () => Promise<unknown>;
    clef?: unknown;
    limits?: { dailyUsd: number; monthlyUsd: number } | (() => Promise<never>);
    answers?: RecipeGenerationResult[];
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  let spend: unknown = options.spend;
  const answers = [...(options.answers ?? [CALL as RecipeGenerationResult, RECIPE])];
  const sent: (DeviceModel | undefined)[] = [];
  const generateRecipe = vi.fn(
    async (
      _origin: string,
      _credential: string,
      request: RecipeGenerationRequest,
    ): Promise<InferenceResult<RecipeGenerationResult>> => {
      sent.push(request.deviceModel);
      return { kind: "result", result: answers.shift()! };
    },
  );
  const fetch = vi.fn(
    options.fetch ?? (async () => new Response(ANSWER, { status: 200 })),
  ) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
  const model = createDeviceModel({
    limits:
      typeof options.limits === "function"
        ? options.limits
        : async () =>
            (options.limits as { dailyUsd: number; monthlyUsd: number } | undefined) ?? {
              dailyUsd: 5,
              monthlyUsd: 100,
            },
    storage: {
      read: options.readKey ?? (async () => ("setting" in options ? options.setting : SETTING)),
      write: async () => {},
      clear: async () => {},
    },
    clef: { read: async () => options.clef },
    spend: {
      read: options.readSpend ?? (async () => spend),
      write:
        options.writeSpend ??
        (async (value) => {
          spend = value;
        }),
    },
    fetch,
    now: () => NOW,
  });
  const transport = model.wrap({
    generateRecipe,
    generateEntry: vi.fn(),
    generateLogout: vi.fn(),
    judgeCompletion: vi.fn(),
  } as unknown as Pick<
    ServiceTransport,
    "generateRecipe" | "generateEntry" | "generateLogout" | "judgeCompletion"
  >);
  return { transport, sent, fetch, spend: () => spend };
}

describe("model calls with this device's own key (ADR 0040)", () => {
  it("sends requests as they are without a saved key", async () => {
    const { transport, sent, fetch } = setup({ setting: undefined, answers: [RECIPE] });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "result",
      result: RECIPE,
    });
    expect(sent).toEqual([undefined]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes the service's model call with the key and sends the request again with it", async () => {
    const { transport, sent, fetch, spend } = setup();
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "result",
      result: RECIPE,
    });
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(DEVICE_MODEL_URL);
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(init.body).toBe(BODY);
    expect(init.credentials).toBe("omit");
    expect(sent).toEqual([
      { provider: "anthropic", responses: [] },
      {
        provider: "anthropic",
        responses: [
          {
            kind: "response",
            request: await deviceModelRequestHash(BODY),
            status: 200,
            body: ANSWER,
          },
        ],
      },
    ]);
    // A million input tokens at Opus 5.5's published input rate.
    expect(currentSpend(spend(), NOW).dayMicroUsd).toBe(
      callCostMicroUsd(BODY, {
        kind: "response",
        request: "",
        status: 200,
        body: ANSWER,
      }),
    );
    expect(currentSpend(spend(), NOW).dayMicroUsd).toBeGreaterThan(0);
  });

  it("makes an account switch's logout call with the key too (ADR 0063)", async () => {
    const request = {
      version: 1,
      observation: { ...REQUEST.observation, path: "/home" },
    } as LogoutGenerationRequest;
    const signedOut = { version: 1, status: "signed-out" } as const;
    const answers: LogoutGenerationResult[] = [CALL, signedOut];
    const sent: (DeviceModel | undefined)[] = [];
    const fetch = vi.fn(async () => new Response(ANSWER, { status: 200 }));
    const model = createDeviceModel({
      limits: async () => ({ dailyUsd: 5, monthlyUsd: 100 }),
      storage: { read: async () => SETTING, write: async () => {}, clear: async () => {} },
      spend: { read: async () => undefined, write: async () => {} },
      fetch,
      now: () => NOW,
    });
    const transport = model.wrap({
      generateRecipe: vi.fn(),
      generateEntry: vi.fn(),
      judgeCompletion: vi.fn(),
      generateLogout: async (_origin, _credential, body) => {
        sent.push(body.deviceModel);
        return { kind: "result", result: answers.shift()! };
      },
    });
    expect(await transport.generateLogout(ORIGIN, CREDENTIAL, request)).toEqual({
      kind: "result",
      result: signedOut,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      { provider: "anthropic", responses: [] },
      {
        provider: "anthropic",
        responses: [
          {
            kind: "response",
            request: await deviceModelRequestHash(BODY),
            status: 200,
            body: ANSWER,
          },
        ],
      },
    ]);
  });

  it("never sends the key to the service", async () => {
    const { transport, sent } = setup();
    await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST);
    expect(JSON.stringify(sent)).not.toContain(KEY);
  });

  it("stops at the daily limit before the call, as the service's own stop answers", async () => {
    const { transport, fetch } = setup({
      spend: {
        version: 1,
        day: "2026-10-23",
        dayMicroUsd: 5_000_000,
        month: "2026-10",
        monthMicroUsd: 5_000_000,
      },
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "result",
      result: { version: 1, status: "unavailable", reason: "daily-limit" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts each UTC day and month at nothing spent", () => {
    expect(
      currentSpend(
        { version: 1, day: "2026-10-22", dayMicroUsd: 9, month: "2026-09", monthMicroUsd: 9 },
        NOW,
      ),
    ).toEqual({ dayMicroUsd: 0, monthMicroUsd: 0 });
  });

  it("reports a call that took too long as a timeout", async () => {
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { transport, sent } = setup({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          started();
        }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST);
      await sending;
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(sent[1]?.responses[0]?.kind).toBe("timeout");
  });

  it("stops a service that keeps asking for calls", async () => {
    const { transport, fetch } = setup({
      answers: Array.from({ length: 30 }, () => CALL as RecipeGenerationResult),
      fetch: async () =>
        new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 10 } })),
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    // Twice the most calls a request makes.
    expect(fetch).toHaveBeenCalledTimes(2 * MAX_DEVICE_MODEL_CALLS);
  });

  it("refuses a call that skips ahead of the responses it was given", async () => {
    const { transport, fetch } = setup({
      answers: [{ ...CALL, call: { ...CALL.call, index: 1 } } as RecipeGenerationResult],
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a tool", { tools: [{ type: "web_search_20250305", name: "web_search" }] }],
    ["streaming", { stream: true }],
    ["a larger answer", { max_tokens: 64_000 }],
    ["another server", { mcp_servers: [{ type: "url", url: "https://mcp.example.test" }] }],
  ])("never sends a call that asks for %s", async (_name, extra) => {
    const body = JSON.stringify({ ...JSON.parse(BODY), ...extra });
    const { transport, fetch } = setup({
      answers: [{ ...CALL, call: { ...CALL.call, body } } as RecipeGenerationResult],
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends a call with a beta other than fast mode's", async () => {
    const { transport, fetch } = setup({
      answers: [
        {
          ...CALL,
          call: { ...CALL.call, headers: { "anthropic-beta": "mcp-client-2025-04-04" } },
        } as RecipeGenerationResult,
      ],
    });
    expect((await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).kind).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("charges an answer too large to pass on, and passes it on as none", async () => {
    const large = JSON.stringify({
      usage: { input_tokens: 1_000, output_tokens: 10 },
      padding: "x".repeat(20 * 1024),
    });
    const { transport, sent, spend } = setup({ fetch: async () => new Response(large) });
    await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST);
    expect(sent[1]?.responses[0]?.kind).toBe("unreachable");
    expect(currentSpend(spend(), NOW).dayMicroUsd).toBeGreaterThan(0);
  });

  it("stops when the spend count cannot be read, rather than counting nothing", async () => {
    const { transport, fetch } = setup({
      readSpend: () => Promise.reject(new Error("storage unavailable")),
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never falls back to the service's credential when the key cannot be read", async () => {
    const { transport, sent } = setup({
      readKey: () => Promise.reject(new Error("storage unavailable")),
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    expect(sent).toEqual([]);
  });

  it("keeps counting what it could not write, and stops at the limit", async () => {
    const { transport, fetch } = setup({
      answers: [CALL as RecipeGenerationResult, CALL as RecipeGenerationResult],
      limits: { dailyUsd: 1, monthlyUsd: 100 },
      writeSpend: () => Promise.reject(new Error("quota")),
    });
    // A million input tokens is past a $1 daily limit at Opus 5.5's rates.
    expect((await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).kind).toBe("failed");
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "result",
      result: { version: 1, status: "unavailable", reason: "daily-limit" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("charges the worst case when the answer's body could not be read", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
    );
    const { transport, sent, spend } = setup({ fetch: async () => broken });
    await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST);
    expect(sent[1]?.responses[0]?.kind).toBe("unreachable");
    expect(currentSpend(spend(), NOW).dayMicroUsd).toBe(
      callCostMicroUsd(BODY, { kind: "timeout", request: "" }),
    );
  });

  it("reads the profile's stored limits: the defaults when absent, none when damaged", () => {
    expect(parseSpendLimits(undefined)).toEqual({ dailyUsd: 5, monthlyUsd: 100 });
    expect(parseSpendLimits({ dailyUsd: 0, monthlyUsd: 3 })).toEqual({
      dailyUsd: 0,
      monthlyUsd: 3,
    });
    for (const damaged of [null, "5", { dailyUsd: 1 }, { dailyUsd: -1, monthlyUsd: 1 }])
      expect(() => parseSpendLimits(damaged)).toThrow();
  });

  it("stops when the profile's spend limits cannot be read", async () => {
    const { transport, fetch } = setup({
      limits: () => Promise.reject(new Error("settings unavailable")),
    });
    expect((await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).kind).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses unexpected stored key fields instead of falling back to the service", async () => {
    const { transport, fetch } = setup({
      readKey: async () => ({ ...SETTING, dailyLimitUsd: 0, monthlyLimitUsd: 0 }),
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops when the spend count reads as something else", async () => {
    const { transport, fetch } = setup({ readSpend: async () => ({ version: 2 }) });
    expect((await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).kind).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails rather than using the service's credential for a key record it cannot read", async () => {
    const { transport, sent } = setup({ readKey: async () => ({ version: 2, apiKey: KEY }) });
    expect((await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).kind).toBe("failed");
    expect(sent).toEqual([]);
  });

  it("sends the body as checked when a key is given twice", async () => {
    const body = BODY.replace('"max_tokens":1024', '"max_tokens":64000,"max_tokens":1024');
    const { transport, fetch, sent } = setup({
      answers: [{ ...CALL, call: { ...CALL.call, body } } as RecipeGenerationResult, RECIPE],
    });
    await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST);
    const [, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(init.body).toBe(BODY);
    // The service still recognizes the response by the body it built.
    expect(sent[1]?.responses[0]?.request).toBe(await deviceModelRequestHash(body));
  });

  it("charges the worst case for a call without reported usage, and nothing when it never left", () => {
    const worst = callCostMicroUsd(BODY, { kind: "timeout", request: "" });
    expect(worst).toBeGreaterThan(0);
    expect(callCostMicroUsd(BODY, { kind: "unreachable", request: "" })).toBe(0);
    expect(
      callCostMicroUsd(BODY, { kind: "response", request: "", status: 529, body: "overloaded" }),
    ).toBe(0);
  });
});

describe("Clef calls with this device's Cloudflare token (ADR 0083)", () => {
  const usage = (tokens: unknown) =>
    JSON.stringify({ success: true, result: { usage: { input_tokens: tokens } } });

  it("charges the input tokens Workers AI reports at Clef's rate, and the worst case without them", () => {
    expect(clefCallCostMicroUsd({ kind: "response", status: 200, body: usage(1_000) })).toBe(240);
    // Clef's whole context of 65,536 tokens at $0.24 per million.
    const worst = 15_729;
    expect(clefCallCostMicroUsd({ kind: "timeout" })).toBe(worst);
    expect(clefCallCostMicroUsd({ kind: "response", status: 200, body: "{}" })).toBe(worst);
    expect(clefCallCostMicroUsd({ kind: "response", status: 200, body: usage(-1) })).toBe(worst);
    // Refused before an answer, or never reached.
    expect(clefCallCostMicroUsd({ kind: "response", status: 403, body: "{}" })).toBe(0);
    expect(clefCallCostMicroUsd({ kind: "unreachable" })).toBe(0);
  });

  it("reads an account and token as pasted, and nothing else", () => {
    const accountId = "0123456789ABCDEF0123456789abcdef";
    expect(
      parseDeviceClefSetting({ version: 1, accountId: ` ${accountId} `, apiToken: "t".repeat(40) }),
    ).toEqual({ version: 1, accountId: accountId.toLowerCase(), apiToken: "t".repeat(40) });
    expect(parseDeviceClefSetting({ version: 1, accountId: "x", apiToken: "t".repeat(40) })).toBe(
      undefined,
    );
    expect(parseDeviceClefSetting(undefined)).toBe(undefined);
  });

  it("sends the token to the account's Clef URL only, and reads none without a record", async () => {
    const fetch = vi.fn(async () => Response.json({ success: true, result: {} }));
    const setting = {
      version: 1 as const,
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "synthetic-cloudflare-token",
    };
    const model = createDeviceModel({
      storage: { read: async () => undefined, write: async () => {}, clear: async () => {} },
      spend: { read: async () => undefined, write: async () => {} },
      limits: async () => ({ dailyUsd: 5, monthlyUsd: 100 }),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await model.direct.clefSetting()).toBe(undefined);
    const { response } = await model.direct.sendClef(setting, "{}");
    expect(response).toMatchObject({ kind: "response", status: 200 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef",
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer synthetic-cloudflare-token",
    );
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
  });
});

describe("Clef calls a paired service hands this device (ADR 0083)", () => {
  const clef = {
    version: 1,
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "synthetic-cloudflare-token",
  } as const;
  const clefBody = JSON.stringify({
    model: "clef",
    state: { page: "A synthetic page." },
    questions: { signin: { type: "noul", instructions: "Does this page sign in?" } },
  });
  const clefCall: DeviceModelCall = {
    version: 1,
    status: "model-call",
    call: {
      index: 0,
      provider: "cloudflare",
      headers: { "content-type": "application/json" },
      body: clefBody,
    },
  };
  const clefAnswer = JSON.stringify({
    success: true,
    result: { model: "clef", answers: {}, usage: { input_tokens: 1_000 } },
  });

  it("says it holds a token, sends Clef's call to its account with it, and charges it", async () => {
    const { transport, sent, fetch, spend } = setup({
      clef,
      answers: [clefCall as RecipeGenerationResult, RECIPE],
      fetch: async () => new Response(clefAnswer, { status: 200 }),
    });
    await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST);
    expect(sent[0]).toEqual({ provider: "anthropic", responses: [], clef: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-cloudflare-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(sent[1]).toEqual({
      provider: "anthropic",
      responses: [
        {
          kind: "response",
          request: await deviceModelRequestHash(clefBody),
          status: 200,
          body: clefAnswer,
        },
      ],
      clef: true,
    });
    // 1,000 input tokens at $0.24 per million.
    expect((spend() as DeviceModelSpend).dayMicroUsd).toBe(240);
  });

  it("sends no Clef call without a token, nor one that asks Clef for more than its questions", async () => {
    for (const [stored, call] of [
      [undefined, clefCall],
      [
        clef,
        {
          ...clefCall,
          call: {
            ...clefCall.call,
            body: JSON.stringify({ ...JSON.parse(clefBody), model: "clef-omni" }),
          },
        },
      ],
      [clef, { ...clefCall, call: { ...clefCall.call, provider: undefined } }],
    ] as const) {
      const { transport, sent, fetch } = setup({
        clef: stored,
        answers: [call as RecipeGenerationResult, RECIPE],
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toMatchObject({
        kind: "failed",
        error: "unexpected-response",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
    }
  });
});

describe("paired judge client identity", () => {
  const request: RecipeCompletionRequest = {
    version: 1,
    revision: 1,
    route: "password",
    branch: "1000",
    observation: REQUEST.observation,
    slots: [],
  };
  function judgeRelay(answers: RecipeCompletionResult[], spend?: DeviceModelSpend, clockSkew = 0) {
    const requests: RecipeCompletionRequest[] = [];
    let stored: unknown = spend;
    const fetch = vi.fn(async () =>
      Response.json({ usage: { input_tokens: 100, output_tokens: 10 } }),
    );
    const model = createDeviceModel({
      storage: { read: async () => SETTING, write: async () => {}, clear: async () => {} },
      spend: {
        read: async () => stored,
        write: async (value) => {
          stored = value;
        },
      },
      limits: async () => ({ dailyUsd: 5, monthlyUsd: 100 }),
      fetch,
      now: () => NOW + clockSkew,
    });
    const transport = model.wrap({
      generateRecipe: vi.fn(),
      generateEntry: vi.fn(),
      generateLogout: vi.fn(),
      judgeCompletion: vi.fn(
        async (
          _origin: string,
          _credential: string,
          _recipeId: string,
          value: RecipeCompletionRequest,
        ) => {
          requests.push(structuredClone(value));
          const result = answers.shift()!;
          return {
            kind: "result",
            result:
              result.status === "model-call"
                ? { ...result, judgement: { id: value.deviceModel!.judgement!.id, startedAt: NOW } }
                : result,
          };
        },
      ),
    } as unknown as Pick<
      ServiceTransport,
      "generateRecipe" | "generateEntry" | "generateLogout" | "judgeCompletion"
    >);
    return { transport, requests, fetch };
  }

  it.each([-3_600_000, 3_600_000])(
    "uses the server grant with a client clock skew of %i ms",
    async (clockSkew) => {
      const optional = { version: 1, status: "optional" } as const;
      const { transport, requests, fetch } = judgeRelay(
        [CALL, optional, CALL, optional],
        undefined,
        clockSkew,
      );
      expect(
        await transport.judgeCompletion(ORIGIN, CREDENTIAL, "gen_synthetic", request),
      ).toMatchObject({ kind: "result", result: optional });
      expect(
        await transport.judgeCompletion(ORIGIN, CREDENTIAL, "gen_synthetic", request),
      ).toMatchObject({ kind: "result", result: optional });
      const first = requests[0]!.deviceModel!.judgement;
      expect(first).toEqual({ id: expect.any(String) });
      expect(requests[1]!.deviceModel!.judgement).toEqual({ ...first, startedAt: NOW });
      expect(requests[1]!.deviceModel!.responses).toHaveLength(1);
      expect(requests[2]!.deviceModel!.judgement!.id).not.toBe(first!.id);
      expect(requests[3]!.deviceModel!.judgement).toEqual({
        ...requests[2]!.deviceModel!.judgement,
        startedAt: NOW,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("sends a matching no-send cancellation when the service returns an unsafe call", async () => {
    const unsafe: RecipeCompletionResult = {
      ...CALL,
      call: { ...CALL.call, body: JSON.stringify({ ...JSON.parse(BODY), tools: [] }) },
    };
    const { transport, requests, fetch } = judgeRelay([
      unsafe,
      { version: 1, status: "unavailable", reason: "judgement-unanswered" },
    ]);
    expect(
      await transport.judgeCompletion(ORIGIN, CREDENTIAL, "gen_synthetic", request),
    ).toMatchObject({ kind: "failed", error: "unexpected-response" });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.deviceModel).toEqual({
      responses: [],
      judgement: { ...requests[0]!.deviceModel!.judgement, startedAt: NOW, cancel: true },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the local spend stop before requesting a service reservation", async () => {
    const day = new Date(NOW).toISOString().slice(0, 10);
    const { transport, requests, fetch } = judgeRelay([], {
      version: 1,
      day,
      dayMicroUsd: 5_000_000,
      month: day.slice(0, 7),
      monthMicroUsd: 5_000_000,
    });
    expect(
      await transport.judgeCompletion(ORIGIN, CREDENTIAL, "gen_synthetic", request),
    ).toMatchObject({ kind: "result", result: { status: "unavailable", reason: "daily-limit" } });
    expect(requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
