import type { LoginObservation, RecipeGenerationRequest } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createLoginGeneration, GENERATION_RETRY_MS } from "./generation";
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
  const generation = createLoginGeneration({
    service,
    transport,
    storage,
    sync,
    now: () => now,
  });
  return {
    generation,
    transport,
    service,
    storage,
    sync,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("recipe generation requests", () => {
  it("sends a page once a day and refreshes the cache before reporting a recipe", async () => {
    const h = setup();
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
    expect(await h.generation.generate(request)).toBe("recipe");
    expect(h.transport.generateRecipe).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      request,
    );
    expect(h.sync).toHaveBeenCalledTimes(1);

    // The same page is not sent again within a day, whatever came of it; another path is.
    expect(await h.generation.available(observation.origin, "/login")).toBe(false);
    expect(await h.generation.generate(request)).toBe("none");
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
    expect(
      await Promise.all([h.generation.generate(request), h.generation.generate(request)]),
    ).toEqual(["none", "none"]);
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it.each([
    ["an unreachable service", { kind: "failed", error: "unreachable" }],
    ["the service's request limit", { kind: "failed", error: "rate-limited" }],
    [
      "a busy owner",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "busy" } },
    ],
  ] as const)("may send the page again after %s", async (_name, answer) => {
    const h = setup(answer);
    expect(await h.generation.generate(request)).toBe("none");
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
  });

  it.each([
    ["a timeout", { kind: "failed", error: "timeout" }],
    ["an unexpected answer", { kind: "failed", error: "unexpected-response" }],
  ] as const)(
    "keeps the page claimed after %s, which may follow a model call",
    async (_name, answer) => {
      const h = setup(answer);
      expect(await h.generation.generate(request)).toBe("none");
      expect(await h.generation.available(observation.origin, "/login")).toBe(false);
    },
  );

  it("sends nothing without a paired, accepted device or when it cannot remember", async () => {
    const h = setup();
    h.service.connection.mockResolvedValueOnce(undefined);
    expect(await h.generation.available(observation.origin, "/login")).toBe(false);
    h.service.connection.mockResolvedValueOnce({ ...connection, rejected: true });
    expect(await h.generation.generate(request)).toBe("none");
    h.storage.write.mockRejectedValueOnce(new Error("quota"));
    expect(await h.generation.generate(request)).toBe("none");
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
    await vi.waitFor(() => expect(h.sync).toHaveBeenCalledTimes(1));
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
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", home)).toEqual({
      verdict: "unclear",
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

  it("waits for the cache before handing a judged handler's recipe to the login", async () => {
    const h = setup();
    let synced!: () => void;
    h.sync.mockImplementationOnce(
      () => new Promise<string>((resolve) => (synced = () => resolve("synced"))),
    );
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: handled },
    });
    let settled = false;
    const judged = h.generation
      .judge(recipeChange.recipeId, 1, "password", webauthn)
      .finally(() => (settled = true));
    await vi.waitFor(() => expect(h.sync).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);
    synced();
    expect(await judged).toEqual({ verdict: "challenge", recipe: handled.recipe });
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, route: "password", observation: webauthn },
    );
    // A failed refresh still hands the recipe over; the login checks it before use.
    h.sync.mockRejectedValueOnce(new Error("offline"));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge", change: handled },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, "password", webauthn)).toEqual({
      verdict: "challenge",
      recipe: handled.recipe,
    });
  });

  it("answers signed-in without a change and does not wait for the cache", async () => {
    const h = setup();
    h.sync.mockImplementationOnce(() => new Promise<string>(() => {}));
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
      });
    }
  });

  it("offers the TOTP slot only for a page with a code field", async () => {
    const h = setup();
    expect(await h.generation.generate({ ...request, slots: [...request.slots, totp] })).toBe(
      "recipe",
    );
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
    expect(await h.generation.generate(withCode)).toBe("recipe");
    expect(h.transport.generateRecipe).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      withCode,
    );
  });

  it("sends no request whose only slot is a TOTP the page has no field for", async () => {
    const h = setup();
    expect(await h.generation.generate({ ...request, slots: [totp] })).toBe("none");
    expect(h.transport.generateRecipe).not.toHaveBeenCalled();
  });
});
