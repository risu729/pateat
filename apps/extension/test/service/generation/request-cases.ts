import { expect, it, vi } from "vitest";
import {
  GENERATION_RETRY_MS,
  createLoginGeneration,
  GENERATION_SENDING_MS,
} from "../../../src/service/generation";
import type { ServiceGenerationTestContext } from "./context";
import { type ServiceTransport } from "../../../src/service/transport";

export function registerRequestClaimCases({
  connection,
  observation,
  request,
  KEY,
  chooserOf,
  runs,
  recipeChange,
  entryChange,
  entryRequest,
  setup,
}: Pick<
  ServiceGenerationTestContext,
  | "connection"
  | "observation"
  | "request"
  | "KEY"
  | "chooserOf"
  | "runs"
  | "recipeChange"
  | "entryChange"
  | "entryRequest"
  | "setup"
>) {
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

  it("claims a page replacing a final advance click apart, keeping the other claims (ADR 0018)", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    const base = { recipeId: recipeChange.recipeId, revision: 1 };
    const replacing = { ...request, base: { ...base, replacesLast: true as const }, branch: KEY };
    expect(await h.generation.generate(replacing)).toMatchObject({ outcome: "recipe" });
    // The store still reads: the first page's claim holds, and so does the replacement's.
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(await h.generation.generate(request)).toEqual({ outcome: "skipped", reason: "sent" });
    expect(await h.generation.generate(replacing)).toEqual({ outcome: "skipped", reason: "sent" });
    // A continuation of the same revision is claimed apart from the replacement.
    expect(await h.generation.generate({ ...request, base, branch: KEY })).toMatchObject({
      outcome: "recipe",
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });

  it("takes a chooser recipe (ADR 0028) as the answer to a list of accounts only", async () => {
    const runsChooser = {
      version: 1 as const,
      id: recipeChange.recipeId,
      revision: 1,
      origin: observation.origin,
      chooser: { path: "/login", other: { by: "text" as const, value: "Use another" } },
    };
    const chooser = { ...recipeChange, recipe: chooserOf(runsChooser) };
    // A list is sent without slots (owner 2026-10-23 11:48 UTC), never skipped for that.
    const list = {
      ...request,
      observation: { ...observation, accounts: ["[email]"] },
      slots: [] as [],
    };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    // The login runs the chooser's newest layout, which the list's page created (ADR 0060).
    expect(await h.generation.generate(list)).toEqual({
      outcome: "recipe",
      recipe: { ...runsChooser, layout: KEY },
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      list,
    );
    expect(h.sync).toHaveBeenCalled();
    // A route recipe never answers a list.
    const routed = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
    });
    expect(await routed.generation.generate(list)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
  });

  it("takes a chooser recipe (ADR 0028) as the answer to a branch's page, claimed per branch", async () => {
    const runsChooser = {
      version: 1 as const,
      id: recipeChange.recipeId,
      revision: 2,
      origin: observation.origin,
      layout: KEY,
      chooser: {
        path: "/login",
        other: { by: "text" as const, value: "Use another" },
        afterAccount: { ...runs, revision: 2 },
      },
    };
    const chooser = { ...recipeChange, revision: 2, recipe: chooserOf(runsChooser) };
    const h = setup({ kind: "result", result: { version: 1, status: "recipe", change: chooser } });
    const base = { recipeId: recipeChange.recipeId, revision: 1 };
    // The branch names the chooser's layout it continues (ADR 0060).
    const account = { ...request, base, branch: `${KEY}:account` };
    expect(await h.generation.generate(account)).toEqual({
      outcome: "recipe",
      recipe: runsChooser,
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
    expect(await h.generation.available(observation.origin, "/login", base, `${KEY}:account`)).toBe(
      "sent",
    );
    expect(await h.generation.available(observation.origin, "/login", base, `${KEY}:other`)).toBe(
      true,
    );
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate({ ...account, branch: `${KEY}:other` })).toMatchObject({
      outcome: "recipe",
    });
    expect(await h.generation.available(observation.origin, "/login", base, `${KEY}:other`)).toBe(
      "sent",
    );
    // A layout the chooser does not hold is no answer.
    const elsewhere = setup({
      kind: "result",
      result: { version: 1, status: "recipe", change: chooser },
    });
    expect(await elsewhere.generation.generate({ ...account, branch: "1:account" })).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
    // A route recipe never answers a branch's page.
    const routed = setup();
    expect(await routed.generation.generate(account)).toEqual({
      outcome: "unavailable",
      reason: "recipe-conflict",
    });
  });

  it("takes no chooser recipe (ADR 0028) as the answer to a form page", async () => {
    const chooser = {
      ...recipeChange,
      recipe: chooserOf({
        version: 1 as const,
        id: recipeChange.recipeId,
        revision: 1,
        origin: observation.origin,
        chooser: { path: "/login" },
      }),
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
}

export function registerRequestReleaseCases({
  connection,
  observation,
  request,
  KEY,
  storedOf,
  route,
  recipeChange,
  setup,
  freed,
}: Pick<
  ServiceGenerationTestContext,
  | "connection"
  | "observation"
  | "request"
  | "KEY"
  | "storedOf"
  | "route"
  | "recipeChange"
  | "setup"
  | "freed"
>) {
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

  it("sends no judgement for a login without a layout (ADR 0060)", async () => {
    const h = setup();
    const home = { ...observation, path: "/home" };
    // The service judges the route of the layout the login ran.
    expect(await h.raw.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "unclear",
      reason: "no-layout",
    });
    expect(
      await h.raw.judge(recipeChange.recipeId, 1, "password", home, undefined, "account"),
    ).toEqual({ verdict: "unclear", reason: "no-layout" });
    expect(h.transport.judgeCompletion).not.toHaveBeenCalled();
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
          recipe: storedOf({
            ...route,
            revision: 2,
            completion: [{ target: { by: "id" as const, value: "logout" } }],
          }),
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
      { version: 1, revision: 1, route: "password", branch: KEY, observation: home, slots: [] },
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
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: home,
        slots: [],
        partial: true,
      },
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
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: home,
        slots: [],
        stop: true,
      },
    );
    // So does a page beside the sign-in form (ADR 0061).
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
      undefined,
      [],
      true,
    );
    expect(h.transport.judgeCompletion).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      {
        version: 1,
        revision: 1,
        route: "password",
        branch: KEY,
        observation: home,
        slots: [],
        beside: true,
      },
    );
  });
}

export function registerRequestRefusalCases({
  observation,
  recipeChange,
  setup,
  unavailable,
  failure,
}: Pick<
  ServiceGenerationTestContext,
  "observation" | "recipeChange" | "setup" | "unavailable" | "failure"
>) {
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
}
