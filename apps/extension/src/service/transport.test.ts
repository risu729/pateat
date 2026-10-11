import { describe, expect, it, vi } from "vitest";
import { createServiceTransport } from "./transport";

// Synthetic responses only; no request leaves the test.

const ORIGIN = "https://pateat.example.com";
const VERIFIER = "V".repeat(43);
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

describe("redeem", () => {
  it("posts only the verifier with hardened fetch options", async () => {
    const fetch = respond(404, { error: "enrollment_not_found" });
    expect(await createServiceTransport({ fetch }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "pending",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/redeem`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(init!.body as string)).toEqual({ version: 1, verifier: VERIFIER });
  });

  it("accepts a valid credential", async () => {
    const result = {
      version: 1,
      deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
      credential: CREDENTIAL,
    };
    expect(
      await createServiceTransport({ fetch: respond(200, result) }).redeem(ORIGIN, VERIFIER),
    ).toEqual({ kind: "issued", result });
  });

  it.each([
    [
      "a malformed credential",
      200,
      { version: 1, deviceId: "x", credential: "y" },
      "unexpected-response",
    ],
    [
      "an extra field",
      200,
      {
        version: 1,
        deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
        credential: CREDENTIAL,
        owner: "x",
      },
      "unexpected-response",
    ],
    ["a non-JSON body", 200, "<html>", "unexpected-response"],
    ["an unknown 404", 404, { error: "not_found" }, "unexpected-response"],
    ["a rate limit", 429, { error: "rate_limited" }, "rate-limited"],
    ["a server error", 500, { error: "internal_error" }, "unexpected-response"],
  ])("rejects %s", async (_, status, body, error) => {
    expect(
      await createServiceTransport({ fetch: respond(status, body) }).redeem(ORIGIN, VERIFIER),
    ).toEqual({ kind: "failed", error });
  });

  it("recognizes a code mismatch", async () => {
    const fetch = respond(409, { error: "enrollment_code_mismatch" });
    expect(await createServiceTransport({ fetch }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "code-mismatch",
    });
  });

  it("refuses redirected and oversized responses", async () => {
    const redirected = vi.fn<typeof fetch>(async () => {
      const response = new Response("{}", { status: 200 });
      Object.defineProperty(response, "url", { value: "https://elsewhere.example.com/redeem" });
      return response;
    });
    expect(await createServiceTransport({ fetch: redirected }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
    const huge = respond(200, `"${"x".repeat(20_000)}"`);
    expect(await createServiceTransport({ fetch: huge }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
  });

  it("reports network failures and timeouts as unreachable", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await createServiceTransport({ fetch: offline }).redeem(ORIGIN, VERIFIER)).toEqual({
      kind: "failed",
      error: "unreachable",
    });
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    );
    expect(
      await createServiceTransport({ fetch: hanging, timeoutMs: 10 }).redeem(ORIGIN, VERIFIER),
    ).toEqual({ kind: "failed", error: "unreachable" });
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
