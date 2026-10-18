import {
  PAGE_SAMPLE_INTERVAL_MS,
  type EntryGenerationRequest,
  type LoginObservation,
  type RecipeGenerationRequest,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createLoginGeneration,
  GENERATION_RETRY_MS,
  GENERATION_SENDING_MS,
  MAX_GENERATED_SLOT_MAPS,
  MAX_PAGE_SAMPLES,
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

const entryChange = {
  recipeId: "gen-fedcba9876543210fedcba9876543210",
  revision: 1,
  state: "active" as const,
  recipe: {
    version: 1 as const,
    id: "gen-fedcba9876543210fedcba9876543210",
    revision: 1,
    origin: "https://shop.example",
    entry: { path: "/", target: { by: "text" as const, value: "Log in" } },
  },
};
const entryRequest: EntryGenerationRequest = {
  version: 1,
  observation: {
    version: 1,
    origin: "https://shop.example",
    path: "/",
    language: "en",
    complete: true,
    candidates: [
      { id: "c1", role: "link", target: { by: "text", value: "Log in" }, label: "Log in" },
    ],
  },
};

function setup(
  answer: Awaited<ReturnType<ServiceTransport["generateRecipe"]>> = {
    kind: "result",
    result: { version: 1, status: "recipe", change: recipeChange },
  },
  entryAnswer: Awaited<ReturnType<ServiceTransport["generateEntry"]>> = {
    kind: "result",
    result: { version: 1, status: "recipe", change: entryChange },
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
    generateEntry: vi.fn<ServiceTransport["generateEntry"]>(async () => entryAnswer),
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
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
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

  it("takes a chooser recipe (ADR 0028) as the answer to a list of accounts only", async () => {
    const chooser = {
      ...recipeChange,
      recipe: {
        version: 1 as const,
        id: recipeChange.recipeId,
        revision: 1,
        origin: observation.origin,
        chooser: { path: "/login", other: { by: "text" as const, value: "Use another" } },
      },
    };
    const list = { ...request, observation: { ...observation, accounts: ["[email]"] } };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    expect(await h.generation.generate(list)).toEqual({
      outcome: "recipe",
      recipe: chooser.recipe,
    });
    expect(h.sync).toHaveBeenCalled();
    // A route recipe never answers a list.
    const route = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
    });
    expect(await route.generation.generate(list)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
  });

  it("takes a chooser recipe (ADR 0028) as the answer to a branch's page, claimed per branch", async () => {
    const chooser = {
      ...recipeChange,
      revision: 2,
      recipe: {
        version: 1 as const,
        id: recipeChange.recipeId,
        revision: 2,
        origin: observation.origin,
        chooser: {
          path: "/login",
          other: { by: "text" as const, value: "Use another" },
          afterAccount: { ...recipeChange.recipe, revision: 2 },
        },
      },
    };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    const base = { recipeId: recipeChange.recipeId, revision: 1 };
    const account = { ...request, base, branch: "account" as const };
    expect(await h.generation.generate(account)).toEqual({
      outcome: "recipe",
      recipe: chooser.recipe,
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      account,
    );
    // A continuation pulls recipes alone, so its login is not stopped by settings.
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
    // The same page of the other branch is a request of its own, and so is its hold.
    expect(await h.generation.generate(account)).toEqual({ outcome: "skipped", reason: "sent" });
    expect(await h.generation.available(observation.origin, "/login", base, "account")).toBe(
      "sent",
    );
    expect(await h.generation.available(observation.origin, "/login", base, "other")).toBe(true);
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate({ ...account, branch: "other" })).toMatchObject({
      outcome: "recipe",
    });
    expect(await h.generation.available(observation.origin, "/login", base, "other")).toBe("sent");
    // A route recipe never answers a branch's page.
    const route = setup();
    expect(await route.generation.generate(account)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
  });

  it("takes no chooser recipe (ADR 0028) as the answer to a form page", async () => {
    const chooser = {
      ...recipeChange,
      recipe: {
        version: 1 as const,
        id: recipeChange.recipeId,
        revision: 1,
        origin: observation.origin,
        chooser: { path: "/login" },
      },
    };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    expect(await h.generation.generate(request)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
    // The request reached the model, so the page is not sent again in the window.
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
  });

  it("sends an entry page without slots and pulls its entry recipe (ADR 0031)", async () => {
    const h = setup();
    const sent = vi.fn();
    expect(await h.generation.generateEntry(entryRequest, sent)).toEqual({
      outcome: "recipe",
      recipe: entryChange.recipe,
    });
    expect(h.transport.generateEntry).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      entryRequest,
    );
    expect(h.transport.generateRecipe).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledTimes(1);
    // Cached through the full sync, as a first page's recipe is.
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
    // Claimed as any first page: the page is held for the retry window (ADR 0016).
    expect(await h.generation.available("https://shop.example", "/")).toBe("sent");
    expect(await h.generation.generateEntry(entryRequest, sent)).toEqual({
      outcome: "skipped",
      reason: "sent",
    });
    expect(h.transport.generateEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "an abstention",
      { kind: "result", result: { version: 1, status: "abstained", reason: "no-login-form" } },
      { outcome: "abstained", reason: "no-login-form" },
      "sent",
    ],
    [
      "an unreachable service",
      { kind: "failed", error: "unreachable" },
      { outcome: "failed", reason: "unreachable", retry: true },
      true,
    ],
  ] as const)(
    "answers an entry page's %s without syncing",
    async (_label, answer, outcome, held) => {
      const h = setup(undefined, answer);
      expect(await h.generation.generateEntry(entryRequest)).toEqual(outcome);
      expect(h.sync).not.toHaveBeenCalled();
      expect(await h.generation.available("https://shop.example", "/")).toBe(held);
    },
  );

  it("skips an entry page while no service is paired", async () => {
    const h = setup();
    h.service.connection.mockResolvedValue(undefined);
    expect(await h.generation.generateEntry(entryRequest)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
    expect(h.transport.generateEntry).not.toHaveBeenCalled();
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
      { outcome: "skipped", reason: "sending", retry: true },
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
    expect(await h.generation.generate(request)).toEqual({ outcome, reason, retry: true });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toEqual({ outcome, reason, retry: true });
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
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    h.storage.read.mockRejectedValueOnce(new Error("read"));
    expect(
      await h.generation.generate({ ...request, observation: { ...observation, path: "/other" } }),
    ).toEqual({ outcome: "skipped", reason: "storage-unavailable", retry: true });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
  });

  it("treats a claims record it cannot parse as holding no claims", async () => {
    const h = setup();
    await h.storage.write({
      version: 1,
      attempts: [{ origin: observation.origin, path: "/login", at: h.now() }],
    });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    // Sending goes through the claim write, which has no fallback of its own.
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(h.storage.write).toHaveBeenLastCalledWith({
      version: 1,
      attempts: [
        { origin: observation.origin, path: "/login", state: "sent", at: expect.any(Number) },
      ],
    });
  });

  it("sends nothing without a paired, accepted device or when it cannot remember", async () => {
    const h = setup();
    h.service.connection.mockResolvedValueOnce(undefined);
    expect(await h.generation.available(observation.origin, "/login")).toBe("not-connected");
    h.service.connection.mockResolvedValueOnce({ ...connection, rejected: true });
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
    h.storage.write.mockRejectedValueOnce(new Error("quota"));
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "storage-unavailable",
      retry: true,
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
            completion: [{ target: { by: "id", value: "logout" } }],
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
    // A description that left out a disabled field says so (ADR 0029).
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unclear" },
    });
    await h.generation.judge(
      recipeChange.recipeId,
      1,
      "password",
      home,
      undefined,
      undefined,
      true,
    );
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, route: "password", observation: home, partial: true },
    );
    // A page at a login's stop before its item's missing password says so (ADR 0036).
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unclear" },
    });
    await h.generation.judge(
      recipeChange.recipeId,
      1,
      "password",
      home,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, route: "password", observation: home, stop: true },
    );
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

