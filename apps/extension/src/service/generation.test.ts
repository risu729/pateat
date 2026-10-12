import type { LoginObservation, RecipeGenerationRequest } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createLoginGeneration,
  GENERATION_RETRY_MS,
  GENERATION_SENDING_MS,
  MAX_GENERATED_SLOT_MAPS,
} from "./generation";
import type { ServiceConnection } from "./runtime";
import type { InferenceResult, ServiceTransport } from "./transport";

// Synthetic pages and a fake transport only; nothing leaves the test.

const connection: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const observation: LoginObservation = {
  version: 1,
  origin: "https://shop.example",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [{ id: "c1", role: "password", target: { by: "id", value: "password" } }],
};
const request: RecipeGenerationRequest = {
  version: 1,
  observation,
  slots: [{ id: "password", kind: "secret", description: "account password" }],
};
const recipeChange = {
  recipeId: "gen-0123456789abcdef0123456789abcdef",
  revision: 1,
  state: "active" as const,
  recipe: {
    version: 1 as const,
    id: "gen-0123456789abcdef0123456789abcdef",
    revision: 1,
    origin: "https://shop.example",
    slots: ["password"],
    steps: [
      {
        kind: "fill" as const,
        path: "/login",
        fields: [{ slot: "password", target: { by: "id" as const, value: "password" } }],
        effect: "submit" as const,
        event: "change" as const,
      },
    ],
    maxSubmissions: 1,
  },
};

