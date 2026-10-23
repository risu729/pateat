import {
  DEVICE_MODEL_URL,
  deviceModelRequestHash,
  type DeviceModel,
  type DeviceModelCall,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  callCostMicroUsd,
  createDeviceModel,
  currentSpend,
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
  apiKey: KEY,
  dailyLimitUsd: 5,
  monthlyLimitUsd: 100,
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
const BODY = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1024 });
const CALL: DeviceModelCall = {
  version: 1,
  status: "model-call",
  call: { index: 0, headers: { "anthropic-version": "2023-06-01" }, body: BODY },
};
const RECIPE = { version: 1, status: "abstained", reason: "no-login-form" } as const;
const ANSWER = JSON.stringify({ usage: { input_tokens: 1_000_000, output_tokens: 0 } });

function setup(
  options: {
    setting?: DeviceModelSetting | undefined;
    spend?: DeviceModelSpend;
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
    storage: {
      read: async () => ("setting" in options ? options.setting : SETTING),
      write: async () => {},
      clear: async () => {},
    },
    spend: {
      read: async () => spend,
      write: async (value) => {
        spend = value;
      },
    },
    fetch,
    now: () => NOW,
  });
  const transport = model.wrap({
    generateRecipe,
    generateEntry: vi.fn(),
    judgeCompletion: vi.fn(),
  } as unknown as Pick<ServiceTransport, "generateRecipe" | "generateEntry" | "judgeCompletion">);
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
      { responses: [] },
      {
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
      answers: Array.from({ length: 20 }, () => CALL as RecipeGenerationResult),
      fetch: async () =>
        new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 10 } })),
    });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, REQUEST)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    expect(fetch).toHaveBeenCalledTimes(12);
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

  it("charges the worst case for a call without reported usage, and nothing when it never left", () => {
    const worst = callCostMicroUsd(BODY, { kind: "timeout", request: "" });
    expect(worst).toBeGreaterThan(0);
    expect(callCostMicroUsd(BODY, { kind: "unreachable", request: "" })).toBe(0);
    expect(
      callCostMicroUsd(BODY, { kind: "response", request: "", status: 529, body: "overloaded" }),
    ).toBe(0);
  });
});