describe("request timing for the local log (ADR 0019)", () => {
  const timing = { roundTripMs: 2_600, serverMs: 2_400, networkMs: 200, modelMs: 2_000 };

  it("passes each answered request's timing on with its outcome", async () => {
    const recipe = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
      timing,
    });
    expect(await recipe.generation.generate(request)).toMatchObject({ outcome: "recipe", timing });
    const abstained = setup({
      kind: "result",
      result: { version: 1, status: "abstained", reason: "no-login-form" },
      timing,
    });
    expect(await abstained.generation.generate(request)).toEqual({
      outcome: "abstained",
      reason: "no-login-form",
      timing,
    });
    const unreachable = setup(undefined, {
      kind: "failed",
      error: "unreachable",
      timing: { roundTripMs: 30 },
    });
    expect(await unreachable.generation.generateEntry(entryRequest)).toEqual({
      outcome: "failed",
      reason: "unreachable",
      retry: true,
      timing: { roundTripMs: 30 },
    });
    const judged = setup();
    judged.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge" },
      timing,
    });
    expect(
      await judged.generation.judge(recipeChange.recipeId, 1, "password", {
        ...observation,
        path: "/home",
      }),
    ).toEqual({ verdict: "challenge", timing });
  });

  it("has no timing for a page that was never sent", async () => {
    const h = setup();
    h.service.connection.mockResolvedValue(undefined);
    expect(await h.generation.generate(request)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
  });
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

  it("judges a chooser login's page on its branch and hands the chooser over (ADR 0028)", async () => {
    const h = setup();
    const chooser = {
      ...handled,
      recipe: {
        version: 1 as const,
        id: handled.recipe.id,
        revision: handled.recipe.revision,
        origin: handled.recipe.origin,
        chooser: { path: "/login", afterAccount: handled.recipe },
      },
    };
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: chooser },
    });
    expect(
      await h.generation.judge(
        recipeChange.recipeId,
        1,
        "password",
        webauthn,
        undefined,
        "account",
      ),
    ).toEqual({ verdict: "challenge", recipe: chooser.recipe });
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, route: "password", branch: "account", observation: webauthn },
    );
    // A route login never takes a chooser over.
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: chooser },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).toEqual({
      verdict: "challenge",
    });
  });

  const completed = {
    ...handled,
    recipe: {
      ...handled.recipe,
      completion: [{ target: { by: "id" as const, value: "logout" } }],
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
    expect(
      await h.generation.generate({ ...request, slots: [...request.slots, totp] }),
    ).toMatchObject({ outcome: "recipe" });
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
    expect(await h.generation.generate(withCode)).toMatchObject({ outcome: "recipe" });
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

describe("continuing a recipe after its final advance (ADR 0018)", () => {
  const base = { recipeId: recipeChange.recipeId, revision: 1 };
  // The password page, sent with the revision it continues.
  const continuation: RecipeGenerationRequest = { ...request, base };
  const continued = {
    ...recipeChange,
    revision: 2,
    recipe: { ...recipeChange.recipe, revision: 2 },
  };

  it("returns the continued recipe after pulling recipes only", async () => {
    const h = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: continued },
    });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "recipe",
      recipe: continued.recipe,
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      continuation,
    );
    // A full sync could write settings and stop the login it belongs to.
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("claims the page under the revision it continues, not its path alone", async () => {
    const h = setup();
    // The first page of the path was sent today; its continuation is a separate claim.
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "skipped",
      reason: "sent",
    });
    // A later revision of the recipe is a new claim; the path's own claim stays.
    expect(
      await h.generation.generate({ ...continuation, base: { ...base, revision: 2 } }),
    ).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
    h.advance(GENERATION_RETRY_MS);
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
  });

  it.each(["recipe-revoked", "recipe-conflict"] as const)(
    "spends a continuation answered %s, which a later document would get again",
    async (reason) => {
      const h = setup({
        kind: "result",
        result: { version: 1, status: "unavailable", reason },
      });
      expect(await h.generation.generate(continuation)).toEqual({
        outcome: "unavailable",
        reason,
      });
      // A recipe's first page with the same answer stays free to send again.
      expect(await h.generation.generate(request)).toEqual({
        outcome: "unavailable",
        reason,
        retry: true,
      });
    },
  );
});