function setup(
  answer: Awaited<ReturnType<ServiceTransport["generateRecipe"]>> = {
    kind: "result",
    result: { version: 1, status: "recipe", change: recipeChange },
  },
) {
  let stored: unknown;
  let now = 1_000_000;
  const storage = {
    read: vi.fn(async () => structuredClone(stored)),
    write: vi.fn(async (value: unknown) => {
      stored = structuredClone(value);
    }),
  };
  const transport = {
    generateRecipe: vi.fn<ServiceTransport["generateRecipe"]>(async () => answer),
    judgeCompletion: vi.fn<ServiceTransport["judgeCompletion"]>(
      async (): Promise<InferenceResult<never>> => ({ kind: "failed", error: "unreachable" }),
    ),
  };
  const service = {
    connection: vi.fn(async (): Promise<ServiceConnection | undefined> => connection),
  };
  const sync = vi.fn(async () => "synced");
  const refresh = vi.fn(async () => "synced");
  const generation = createLoginGeneration({
    service,
    transport,
    storage,
    slotStorage: { read: async () => undefined, write: async () => undefined },
    sync,
    refresh,
    now: () => now,
  });
  return {
    generation,
    transport,
    service,
    storage,
    sync,
    refresh,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("recipe generation requests", () => {
  it("sends a page once per retry window and refreshes the cache before reporting a recipe", async () => {
    const h = setup();
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toEqual({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      request,
    );
    expect(h.sync).toHaveBeenCalledTimes(1);
    // A generated recipe takes a full sync; only a judged page pulls recipes alone.
    expect(h.refresh).not.toHaveBeenCalled();

    // The same page is not sent again within the window; another path is.
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(await h.generation.generate(request)).toEqual({ outcome: "skipped", reason: "sent" });
    expect(await h.generation.available(observation.origin, "/other")).toBe(true);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);

    h.advance(GENERATION_RETRY_MS);
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
  });

  it("claims the page before sending, so two tabs send it once", async () => {
    const h = setup({
      kind: "result",
      result: { version: 1, status: "abstained", reason: "no-login-form" },
    });
    const sent = vi.fn();
    expect(
      await Promise.all([
        h.generation.generate(request, sent),
        h.generation.generate(request, sent),
      ]),
    ).toEqual([
      { outcome: "abstained", reason: "no-login-form" },
      { outcome: "skipped", reason: "sending" },
    ]);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
    // Only the request that left the device says it was sent (ADR 0019).
    expect(sent).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an abstention",
      { kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } },
      { outcome: "abstained", reason: "ambiguous" },
    ],
    [
      "a model failure",
      { kind: "result", result: { version: 1, status: "failed", error: "invalid-output" } },
      { outcome: "failed", reason: "invalid-output" },
    ],
    [
      "the model call's timeout",
      { kind: "result", result: { version: 1, status: "failed", error: "timeout" } },
      { outcome: "failed", reason: "timeout" },
    ],
    [
      "output the plan check refused",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "plan", reason: "incompatible-role" },
        },
      },
      { outcome: "failed", reason: "invalid-output", check: "plan", detail: "incompatible-role" },
    ],
    [
      "output the format refused",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "schema", issue: "max-length", path: "result.alternatives" },
        },
      },
      {
        outcome: "failed",
        reason: "invalid-output",
        check: "schema",
        detail: "max-length",
        path: "result.alternatives",
      },
    ],
    [
      "output the format refused at its top",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "schema", issue: "object", path: "" },
        },
      },
      { outcome: "failed", reason: "invalid-output", check: "schema", detail: "object" },
    ],
    [
      "output that was not JSON",
      {
        kind: "result",
        result: {
          version: 1,
          status: "failed",
          error: "invalid-output",
          rejection: { check: "json" },
        },
      },
      { outcome: "failed", reason: "invalid-output", check: "json" },
    ],
  ] as const)("keeps the page for the retry window after %s", async (_name, answer, outcome) => {
    const h = setup(answer);
    expect(await h.generation.generate(request)).toEqual(outcome);
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    h.advance(GENERATION_RETRY_MS - 1);
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
  });

  type Answer = Awaited<ReturnType<ServiceTransport["generateRecipe"]>>;
  const freed: [string, Answer, string, string][] = [
    ["an unreachable service", { kind: "failed", error: "unreachable" }, "failed", "unreachable"],
    [
      "the service's request limit",
      { kind: "failed", error: "rate-limited" },
      "failed",
      "rate-limited",
    ],
    // The answer may be lost after a model call; the service then answers `recently-tried`.
    ["a timeout", { kind: "failed", error: "timeout" }, "failed", "timeout"],
    [
      "an unexpected answer",
      { kind: "failed", error: "unexpected-response" },
      "failed",
      "unexpected-response",
    ],
    ["a rejected device", { kind: "rejected" }, "failed", "device-rejected"],
    [
      "a request the service refused before the model",
      { kind: "result", result: { version: 1, status: "failed", error: "input-too-large" } },
      "failed",
      "input-too-large",
    ],
    ...(
      [
        "busy",
        "recently-tried",
        "credentials-not-configured",
        "token-exchange-failed",
        "daily-limit",
        "recipe-limit",
      ] as const
    ).map((reason): [string, Answer, string, string] => [
      `the service's ${reason}`,
      { kind: "result", result: { version: 1, status: "unavailable", reason } },
      "unavailable",
      reason,
    ]),
  ];
  it.each(freed)("may send the page again after %s", async (_name, answer, outcome, reason) => {
    const h = setup(answer);
    expect(await h.generation.generate(request)).toEqual({ outcome, reason });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toEqual({ outcome, reason });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
  });

  it("frees a page whose request threw or never answered", async () => {
    const h = setup();
    h.transport.generateRecipe.mockRejectedValueOnce(new Error("transport"));
    await expect(h.generation.generate(request)).rejects.toThrow("transport");
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);

    // A worker stopped or reloaded mid-request never runs its answer's code: the claim
    // holds only while the request could still be in flight.
    h.transport.generateRecipe.mockReturnValueOnce(new Promise(() => undefined));
    void h.generation.generate(request);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2));
    const restarted = createLoginGeneration({
      service: h.service,
      transport: h.transport,
      storage: h.storage,
      slotStorage: { read: async () => undefined, write: async () => undefined },
      sync: h.sync,
      refresh: h.refresh,
      now: h.now,
    });
    expect(await restarted.available(observation.origin, "/login")).toBe("sending");
    h.advance(GENERATION_SENDING_MS);
    expect(await restarted.available(observation.origin, "/login")).toBe(true);
  });

  it("keeps other pages' claims when storage cannot be read", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toEqual({ outcome: "recipe" });
    h.storage.read.mockRejectedValueOnce(new Error("read"));
    expect(
      await h.generation.generate({ ...request, observation: { ...observation, path: "/other" } }),
    ).toEqual({ outcome: "skipped", reason: "storage-unavailable" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
  });

  it("ignores pages claimed in the earlier record shape", async () => {
    const h = setup();
    h.storage.write.mockClear();
    await h.storage.write({
      version: 1,
      attempts: [{ origin: observation.origin, path: "/login", at: h.now() }],
    });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
  });

  it("sends nothing without a paired, accepted device or when it cannot remember", async () => {
    const h = setup();
    h.service.connection.mockResolvedValueOnce(undefined);
    expect(await h.generation.available(observation.origin, "/login")).toBe("not-connected");
    h.service.connection.mockResolvedValueOnce({ ...connection, rejected: true });
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
    });
    h.storage.write.mockRejectedValueOnce(new Error("quota"));
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "storage-unavailable",
    });
    expect(h.transport.generateRecipe).not.toHaveBeenCalled();
  });

  it("maps the completion judgement and refreshes the cache after a sign-in", async () => {
    const h = setup();
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: {
        version: 1,
        status: "signed-in",
        change: {
          ...recipeChange,
          revision: 2,
          recipe: {
            ...recipeChange.recipe,
            revision: 2,
            completion: { path: "/home", target: { by: "id", value: "logout" } },
          },
        },
      },
    });
    const home = { ...observation, path: "/home" };
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "signed-in",
    });
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, route: "password", observation: home },
    );
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge" },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "challenge",
    });
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "failed", error: "invalid-output" },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "unclear",
      reason: "invalid-output",
    });
    // An unreachable service is a temporary refusal, so the page is given back.
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "retry",
      reason: "unreachable",
    });
  });

  const unavailable = (reason: string) => ({
    kind: "result" as const,
    result: { version: 1 as const, status: "unavailable" as const, reason },
  });
  const failure = (error: string) => ({
    kind: "result" as const,
    result: { version: 1 as const, status: "failed" as const, error },
  });
  it.each([
    // Temporary refusals before any model call give the page back.
    ["a busy service", unavailable("busy"), "retry", "busy"],
    [
      "the service's own request limit",
      { kind: "failed", error: "rate-limited" },
      "retry",
      "rate-limited",
    ],
    ["an unreachable service", { kind: "failed", error: "unreachable" }, "retry", "unreachable"],
    ["a rejected device", { kind: "rejected" }, "retry", "device-rejected"],
    ...(["incomplete-observation", "invalid-request", "input-too-large"] as const).map((error) => [
      `a request that failed before the model (${error})`,
      failure(error),
      "retry",
      error,
    ]),
    // Permanent refusals and anything that may follow a model call spend it.
    ...(
      [
        "already-judged",
        "not-judgeable",
        "recipe-conflict",
        "recipe-revoked",
        "judgement-limit",
        "daily-limit",
        "monthly-limit",
        "credentials-not-configured",
        "token-exchange-failed",
      ] as const
    ).map((reason) => [`the permanent refusal ${reason}`, unavailable(reason), "unclear", reason]),
    ["the provider's rate limit", failure("rate-limited"), "unclear", "rate-limited"],
    [
      "a model that abstained",
      { kind: "result", result: { version: 1, status: "unclear" } },
      "unclear",
      undefined,
    ],
    ["a failure after the model call", failure("truncated"), "unclear", "truncated"],
    [
      "a timeout, which may follow a model call",
      { kind: "failed", error: "timeout" },
      "unclear",
      "timeout",
    ],
    [
      "an unexpected answer",
      { kind: "failed", error: "unexpected-response" },
      "unclear",
      "unexpected-response",
    ],
  ] as [
    string,
    Awaited<ReturnType<ServiceTransport["judgeCompletion"]>>,
    string,
    string | undefined,
  ][])(
    "gives a judged page back only after a temporary refusal, naming its code: %s",
    async (_name, answer, verdict, reason) => {
      const h = setup();
      h.transport.judgeCompletion.mockResolvedValueOnce(answer);
      expect(
        await h.generation.judge(recipeChange.recipeId, 1, "password", {
          ...observation,
          path: "/home",
        }),
      ).toEqual({ verdict, ...(reason ? { reason } : {}) });
    },
  );
});

