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
    [
      "a busy owner",
      { kind: "result", result: { version: 1, status: "unavailable", reason: "busy" } },
    ],
  ] as const)("may send the page again after %s", async (_name, answer) => {
    const h = setup(answer);
    expect(await h.generation.generate(request)).toBe("none");
    expect(await h.generation.available(observation.origin, "/login")).toBe(true);
  });

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
    expect(await h.generation.judge(recipeChange.recipeId, 1, home)).toBe("signed-in");
    expect(h.transport.judgeCompletion).toHaveBeenCalledWith(
      connection.origin,
      connection.credential,
      recipeChange.recipeId,
      { version: 1, revision: 1, observation: home },
    );
    await vi.waitFor(() => expect(h.sync).toHaveBeenCalledTimes(1));
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "challenge" },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, home)).toBe("challenge");
    h.transport.judgeCompletion.mockResolvedValueOnce({
      kind: "result",
      result: { version: 1, status: "failed", error: "invalid-output" },
    });
    expect(await h.generation.judge(recipeChange.recipeId, 1, home)).toBe("unclear");
    expect(await h.generation.judge(recipeChange.recipeId, 1, home)).toBe("unclear");
  });
});
