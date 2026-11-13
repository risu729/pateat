import { expect, it, vi } from "vitest";
import { createServiceTransport } from "../../../src/service/transport";
import type { GenerationContext } from "./context";

export function registerGenerationCases({
  ORIGIN,
  CREDENTIAL,
  respond,
  untimed,
  edgeRateLimitPage,
}: GenerationContext) {
  const observation = {
    version: 1 as const,
    origin: "https://shop.example",
    path: "/login",
    language: "en" as const,
    complete: true,
    candidates: [
      { id: "c1", role: "password" as const, target: { by: "id" as const, value: "pw" } },
    ],
  };
  const request = {
    version: 1 as const,
    observation,
    slots: [{ id: "password", kind: "secret" as const, description: "account password" }],
  };
  const recipeId = "gen-0123456789abcdef0123456789abcdef";

  it("posts one page with the device credential and returns the service's answer", async () => {
    const answer = { version: 1, status: "abstained", reason: "no-login-form" };
    const fetch = respond(200, answer);
    expect(
      await untimed(createServiceTransport({ fetch }).generateRecipe(ORIGIN, CREDENTIAL, request)),
    ).toEqual({ kind: "result", result: answer });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes/generate`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { Authorization: `Bearer ${CREDENTIAL}`, "Content-Type": "application/json" },
    });
    expect(JSON.parse(init!.body as string)).toEqual(request);
  });

  it("posts the page after sign-in to the recipe's completion route", async () => {
    const fetch = respond(200, { version: 1, status: "unclear" });
    expect(
      await untimed(
        createServiceTransport({ fetch }).judgeCompletion(ORIGIN, CREDENTIAL, recipeId, {
          version: 1,
          revision: 2,
          route: "password",
          branch: "1760000000000",
          observation,
          slots: [],
        }),
      ),
    ).toEqual({ kind: "result", result: { version: 1, status: "unclear" } });
    expect(fetch.mock.calls[0]![0]).toBe(`${ORIGIN}/v1/recipes/${recipeId}/completion`);
  });

  it.each([
    ["kept", 201, { kind: "kept" }],
    ["already sampled", 204, { kind: "recent" }],
    ["a rejected device", 401, { kind: "rejected" }],
    ["a rate limit", 429, { kind: "failed", error: "rate-limited" }],
    ["a recipe revoked meanwhile", 404, { kind: "gone" }],
    ["a page the service turned away", 400, { kind: "refused" }],
    ["a server error", 500, { kind: "failed", error: "unexpected-response" }],
    ["an unexpected success", 200, { kind: "failed", error: "unexpected-response" }],
  ])(
    "posts a signed-in page sample (ADR 0029) and reports it %s",
    async (_name, status, expected) => {
      const fetch = respond(
        status,
        status === 201 || status === 204
          ? undefined
          : status === 401
            ? { error: "device_revoked" }
            : { error: "synthetic" },
      );
      const sample = {
        version: 1 as const,
        revision: 2,
        route: "password" as const,
        branch: "1760000000000",
        observation,
        slots: [] as [],
      };
      expect(
        await createServiceTransport({ fetch }).samplePage(ORIGIN, CREDENTIAL, recipeId, sample),
      ).toEqual(expected);
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe(`${ORIGIN}/v1/recipes/${recipeId}/page-sample`);
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
      expect(init!.headers).toEqual({
        Authorization: `Bearer ${CREDENTIAL}`,
        "Content-Type": "application/json",
      });
      expect(JSON.parse(init!.body as string)).toEqual(sample);
    },
  );

  it.each([
    [
      "an unknown status",
      200,
      { version: 1, status: "maybe" },
      { kind: "failed", error: "unexpected-response" },
    ],
    ["a rejected device", 401, { error: "device_revoked" }, { kind: "rejected" }],
    ["a rate limit", 429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
    [
      "a bad request",
      400,
      { error: "bad_request" },
      { kind: "failed", error: "unexpected-response" },
    ],
  ])("reports %s", async (_name, status, body, expected) => {
    expect(
      await untimed(
        createServiceTransport({ fetch: respond(status, body) }).generateRecipe(
          ORIGIN,
          CREDENTIAL,
          request,
        ),
      ),
    ).toEqual(expected);
  });

  it("reports an edge HTML 429 as rate limiting", async () => {
    expect(
      await untimed(
        createServiceTransport({ fetch: edgeRateLimitPage() }).generateRecipe(
          ORIGIN,
          CREDENTIAL,
          request,
        ),
      ),
    ).toEqual({ kind: "failed", error: "rate-limited" });
  });

  it("waits longer for the model than for other requests", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn<typeof globalThis.fetch>(
        (_input, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      );
      const pending = createServiceTransport({ fetch: hanging, timeoutMs: 1_000 }).generateRecipe(
        ORIGIN,
        CREDENTIAL,
        request,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hanging.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(89_000);
      expect(await untimed(pending)).toEqual({ kind: "failed", error: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
}
