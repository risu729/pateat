import { expect, it, vi } from "vitest";
import type { TransportTestContext } from "../../../src/service/transport.test";
import { createServiceTransport, type ServiceTransport } from "../../../src/service/transport";

type PairContext = Pick<TransportTestContext, "ORIGIN" | "respond"> & {
  LABEL: string;
  PROFILE: { id: string; name: string };
  issued: { version: number; deviceId: string; credential: string };
  pair: (
    fetch: typeof globalThis.fetch,
    timeoutMs?: number,
  ) => ReturnType<ServiceTransport["pair"]>;
  json: (status: number, body: unknown) => ReturnType<TransportTestContext["respond"]>;
};

export function registerPairRequestCases({
  ORIGIN,
  respond,
  LABEL,
  PROFILE,
  issued,
  pair,
  json,
}: PairContext) {
  it("posts only the label with the browser's session and no credential", async () => {
    const fetch = json(201, issued);
    expect(await pair(fetch)).toEqual({ kind: "issued", result: issued });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/pair`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "include",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(init!.headers).toEqual({
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    });
    expect(JSON.parse(init!.body as string)).toEqual({ version: 1, label: LABEL });
  });

  it("sends the chosen profile or the new profile's name", async () => {
    const fetch = json(201, issued);
    const transport = createServiceTransport({ fetch });
    await transport.pair(ORIGIN, LABEL, { profileId: PROFILE.id });
    await transport.pair(ORIGIN, LABEL, { newProfile: "Agent browser" });
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
      { version: 1, label: LABEL, profileId: PROFILE.id },
      { version: 1, label: LABEL, newProfile: "Agent browser" },
    ]);
  });

  it("accepts JSON with a charset", async () => {
    const fetch = respond(201, issued, {
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
    expect(await pair(fetch)).toEqual({ kind: "issued", result: issued });
  });

  it.each([
    ["a malformed credential", { version: 1, deviceId: "x", credential: "y" }],
    ["an extra field", { ...issued, owner: "x" }],
  ])("rejects %s", async (_, body) => {
    expect(await pair(json(201, body))).toEqual({ kind: "failed", error: "unexpected-response" });
  });

  it("asks for a sign-in on Access's redirect without reading it", async () => {
    // A synthetic stand-in: Chrome's `redirect: "manual"` answer has type
    // "opaqueredirect", status 0, no headers and no body.
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (input) =>
        ({
          type: "opaqueredirect",
          status: 0,
          ok: false,
          redirected: false,
          url: String(input),
          headers: new Headers(),
          body: null,
        }) as Response,
    );
    expect(await pair(fetch)).toEqual({ kind: "sign-in-needed" });
  });
}

export function registerPairResponseCases({
  respond,
  PROFILE,
  issued,
  pair,
  json,
  page,
}: Pick<PairContext, "respond" | "PROFILE" | "issued" | "pair" | "json"> & {
  page: (
    status: number,
    body: string,
    type: string | undefined,
  ) => ReturnType<TransportTestContext["respond"]>;
}) {
  it.each([
    ["an HTML login page", 200, "<!doctype html><title>Sign in</title>", "text/html"],
    ["an HTML 401 page", 401, "<!doctype html><title>Sign in</title>", "text/html"],
    ["an HTML denial page", 403, "<!doctype html><title>Forbidden</title>", "text/html"],
    ["a body without a media type", 200, JSON.stringify(issued), undefined],
  ])("asks for a sign-in on %s", async (_, status, body, type) => {
    expect(await pair(page(status, body, type))).toEqual({ kind: "sign-in-needed" });
  });

  it.each([
    ["an edge rate-limit page", 429, "rate-limited"],
    ["an edge server error page", 500, "unexpected-response"],
    ["an edge bad gateway page", 502, "unexpected-response"],
    ["an edge unavailable page", 503, "unexpected-response"],
    ["an edge timeout page", 524, "unexpected-response"],
  ] as const)("does not ask for a sign-in on %s", async (_, status, error) => {
    const fetch = page(status, "<!doctype html><title>Error</title>", "text/html; charset=UTF-8");
    expect(await pair(fetch)).toEqual({ kind: "failed", error });
  });

  it.each([
    ["the Worker's 401", 401, { error: "unauthorized" }, { kind: "sign-in-needed" }],
    [
      "a rejected sign-in",
      403,
      { error: "forbidden" },
      { kind: "failed", error: "sign-in-rejected" },
    ],
    [
      "an unlisted extension",
      403,
      { error: "extension_not_allowed" },
      { kind: "failed", error: "extension-not-allowed" },
    ],
    [
      "missing pairing settings",
      503,
      { error: "pairing_unavailable" },
      { kind: "failed", error: "pairing-unavailable" },
    ],
    [
      "missing Access settings",
      503,
      { error: "access_unavailable" },
      { kind: "failed", error: "pairing-unavailable" },
    ],
    [
      "unavailable Access signing keys",
      503,
      { error: "access_keys_unavailable" },
      { kind: "failed", error: "access-keys-unavailable" },
    ],
    ["a rate limit", 429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
    [
      "a missing profile choice",
      409,
      { error: "profile_required", profiles: [PROFILE] },
      { kind: "profile", error: "profile-required", profiles: [PROFILE] },
    ],
    [
      "a deleted profile",
      404,
      { error: "profile_not_found", profiles: [PROFILE] },
      { kind: "profile", error: "profile-not-found", profiles: [PROFILE] },
    ],
    [
      "a taken profile name",
      409,
      { error: "profile_name_taken", profiles: [PROFILE] },
      { kind: "profile", error: "profile-name-taken", profiles: [PROFILE] },
    ],
    [
      "a profile choice without profiles",
      409,
      { error: "profile_required" },
      { kind: "failed", error: "unexpected-response" },
    ],
    ["an unknown 403", 403, { error: "other" }, { kind: "failed", error: "unexpected-response" }],
    [
      "a bad request",
      400,
      { error: "bad_request" },
      { kind: "failed", error: "unexpected-response" },
    ],
    ["a 200 answer", 200, issued, { kind: "failed", error: "unexpected-response" }],
    [
      "a server error",
      500,
      { error: "internal_error" },
      { kind: "failed", error: "unexpected-response" },
    ],
  ])("maps %s", async (_, status, body, expected) => {
    expect(await pair(json(status, body))).toEqual(expected);
  });

  it("refuses redirected, oversized and unparsable answers", async () => {
    const redirected = vi.fn<typeof globalThis.fetch>(async () => {
      const response = Response.json(issued, { status: 201 });
      Object.defineProperty(response, "url", { value: "https://elsewhere.example.com/pair" });
      return response;
    });
    expect(await pair(redirected)).toEqual({ kind: "failed", error: "unexpected-response" });
    const huge = json(201, `"${"x".repeat(20_000)}"`);
    expect(await pair(huge)).toEqual({ kind: "failed", error: "unexpected-response" });
    const broken = respond(201, "{", { headers: { "Content-Type": "application/json" } });
    expect(await pair(broken)).toEqual({ kind: "failed", error: "unexpected-response" });
  });

  it("reports network failures and timeouts as unreachable", async () => {
    const offline = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await pair(offline)).toEqual({ kind: "failed", error: "unreachable" });
    const hanging = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    );
    expect(await pair(hanging, 10)).toEqual({ kind: "failed", error: "unreachable" });
  });
}
