import type { LoginObservation, RecipeGenerationRequest } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createLoginGeneration } from "./generation";
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
  signedIn: false,
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
    layouts: [
      {
        key: "1760000000000",
        createdAt: 1_760_000_000_000,
        pageKind: "sign-in" as const,
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
    ],
  },
};

function setup() {
  let stored: unknown;
  const transport = {
    generateRecipe: vi.fn<ServiceTransport["generateRecipe"]>(async () => ({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
    })),
    generateEntry: vi.fn<ServiceTransport["generateEntry"]>(),
    judgeCompletion: vi.fn<ServiceTransport["judgeCompletion"]>(
      async (): Promise<InferenceResult<never>> => ({ kind: "failed", error: "unreachable" }),
    ),
  };
  const generation = createLoginGeneration({
    service: { connection: vi.fn(async (): Promise<ServiceConnection | undefined> => connection) },
    transport,
    storage: {
      read: vi.fn(async () => structuredClone(stored)),
      write: vi.fn(async (value: unknown) => {
        stored = structuredClone(value);
      }),
    },
    slotStorage: { read: async () => undefined, write: async () => undefined },
    sync: vi.fn(async () => "synced"),
    refresh: vi.fn(async () => "synced"),
    now: () => 1_000_000,
  });
  return { generation, transport };
}

describe("one-time generation from the popup (ADR 0088)", () => {
  it("retries a sent first page while ordinary generation stays held", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(
      await h.generation.available(observation.origin, "/login", undefined, undefined, {
        manual: true,
      }),
    ).toBe(true);
    expect(await h.generation.generate({ ...request, manual: true })).toMatchObject({
      outcome: "recipe",
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
    expect(h.transport.generateRecipe.mock.calls[1]![2]).toMatchObject({ manual: true });
    expect(await h.generation.generate(request)).toEqual({ outcome: "skipped", reason: "sent" });
  });

  it("does not bypass a generation call still sending", async () => {
    const h = setup();
    const answer = Promise.withResolvers<Awaited<ReturnType<ServiceTransport["generateRecipe"]>>>();
    h.transport.generateRecipe.mockReturnValue(answer.promise);
    const first = h.generation.generate(request);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1));
    expect(
      await h.generation.available(observation.origin, "/login", undefined, undefined, {
        manual: true,
      }),
    ).toBe("sending");
    expect(await h.generation.generate({ ...request, manual: true })).toEqual({
      outcome: "skipped",
      reason: "sending",
      retry: true,
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
    answer.resolve({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
    });
    expect(await first).toMatchObject({ outcome: "recipe" });
  });
});
