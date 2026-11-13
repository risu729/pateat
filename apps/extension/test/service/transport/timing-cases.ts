import { expect, it, vi } from "vitest";
import {
  addTimings,
  createServiceTransport,
  serverTimings,
  serviceTiming,
} from "../../../src/service/transport";
import type { TimingContext } from "./context";

export function registerTimingCases({ ORIGIN, CREDENTIAL }: TimingContext) {
  const request = {
    version: 1 as const,
    observation: {
      version: 1 as const,
      origin: "https://shop.example",
      path: "/login",
      language: "en" as const,
      complete: true,
      candidates: [
        { id: "c1", role: "password" as const, target: { by: "id" as const, value: "pw" } },
      ],
    },
    slots: [{ id: "password", kind: "secret" as const, description: "account password" }],
  };

  it("reads the service's metrics by name among other entries", () => {
    expect(
      serverTimings(
        'cfL4;desc="?proto=TCP&rtt=1234,min_rtt=1;x=2", token;dur=310, model;dur=2420.6, ' +
          'total;desc="Total Response Time";dur=2890.4, total;dur=1',
      ),
    ).toEqual(
      new Map([
        ["token", 310],
        ["model", 2421],
        ["total", 2890],
      ]),
    );
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["a metric without a duration", "total"],
    ["a duration that is not a number", "total;dur=soon"],
    ["a negative duration", "total;dur=-5"],
    ["a duration only inside a description", 'total;desc="dur=5"'],
    ["a duration longer than a day", "total;dur=86400001"],
    ["a duration too long to be a number", `total;dur=${"9".repeat(400)}`],
  ])("knows no service time from %s", (_, header) => {
    expect(serviceTiming(1200, header)).toEqual({ roundTripMs: 1200 });
  });

  it("takes the network part as the round trip less the service's time, never below 0", () => {
    expect(serviceTiming(3000.4, "total;dur=2500, token;dur=300, model;dur=2000")).toEqual({
      roundTripMs: 3000,
      serverMs: 2500,
      networkMs: 500,
      tokenMs: 300,
      modelMs: 2000,
    });
    expect(serviceTiming(100, "total;dur=150")).toEqual({
      roundTripMs: 100,
      serverMs: 150,
      networkMs: 0,
    });
  });

  it("adds up requests, with the service's time only when each had it", () => {
    const answered = { roundTripMs: 300, serverMs: 100, networkMs: 200, modelMs: 50 };
    expect(addTimings(undefined, undefined)).toBeUndefined();
    expect(addTimings(undefined, answered)).toBe(answered);
    expect(addTimings(answered, { roundTripMs: 200, serverMs: 50, networkMs: 150 })).toEqual({
      roundTripMs: 500,
      serverMs: 150,
      networkMs: 350,
    });
    expect(addTimings(answered, { roundTripMs: 200 })).toEqual({ roundTripMs: 500 });
  });

  it("measures from before the request until its body is read", async () => {
    let clock = 1_000;
    const body = JSON.stringify({ version: 1, status: "abstained", reason: "no-login-form" });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      clock = 1_400;
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            // The body arrives later than the headers.
            clock = 3_500;
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Server-Timing": "total;dur=2000, token;dur=300, model;dur=1500" },
        },
      );
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    });
    const transport = createServiceTransport({ fetch, now: () => clock });
    expect(await transport.generateRecipe(ORIGIN, CREDENTIAL, request)).toEqual({
      kind: "result",
      result: JSON.parse(body),
      timing: { roundTripMs: 2_500, serverMs: 2_000, networkMs: 500, tokenMs: 300, modelMs: 1_500 },
    });
  });

  it("times every answer of a sync and judge request, and one that never came", async () => {
    let clock = 0;
    const timed = (status: number, body: unknown, header?: string) =>
      vi.fn<typeof globalThis.fetch>(async (input) => {
        clock += 250;
        const response = new Response(JSON.stringify(body), {
          status,
          ...(header ? { headers: { "Server-Timing": header } } : {}),
        });
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
      });
    const page = { version: 1, changes: [], cursor: 3, complete: true };
    expect(
      await createServiceTransport({
        fetch: timed(200, page, "total;dur=100"),
        now: () => clock,
      }).recipeChanges(ORIGIN, CREDENTIAL, 3),
    ).toEqual({ kind: "page", page, timing: { roundTripMs: 250, serverMs: 100, networkMs: 150 } });
    expect(
      await createServiceTransport({
        fetch: timed(429, { error: "rate_limited" }),
        now: () => clock,
      }).settings(ORIGIN, CREDENTIAL),
    ).toEqual({ kind: "failed", error: "rate-limited", timing: { roundTripMs: 250 } });
    expect(
      await createServiceTransport({
        fetch: timed(401, { error: "device_revoked" }, "total;dur=20"),
        now: () => clock,
      }).judgeCompletion(ORIGIN, CREDENTIAL, "gen-0123456789abcdef0123456789abcdef", {
        version: 1,
        revision: 1,
        route: "password",
        branch: "1760000000000",
        observation: request.observation,
        slots: [],
      }),
    ).toEqual({ kind: "rejected", timing: { roundTripMs: 250, serverMs: 20, networkMs: 230 } });
    const unreachable = vi.fn<typeof globalThis.fetch>(async () => {
      clock += 40;
      throw new TypeError("Failed to fetch");
    });
    expect(
      await createServiceTransport({ fetch: unreachable, now: () => clock }).generateRecipe(
        ORIGIN,
        CREDENTIAL,
        request,
      ),
    ).toEqual({ kind: "failed", error: "unreachable", timing: { roundTripMs: 40 } });
  });
}