describe("handlers and code fields in generation requests (ADR 0027)", () => {
  const totp = { id: "totp", kind: "one-time-code" as const, description: "one-time code" };
  const handled = {
    ...recipeChange,
    revision: 2,
    recipe: {
      ...recipeChange.recipe,
      revision: 2,
      handlers: [
        {
          kind: "passkey" as const,
          path: "/login/webauthn",
          target: { by: "text" as const, value: "Use security key" },
        },
      ],
    },
  };
  const webauthn = { ...observation, path: "/login/webauthn" };

  it("hands a judged handler's recipe to the login without waiting for the cache", async () => {
    const h = setup();
    h.refresh.mockImplementationOnce(() => new Promise<string>(() => {}));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: handled },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).toEqual({
      verdict: "challenge",
      recipe: handled.recipe,
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, route: "password", observation: webauthn },
    );
    // A failed refresh still hands the recipe over; the login checks it before use.
    h.refresh.mockRejectedValueOnce(new Error("offline"));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: handled },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).toEqual({
      verdict: "challenge",
      recipe: handled.recipe,
    });
  });

  const completed = {
    ...handled,
    recipe: {
      ...handled.recipe,
      completion: { path: "/home", target: { by: "id" as const, value: "logout" } },
    },
  };
  it.each([
    ["signed-in", completed],
    ["challenge", handled],
  ] as const)(
    "pulls only recipes after a %s judgement with a change, never a full sync",
    async (status, change) => {
      const h = setup();
      h.transport.judgeCompletion.mockResolvedValueOnce({
        kind: "result",
        result: { version: 1, status, change },
      });
      // A settings write would stop the login this page belongs to as a policy change.
      expect(
        (await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).verdict,
      ).toBe(status);
      await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
      expect(h.sync).not.toHaveBeenCalled();
    },
  );

  it("answers signed-in without a change and does not wait for the cache", async () => {
    const h = setup();
    h.refresh.mockImplementationOnce(() => new Promise<string>(() => {}));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "signed-in" },
    });
    expect(
      await h.generation.judge(recipeChange.recipeId, 3, "password", { ...observation, path: "/" }),
    ).toEqual({ verdict: "signed-in" });
    for (const reason of ["already-judged", "judgement-limit", "not-judgeable"] as const) {
      h.transport.judgeCompletion.mockResolvedValueOnce({
        kind: "result",
        result: { version: 1, status: "unavailable", reason },
      });
      // eslint-disable-next-line no-await-in-loop
      expect(await h.generation.judge(recipeChange.recipeId, 3, "password", webauthn)).toEqual({
        verdict: "unclear",
        reason,
      });
    }
  });

  it("offers the TOTP slot only for a page with a code field", async () => {
    const h = setup();
    expect(await h.generation.generate({ ...request, slots: [...request.slots, totp] })).toEqual({
      outcome: "recipe",
    });
    expect(h.transport.generateRecipe).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      request,
    );
    const coded: LoginObservation = {
      ...observation,
      path: "/verify",
      candidates: [
        ...observation.candidates,
        {
          id: "c2",
          role: "text",
          target: { by: "id", value: "code" },
          autocomplete: "one-time-code",
        },
      ],
    };
    const withCode = { ...request, observation: coded, slots: [...request.slots, totp] };
    expect(await h.generation.generate(withCode)).toEqual({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      withCode,
    );
  });

  it("sends no request whose only slot is a TOTP the page has no field for", async () => {
    const h = setup();
    expect(await h.generation.generate({ ...request, slots: [totp] })).toEqual({
      outcome: "skipped",
      reason: "no-slots",
    });
    expect(h.transport.generateRecipe).not.toHaveBeenCalled();
  });
});

