import { describe, expect, it, vi } from "vitest";
import { DEVICE_TIMEOUT_MS, createServiceTransport } from "./transport";

// Synthetic responses only; no request leaves the test.

const ORIGIN = "https://pateat.example.com";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;

function respond(status: number, body?: unknown, init: ResponseInit = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const response = new Response(
      body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
      { status, ...init },
    );
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  });
}

describe("pair", () => {
  const LABEL = "Work laptop";
  const issued = {
    version: 1,
    deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
    credential: CREDENTIAL,
  };
  const pair = (fetch: typeof globalThis.fetch, timeoutMs?: number) =>
    createServiceTransport({ fetch, ...(timeoutMs ? { timeoutMs } : {}) }).pair(ORIGIN, LABEL);
  /** What the Worker answers: JSON with its own media type. */
  const json = (status: number, body: unknown) =>
    respond(status, body, { headers: { "Content-Type": "application/json" } });

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

  /** A response that is not the Worker's JSON, as Access or the Cloudflare edge sends. */
  const page = (status: number, body: string, type: string | undefined) =>
    vi.fn<typeof globalThis.fetch>(async (input) => {
      const response = new Response(body, { status });
      if (type) response.headers.set("Content-Type", type);
      else response.headers.delete("Content-Type");
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    });

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
    ["a rate limit", 429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
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

  it("sends no cookies and follows no redirects on device routes", async () => {
    const fetch = respond(204);
    await createServiceTransport({ fetch }).revoke(ORIGIN, CREDENTIAL);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(fetch.mock.calls[0]![1]!.headers).not.toHaveProperty("X-Requested-With");
  });
});

describe("revoke", () => {
  it("sends the credential only to the device route", async () => {
    const fetch = respond(204);
    expect(await createServiceTransport({ fetch }).revoke(ORIGIN, CREDENTIAL)).toEqual({
      kind: "revoked",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/device`);
    expect(init).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${CREDENTIAL}` },
      redirect: "error",
      credentials: "omit",
    });
  });

  it.each(["device_revoked", "device_expired", "unauthorized"])(
    "treats an already rejected credential as revoked: %s",
    async (error) => {
      const fetch = respond(401, { error });
      expect(await createServiceTransport({ fetch }).revoke(ORIGIN, CREDENTIAL)).toEqual({
        kind: "revoked",
      });
    },
  );

  it.each([{ error: "access_denied" }, "<html>"])(
    "does not count an unknown 401 as revoked: %j",
    async (body) => {
      expect(
        await createServiceTransport({ fetch: respond(401, body) }).revoke(ORIGIN, CREDENTIAL),
      ).toEqual({ kind: "failed", error: "unexpected-response" });
    },
  );

  it("reports other answers as unconfirmed", async () => {
    expect(
      await createServiceTransport({ fetch: respond(500, { error: "internal_error" }) }).revoke(
        ORIGIN,
        CREDENTIAL,
      ),
    ).toEqual({ kind: "failed", error: "unexpected-response" });
  });
});

describe("device state", () => {
  const state = {
    version: 1,
    pairedAt: 1_760_000_000_000,
    recipes: 3,
    settingsRevision: 7,
    generation: "monthly-limit",
  };

  it("reads the device route with the credential", async () => {
    const fetch = respond(200, state);
    expect(await createServiceTransport({ fetch }).device(ORIGIN, CREDENTIAL)).toEqual({
      kind: "state",
      state,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/device`);
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: `Bearer ${CREDENTIAL}` },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
  });

  it.each([
    ["an unknown field", 200, { ...state, deviceId: "dev_1" }, "unexpected-response"],
    ["an unknown status", 200, { ...state, generation: "busy" }, "unexpected-response"],
    ["a server error", 500, { error: "internal_error" }, "unexpected-response"],
    ["a rate limit", 429, { error: "rate_limited" }, "rate-limited"],
  ])("refuses %s", async (_name, status, body, error) => {
    expect(
      await createServiceTransport({ fetch: respond(status, body) }).device(ORIGIN, CREDENTIAL),
    ).toEqual({ kind: "failed", error });
  });

  it.each(["device_revoked", "device_expired", "unauthorized"])(
    "reports a rejected credential: %s",
    async (error) => {
      expect(
        await createServiceTransport({ fetch: respond(401, { error }) }).device(ORIGIN, CREDENTIAL),
      ).toEqual({ kind: "rejected" });
    },
  );

  it("gives up sooner than sync, since the diagnostics page waits for it", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn<typeof globalThis.fetch>(
        (_input, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      );
      const pending = createServiceTransport({ fetch: hanging }).device(ORIGIN, CREDENTIAL);
      await vi.advanceTimersByTimeAsync(DEVICE_TIMEOUT_MS);
      expect(await pending).toEqual({ kind: "failed", error: "unreachable" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recipe changes", () => {
  const recipePage = {
    version: 1,
    changes: [{ recipeId: "bank-signin", revision: 2, state: "revoked" }],
    cursor: 5,
    complete: true,
  };

  it("reads one page with the device credential", async () => {
    const fetch = respond(200, recipePage);
    expect(await createServiceTransport({ fetch }).recipeChanges(ORIGIN, CREDENTIAL, 3)).toEqual({
      kind: "page",
      page: recipePage,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes?after=3&limit=100`);
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: `Bearer ${CREDENTIAL}` },
      redirect: "error",
      credentials: "omit",
    });
  });

  it("accepts a page larger than the pairing limit", async () => {
    const body = `${" ".repeat(64 * 1024)}${JSON.stringify({ ...recipePage, cursor: 3 })}`;
    expect(
      await createServiceTransport({ fetch: respond(200, body) }).recipeChanges(
        ORIGIN,
        CREDENTIAL,
        3,
      ),
    ).toMatchObject({ kind: "page" });
  });

  it.each([
    ["a malformed page", 200, { ...recipePage, cursor: -1 }, "unexpected-response"],
    ["a cursor that moves back", 200, { ...recipePage, cursor: 2 }, "unexpected-response"],
    ["a rate limit", 429, { error: "rate_limited" }, "rate-limited"],
    ["an unknown 401", 401, { error: "access_denied" }, "unexpected-response"],
  ])("rejects %s", async (_, status, body, error) => {
    expect(
      await createServiceTransport({ fetch: respond(status, body) }).recipeChanges(
        ORIGIN,
        CREDENTIAL,
        3,
      ),
    ).toEqual({ kind: "failed", error });
  });

  it.each(["device_revoked", "device_expired", "unauthorized"])(
    "reports a rejected device: %s",
    async (error) => {
      expect(
        await createServiceTransport({ fetch: respond(401, { error }) }).recipeChanges(
          ORIGIN,
          CREDENTIAL,
          0,
        ),
      ).toEqual({ kind: "rejected" });
    },
  );
});