describe("continuation claims and answers, probed independently (ADR 0018)", () => {
  const base = { recipeId: recipeChange.recipeId, revision: 1 };
  const continuation: RecipeGenerationRequest = { ...request, base };
  const answerOf = (revision: number) => ({
    kind: "result" as const,
    result: {
      version: 1 as const,
      status: "recipe" as const,
      change: { ...recipeChange, revision, recipe: { ...recipeChange.recipe, revision } },
    },
  });
  const sent = { outcome: "skipped", reason: "sent" };

  it("keeps a continuation's claim apart from the first page's on the same path", async () => {
    const h = setup(answerOf(2));
    // The continuation first: the path's first page is still free, and the reverse.
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    // Each claim holds on its own.
    expect(await h.generation.generate(continuation)).toEqual(sent);
    expect(await h.generation.generate(request)).toEqual(sent);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
  });

  it("returns the current recipe the service answers for a stale base, pulling recipes only", async () => {
    // Another device continued revision 1 first; the service answers with its revision 3.
    const h = setup(answerOf(3));
    const answer = await h.generation.generate(continuation);
    expect(answer).toEqual({ outcome: "recipe", recipe: answerOf(3).result.change.recipe });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("keys the claim by recipe as well as revision and path", async () => {
    const h = setup(answerOf(2));
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    const otherRecipe = {
      ...continuation,
      base: { recipeId: `gen-${"f".repeat(32)}`, revision: 1 },
    };
    expect(await h.generation.generate(otherRecipe)).toMatchObject({ outcome: "recipe" });
    const otherPath = {
      ...continuation,
      observation: { ...observation, path: "/login/password" },
    };
    expect(await h.generation.generate(otherPath)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });

  it("frees only the continuation's claim, never the first page's", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    h.transport.generateRecipe.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "unavailable", reason: "busy" },
    });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "unavailable",
      reason: "busy",
      retry: true,
    });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(await h.generation.generate(request)).toEqual(sent);
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });

  type Answer = Awaited<ReturnType<ServiceTransport["generateRecipe"]>>;
  // Nothing in these answers shows the model was called, so the claim is freed (#261).
  it.each<[string, Answer, string, string]>([
    [
      "an incomplete observation",
      { kind: "result", result: { version: 1, status: "failed", error: "incomplete-observation" } },
      "failed",
      "incomplete-observation",
    ],
    [
      "an invalid request",
      { kind: "result", result: { version: 1, status: "failed", error: "invalid-request" } },
      "failed",
      "invalid-request",
    ],
    [
      "an unexpected transport answer",
      { kind: "failed", error: "unexpected-response" },
      "failed",
      "unexpected-response",
    ],
    [
      "the service's request limit",
      { kind: "failed", error: "rate-limited" },
      "failed",
      "rate-limited",
    ],
    [
      "the monthly limit",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "monthly-limit" } },
      "unavailable",
      "monthly-limit",
    ],
    [
      "the service's own recently-tried",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "recently-tried" } },
      "unavailable",
      "recently-tried",
    ],
    ["a rejected device", { kind: "rejected" }, "failed", "device-rejected"],
    [
      "the daily limit",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "daily-limit" } },
      "unavailable",
      "daily-limit",
    ],
  ])("frees the claim and asks for a retry after %s", async (_n, answer, outcome, reason) => {
    const h = setup(answer);
    expect(await h.generation.generate(continuation)).toEqual({ outcome, reason, retry: true });
    expect(await h.generation.generate(continuation)).toEqual({ outcome, reason, retry: true });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("asks for a retry with a rejected device connection and claims nothing", async () => {
    const h = setup(answerOf(2));
    h.service.connection.mockResolvedValueOnce({ ...connection, rejected: true });
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "skipped",
      reason: "not-connected",
      retry: true,
    });
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
  });

  // These answers show the model was called: the claim is kept, with no retry.
  it.each<[string, Answer, string, string]>([
    [
      "the model refusing",
      { kind: "result", result: { version: 1, status: "failed", error: "refused" } },
      "failed",
      "refused",
    ],
    [
      "a truncated answer",
      { kind: "result", result: { version: 1, status: "failed", error: "truncated" } },
      "failed",
      "truncated",
    ],
    [
      "a provider error",
      { kind: "result", result: { version: 1, status: "failed", error: "provider-error" } },
      "failed",
      "provider-error",
    ],
    [
      "an invalid recipe",
      { kind: "result", result: { version: 1, status: "failed", error: "recipe-invalid" } },
      "failed",
      "recipe-invalid",
    ],
    [
      "an abstention",
      { kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } },
      "abstained",
      "ambiguous",
    ],
  ])("keeps the claim after %s", async (_name, answer, outcome, reason) => {
    const h = setup(answer);
    expect(await h.generation.generate(continuation)).toEqual({ outcome, reason });
    expect(await h.generation.generate(continuation)).toEqual(sent);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("never syncs for a continuation, and still answers when the refresh fails", async () => {
    const h = setup(answerOf(2));
    h.refresh.mockRejectedValueOnce(new Error("offline"));
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    for (const answer of [
      { kind: "failed", error: "unreachable" },
      { kind: "rejected" },
      { kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } },
    ] as const) {
      h.transport.generateRecipe.mockResolvedValueOnce(answer);
      // One answer per request, in order.
      // eslint-disable-next-line no-await-in-loop
      await h.generation.generate({ ...continuation, base: { ...base, revision: 5 } });
    }
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // A first page still syncs in full.
    await h.generation.generate(request);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("stores the claim with its base, sending while in flight and sent once answered", async () => {
    const h = setup();
    let answer!: (value: Answer) => void;
    h.transport.generateRecipe.mockReturnValueOnce(
      new Promise<Answer>((resolve) => (answer = resolve)),
    );
    const pending = h.generation.generate(continuation);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1));
    expect(h.storage.write).toHaveBeenLastCalledWith({
      version: 1,
      attempts: [
        {
          origin: observation.origin,
          path: "/login",
          base,
          state: "sending",
          at: expect.any(Number),
        },
      ],
    });
    answer({ kind: "result", result: { version: 1, status: "abstained", reason: "ambiguous" } });
    expect(await pending).toEqual({ outcome: "abstained", reason: "ambiguous" });
    expect(h.storage.write).toHaveBeenLastCalledWith({
      version: 1,
      attempts: [
        { origin: observation.origin, path: "/login", base, state: "sent", at: expect.any(Number) },
      ],
    });
  });

  it("frees a continuation claim whose request was lost after two minutes", async () => {
    const h = setup(answerOf(2));
    // The worker that sent it stopped: its request never answers.
    h.transport.generateRecipe.mockReturnValueOnce(new Promise(() => undefined));
    void h.generation.generate(continuation);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1));
    h.advance(GENERATION_SENDING_MS - 1);
    expect(await h.generation.generate(continuation)).toEqual({
      outcome: "skipped",
      reason: "sending",
      retry: true,
    });
    h.advance(1);
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
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
      generateEntry: vi.fn<ServiceTransport["generateEntry"]>(),
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
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
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
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.slotStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("keeps nothing in memory that it could not write, and still reports the recipe", async () => {
    const h = slotSetup({ failWrite: true });
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
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
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
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
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
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
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
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
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.order).toEqual(["sync"]);
    expect(h.slotStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.slotFields(idOf(5))).toEqual(other.slots);
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("replaces stored maps that do not parse, since no older format is kept", async () => {
    const h = slotSetup({ stored: { version: 0, maps: "synthetic" } });
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.stored()).toEqual({ version: 1, maps: [ownMap(recipeId, mapped)] });
  });
});