describe("generated slot maps (ADR 0027)", () => {
  const offered: RecipeGenerationRequest = {
    ...request,
    slots: [
      ...request.slots,
      {
        id: "custom-1",
        kind: "identifier",
        description: "value of the user's vault field named in fieldName",
        fieldName: "Branch number",
      },
      {
        id: "custom-2",
        kind: "hidden",
        description: "concealed value of the user's vault field named in fieldName, such as a PIN",
        fieldName: "PIN",
        fieldPosition: { position: 2, count: 2 },
      },
    ],
  };
  const customSlots = [
    { slot: "branch-number", offered: "custom-1" },
    { slot: "pin-code", offered: "custom-2" },
  ];
  const mapped = [
    { slot: "branch-number", field: { custom: "Branch number" } },
    { slot: "pin-code", field: { custom: "PIN", position: 2, count: 2 } },
  ];
  const recipeId = recipeChange.recipeId;
  const idOf = (index: number) => `gen-${index.toString(16).padStart(32, "0")}`;

  function slotSetup(
    options: {
      customSlots?: { slot: string; offered: string }[];
      stored?: unknown;
      failWrite?: boolean;
      /** Reads that reject before one succeeds. */
      failReads?: number;
      /** The answered change, for a continuation. */
      change?: typeof recipeChange;
    } = {},
  ) {
    let stored = options.stored;
    let failReads = options.failReads ?? 0;
    const order: string[] = [];
    const slotStorage = {
      read: vi.fn(async () => {
        if (failReads > 0) {
          failReads -= 1;
          throw new Error("synthetic storage failure");
        }
        return structuredClone(stored);
      }),
      write: vi.fn(async (value: unknown) => {
        order.push("write");
        if (options.failWrite) throw new Error("synthetic storage failure");
        stored = structuredClone(value);
      }),
    };
    const transport = {
      generateRecipe: vi.fn<ServiceTransport["generateRecipe"]>(
        async (_origin, _credential, sent) => ({
          kind: "result" as const,
          result: {
            version: 1 as const,
            status: "recipe" as const,
            change: options.change ?? {
              ...recipeChange,
              recipeId: sent.observation.path === "/login" ? recipeId : idOf(0),
            },
            ...(options.customSlots === undefined
              ? { customSlots }
              : options.customSlots.length
                ? { customSlots: options.customSlots }
                : {}),
          },
        }),
      ),
      judgeCompletion: vi.fn<ServiceTransport["judgeCompletion"]>(),
    };
    const service = {
      connection: vi.fn(async (): Promise<ServiceConnection | undefined> => connection),
    };
    let attempts: unknown;
    const generation = createLoginGeneration({
      service,
      transport,
      storage: {
        read: async () => structuredClone(attempts),
        write: async (value) => {
          attempts = structuredClone(value);
        },
      },
      slotStorage,
      sync: vi.fn(async () => {
        order.push("sync");
        return "synced";
      }),
      refresh: vi.fn(async () => "synced"),
    });
    return { generation, service, slotStorage, order, stored: () => stored };
  }

  it("remembers the offered fields per recipe before reporting it", async () => {
    const h = slotSetup();
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    expect(await h.generation.generate(offered)).toEqual({ outcome: "recipe" });
    expect(h.order).toEqual(["write", "sync"]);
    expect(h.stored()).toEqual({
      version: 1,
      maps: [
        { service: connection.origin, deviceId: connection.deviceId, recipeId, slots: mapped },
      ],
    });
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
    // No value and no item reaches storage: only names, positions and counts.
    expect(JSON.stringify(h.stored())).not.toMatch(/item|value/iu);
  });

  it("answers only for the paired service, device and recipe", async () => {
    const h = slotSetup();
    await h.generation.generate(offered);
    expect(await h.generation.slotFields(idOf(7))).toBeUndefined();
    h.service.connection.mockResolvedValue({ ...connection, deviceId: "another-device" });
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    h.service.connection.mockResolvedValue({ ...connection, origin: "https://other.example.com" });
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    h.service.connection.mockResolvedValue(undefined);
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    h.service.connection.mockResolvedValue(connection);
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
  });

  it("reads maps another worker wrote and ignores a stored map for another device", async () => {
    const entry = (deviceId: string) => ({
      service: connection.origin,
      deviceId,
      recipeId,
      slots: mapped,
    });
    const h = slotSetup({ stored: { version: 1, maps: [entry("another-device")] } });
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    const own = slotSetup({ stored: { version: 1, maps: [entry(connection.deviceId)] } });
    expect(await own.generation.slotFields(recipeId)).toEqual(mapped);
    // An unreadable record counts as no maps.
    const broken = slotSetup({
      stored: {
        version: 1,
        maps: [
          {
            ...entry(connection.deviceId),
            slots: [{ slot: "Branch number", field: { custom: "Branch number" } }],
          },
        ],
      },
    });
    expect(await broken.generation.slotFields(recipeId)).toBeUndefined();
  });

  it.each([
    ["an unknown request slot", [{ slot: "branch-number", offered: "custom-9" }]],
    ["a built-in slot", [...customSlots, { slot: "secret-word", offered: "password" }]],
    ["no custom slot", []],
  ])("writes nothing for a mapping that names %s", async (_label, mapping) => {
    const h = slotSetup({ customSlots: mapping });
    expect(await h.generation.generate(offered)).toEqual({ outcome: "recipe" });
    expect(h.slotStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("keeps nothing in memory that it could not write, and still reports the recipe", async () => {
    const h = slotSetup({ failWrite: true });
    expect(await h.generation.generate(offered)).toEqual({ outcome: "recipe" });
    expect(h.order).toEqual(["write", "sync"]);
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("keeps at most 200 recipes, replacing a recipe's map and dropping the oldest", async () => {
    const full = Array.from({ length: MAX_GENERATED_SLOT_MAPS }, (_, index) => ({
      service: connection.origin,
      deviceId: connection.deviceId,
      recipeId: idOf(index + 1),
      slots: [{ slot: "old-slot", field: { custom: "Old" } }],
    }));
    const h = slotSetup({ stored: { version: 1, maps: full } });
    expect(MAX_GENERATED_SLOT_MAPS).toBe(200);
    expect(await h.generation.slotFields(idOf(1))).toEqual(full[0]!.slots);
    await h.generation.generate(offered);
    const maps = (h.stored() as { maps: { recipeId: string }[] }).maps;
    expect(maps).toHaveLength(200);
    expect(maps[0]!.recipeId).toBe(idOf(2));
    expect(maps.at(-1)!.recipeId).toBe(recipeId);
    expect(await h.generation.slotFields(idOf(1))).toBeUndefined();
    expect(await h.generation.slotFields(idOf(2))).toEqual(full[1]!.slots);

    // A recipe generated again replaces its own map instead of adding one.
    const again = slotSetup({ stored: h.stored() });
    await again.generation.generate({
      ...offered,
      observation: { ...observation, path: "/other" },
    });
    await again.generation.generate(offered);
    const after = (again.stored() as { maps: { recipeId: string }[] }).maps;
    expect(after).toHaveLength(200);
    expect(after.filter((entry) => entry.recipeId === recipeId)).toHaveLength(1);
  });

  // Page 1 of a recipe mapped `branch-number`; its continuation maps only page 2's slot.
  const ownMap = (id: string, slots: { slot: string; field: { custom: string } }[]) => ({
    service: connection.origin,
    deviceId: connection.deviceId,
    recipeId: id,
    slots,
  });
  const continued = {
    ...recipeChange,
    revision: 2,
    recipe: {
      ...recipeChange.recipe,
      revision: 2,
      slots: ["password", "branch-number", "pin-code"],
    },
  };
  const continuation = { ...offered, base: { recipeId, revision: 1 } };

  it("adds a continuation's slots to the map of the recipe it continues", async () => {
    const other = ownMap(idOf(5), [{ slot: "old-slot", field: { custom: "Old" } }]);
    const h = slotSetup({
      stored: { version: 1, maps: [ownMap(recipeId, [mapped[0]!]), other] },
      customSlots: [customSlots[1]!],
      change: continued,
    });
    expect(await h.generation.generate(continuation)).toEqual({ outcome: "recipe" });
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
    expect(await h.generation.slotFields(idOf(5))).toEqual(other.slots);
    expect((h.stored() as { maps: unknown[] }).maps).toHaveLength(2);
  });

  it("keeps the slots of every password variant of the recipe it answers (ADR 0027)", async () => {
    const varied = {
      ...continued,
      recipe: {
        ...recipeChange.recipe,
        revision: 2,
        alternatives: [
          {
            slots: ["branch-number", "pin-code"],
            steps: [
              {
                kind: "fill" as const,
                path: "/login",
                effect: "prepare" as const,
                fields: [
                  { slot: "branch-number", target: { by: "id" as const, value: "branch" } },
                  { slot: "pin-code", target: { by: "id" as const, value: "pin" } },
                ],
              },
              {
                kind: "click" as const,
                path: "/login",
                target: { by: "id" as const, value: "login" },
                purpose: "submit" as const,
              },
            ],
          },
        ],
      },
    };
    const h = slotSetup({
      stored: { version: 1, maps: [ownMap(recipeId, [mapped[0]!])] },
      customSlots: [customSlots[1]!],
      change: varied,
    });
    expect(await h.generation.generate(continuation)).toEqual({ outcome: "recipe" });
    // The branch slot belongs to an alternative, not to the recipe's own slots.
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
  });

  it("keeps only the continued recipe's slots and no other device's map", async () => {
    const h = slotSetup({
      stored: {
        version: 1,
        maps: [
          ownMap(recipeId, [mapped[0]!, { slot: "dropped-slot", field: { custom: "Dropped" } }]),
        ],
      },
      customSlots: [customSlots[1]!],
      change: continued,
    });
    await h.generation.generate(continuation);
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);

    const elsewhere = slotSetup({
      stored: {
        version: 1,
        maps: [{ ...ownMap(recipeId, [mapped[0]!]), deviceId: "another-device" }],
      },
      customSlots: [customSlots[1]!],
      change: continued,
    });
    await elsewhere.generation.generate(continuation);
    expect(await elsewhere.generation.slotFields(recipeId)).toEqual([mapped[1]]);
  });

  it("replaces the map when the answer starts a new recipe", async () => {
    const h = slotSetup({
      stored: {
        version: 1,
        maps: [ownMap(recipeId, [{ slot: "old-slot", field: { custom: "Old" } }])],
      },
    });
    expect(await h.generation.generate(offered)).toEqual({ outcome: "recipe" });
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
  });

  it("reads the maps again after a failed read instead of keeping none", async () => {
    const other = ownMap(idOf(5), [{ slot: "old-slot", field: { custom: "Old" } }]);
    const h = slotSetup({ stored: { version: 1, maps: [other] }, failReads: 1 });
    expect(await h.generation.slotFields(idOf(5))).toBeUndefined();
    expect(await h.generation.slotFields(idOf(5))).toEqual(other.slots);
    expect(h.slotStorage.read).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when the maps cannot be read, so no other map is dropped", async () => {
    const other = ownMap(idOf(5), [{ slot: "old-slot", field: { custom: "Old" } }]);
    const h = slotSetup({ stored: { version: 1, maps: [other] }, failReads: 1 });
    expect(await h.generation.generate(offered)).toEqual({ outcome: "recipe" });
    expect(h.order).toEqual(["sync"]);
    expect(h.slotStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.slotFields(idOf(5))).toEqual(other.slots);
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("replaces stored maps that do not parse, since no older format is kept", async () => {
    const h = slotSetup({ stored: { version: 0, maps: "synthetic" } });
    expect(await h.generation.generate(offered)).toEqual({ outcome: "recipe" });
    expect(h.stored()).toEqual({ version: 1, maps: [ownMap(recipeId, mapped)] });
  });
});