describe("settings", () => {
  const document = { connections: [], excludedSites: [], siteDefaults: [], bindings: [] };
  const state = { version: 1, revision: 4, settings: document };

  it("reads and conditionally writes the settings document", async () => {
    const read = respond(200, state);
    expect(await createServiceTransport({ fetch: read }).settings(ORIGIN, CREDENTIAL)).toEqual({
      kind: "state",
      state,
    });
    expect(read.mock.calls[0]).toMatchObject([
      `${ORIGIN}/v1/settings`,
      { method: "GET", headers: { Authorization: `Bearer ${CREDENTIAL}` } },
    ]);

    const write = respond(200, { ...state, revision: 5 });
    const written = { version: 1, expectedRevision: 4, settings: document } as const;
    expect(
      await createServiceTransport({ fetch: write }).saveSettings(ORIGIN, CREDENTIAL, written),
    ).toEqual({ kind: "state", state: { ...state, revision: 5 } });
    const [url, init] = write.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/settings`);
    expect(init).toMatchObject({
      method: "PUT",
      headers: { Authorization: `Bearer ${CREDENTIAL}`, "Content-Type": "application/json" },
      redirect: "error",
      credentials: "omit",
    });
    expect(JSON.parse(String(init?.body))).toEqual(written);
  });

  it("returns the service's state on a stale write", async () => {
    const fetch = respond(409, { error: "settings_conflict", current: state });
    expect(
      await createServiceTransport({ fetch }).saveSettings(ORIGIN, CREDENTIAL, {
        version: 1,
        expectedRevision: 3,
        settings: document,
      }),
    ).toEqual({ kind: "conflict", current: state });
  });

  it.each([
    ["a malformed document", 200, { ...state, revision: 0 }, "unexpected-response"],
    ["a conflict without its state", 409, { error: "settings_conflict" }, "unexpected-response"],
    ["a rate limit", 429, { error: "rate_limited" }, "rate-limited"],
  ])("rejects %s", async (_, status, body, error) => {
    expect(
      await createServiceTransport({ fetch: respond(status, body) }).settings(ORIGIN, CREDENTIAL),
    ).toEqual({ kind: "failed", error });
  });

  it("rejects an oversized write", async () => {
    expect(
      await createServiceTransport({
        fetch: respond(413, { error: "payload_too_large" }),
      }).saveSettings(ORIGIN, CREDENTIAL, { version: 1, expectedRevision: 3, settings: document }),
    ).toEqual({ kind: "failed", error: "unexpected-response" });
  });

  it("reports a rejected device", async () => {
    expect(
      await createServiceTransport({ fetch: respond(401, { error: "device_revoked" }) }).settings(
        ORIGIN,
        CREDENTIAL,
      ),
    ).toEqual({ kind: "rejected" });
  });
});

describe("recipe generation", () => {
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
      await createServiceTransport({ fetch }).generateRecipe(ORIGIN, CREDENTIAL, request),
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
      await createServiceTransport({ fetch }).judgeCompletion(ORIGIN, CREDENTIAL, recipeId, {
        version: 1,
        revision: 2,
        route: "password",
        observation,
      }),
    ).toEqual({ kind: "result", result: { version: 1, status: "unclear" } });
    expect(fetch.mock.calls[0]![0]).toBe(`${ORIGIN}/v1/recipes/${recipeId}/completion`);
  });

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
      await createServiceTransport({ fetch: respond(status, body) }).generateRecipe(
        ORIGIN,
        CREDENTIAL,
        request,
      ),
    ).toEqual(expected);
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
      expect(await pending).toEqual({ kind: "failed", error: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