describe("signed-in page samples (ADR 0029, owner 2026-10-18 08:05 UTC)", () => {
  const recipeId = "gen-0123456789abcdef0123456789abcdef";
  const signedIn: LoginObservation = { ...observation, path: "/home", candidates: [] };
  const sample = { recipeId, revision: 2, route: "password" as const };
  function sampleSetup(paired = true) {
    let stored: unknown;
    let now = 5_000_000_000;
    const order: string[] = [];
    const sampleStorage = {
      read: vi.fn(async () => structuredClone(stored)),
      write: vi.fn(async (value: unknown) => {
        order.push("record");
        stored = structuredClone(value);
      }),
    };
    const samplePage = vi.fn<ServiceTransport["samplePage"]>(async () => {
      order.push("send");
      return { kind: "kept" };
    });
    const generation = createLoginGeneration({
      service: { connection: async () => (paired ? connection : undefined) },
      transport: {
        generateRecipe: vi.fn(),
        generateEntry: vi.fn(),
        judgeCompletion: vi.fn(),
        samplePage,
      },
      storage: { read: async () => undefined, write: async () => undefined },
      slotStorage: { read: async () => undefined, write: async () => undefined },
      sampleStorage,
      sync: async () => "synced",
      refresh: async () => "synced",
      now: () => now,
    });
    const describePage = vi.fn(
      async (): Promise<{ observation: LoginObservation } | { unsent: string }> => ({
        observation: signedIn,
      }),
    );
    return {
      generation,
      samplePage,
      sampleStorage,
      describePage,
      order,
      stored: () => stored,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("records a sample before sending it, and sends the next only after 30 days", async () => {
    const h = sampleSetup();
    const sent = vi.fn(async () => undefined);
    expect(await h.generation.samplePage!(sample, h.describePage, sent)).toEqual({
      outcome: "kept",
    });
    expect(h.order).toEqual(["record", "send"]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(h.samplePage).toHaveBeenCalledWith(connection.origin, connection.credential, recipeId, {
      version: 1,
      revision: 2,
      route: "password",
      observation: signedIn,
    });
    expect(h.stored()).toEqual({
      version: 1,
      samples: [
        { service: connection.origin, deviceId: connection.deviceId, recipeId, at: 5_000_000_000 },
      ],
    });
    // Within 30 days the page is not even described.
    h.advance(PAGE_SAMPLE_INTERVAL_MS - 1);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "not-due" });
    expect(h.describePage).toHaveBeenCalledTimes(1);
    expect(h.samplePage).toHaveBeenCalledTimes(1);
    // Another branch of a chooser is sampled on its own.
    expect(
      await h.generation.samplePage!({ ...sample, branch: "account" }, h.describePage),
    ).toEqual({
      outcome: "kept",
    });
    expect(h.samplePage.mock.calls[1]![3]).toMatchObject({ branch: "account" });
    h.advance(1);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
    expect(h.samplePage).toHaveBeenCalledTimes(3);
    // Expired samples are dropped when the next is recorded.
    expect(
      (h.stored() as { samples: { branch?: string }[] }).samples.map((entry) => entry.branch),
    ).toEqual(["account", undefined]);
  });

  it("sends nothing and describes nothing without a paired service", async () => {
    const h = sampleSetup(false);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "not-due",
      reason: "not-connected",
    });
    expect(h.describePage).not.toHaveBeenCalled();
    expect(h.sampleStorage.read).not.toHaveBeenCalled();
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("records nothing for a page that could not be described, so a later login may send it", async () => {
    const h = sampleSetup();
    h.describePage.mockResolvedValueOnce({ unsent: "incomplete" });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "not-sent",
      reason: "incomplete",
    });
    expect(h.sampleStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
  });

  it("never sends a sample it could not record", async () => {
    const h = sampleSetup();
    h.sampleStorage.write.mockRejectedValueOnce(new Error("storage"));
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "not-sent",
      reason: "storage-unavailable",
    });
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("keeps a sample recorded when its request fails, and reports the service's answers", async () => {
    const h = sampleSetup();
    h.samplePage.mockResolvedValueOnce({ kind: "failed", error: "unreachable" });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({
      outcome: "failed",
      reason: "unreachable",
    });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "not-due" });
    h.samplePage.mockResolvedValueOnce({ kind: "recent" });
    expect(await h.generation.samplePage!({ ...sample, branch: "other" }, h.describePage)).toEqual({
      outcome: "recent",
    });
    h.samplePage.mockResolvedValueOnce({ kind: "rejected" });
    expect(
      await h.generation.samplePage!({ ...sample, branch: "account" }, h.describePage),
    ).toEqual({
      outcome: "failed",
      reason: "device-rejected",
    });
    h.samplePage.mockResolvedValueOnce({ kind: "gone" });
    expect(
      await h.generation.samplePage!({ ...sample, recipeId: `${recipeId}0` }, h.describePage),
    ).toEqual({ outcome: "gone" });
    h.samplePage.mockResolvedValueOnce({ kind: "refused" });
    expect(
      await h.generation.samplePage!({ ...sample, recipeId: `${recipeId}1` }, h.describePage),
    ).toEqual({ outcome: "refused" });
  });

  it("stops a recorded sample that the last check before sending refuses", async () => {
    const h = sampleSetup();
    // The site was excluded while the page was described and the sample recorded.
    const sending = vi.fn(async () => "site-excluded");
    expect(await h.generation.samplePage!(sample, h.describePage, sending)).toEqual({
      outcome: "not-sent",
      reason: "site-excluded",
    });
    expect(h.order).toEqual(["record"]);
    expect(h.samplePage).not.toHaveBeenCalled();
    // The record stays, so the recipe is not sampled again within 30 days.
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "not-due" });
    // A check that fails stops it as well.
    const failing = vi.fn(async (): Promise<string | undefined> => {
      throw new Error("synthetic settings failure");
    });
    expect(
      await h.generation.samplePage!({ ...sample, branch: "account" }, h.describePage, failing),
    ).toEqual({ outcome: "not-sent", reason: "settings-unavailable" });
    expect(h.samplePage).not.toHaveBeenCalled();
  });

  it("sends one of two samples of a recipe asked for at once", async () => {
    const h = sampleSetup();
    const answers = await Promise.all([
      h.generation.samplePage!(sample, h.describePage),
      h.generation.samplePage!(sample, h.describePage),
    ]);
    // Both were due and described; the second found the first's record when it claimed.
    expect(h.describePage).toHaveBeenCalledTimes(2);
    expect(answers).toEqual([{ outcome: "kept" }, { outcome: "not-due" }]);
    expect(h.samplePage).toHaveBeenCalledTimes(1);
    expect((h.stored() as { samples: unknown[] }).samples).toHaveLength(1);
  });

  it("keeps samples apart per service and device, and at most 200 of them", async () => {
    const h = sampleSetup();
    const ids = Array.from(
      { length: MAX_PAGE_SAMPLES },
      (_, index) => `gen-${index.toString(16).padStart(32, "0")}`,
    );
    for (const id of ids)
      // eslint-disable-next-line no-await-in-loop
      await h.generation.samplePage!({ ...sample, recipeId: id }, h.describePage);
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
    const samples = (h.stored() as { samples: { recipeId: string }[] }).samples;
    expect(samples).toHaveLength(MAX_PAGE_SAMPLES);
    expect(samples[0]!.recipeId).toBe(ids[1]);
    expect(samples.at(-1)!.recipeId).toBe(recipeId);
    // A sample another device of the service recorded does not count for this one.
    const stored = h.stored() as { version: 1; samples: Record<string, unknown>[] };
    h.sampleStorage.read.mockResolvedValue({
      version: 1,
      samples: stored.samples.map((entry) => ({ ...entry, deviceId: "another-device" })),
    });
    expect(await h.generation.samplePage!(sample, h.describePage)).toEqual({ outcome: "kept" });
  });
});
