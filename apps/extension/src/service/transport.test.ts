import type { ProblemReport, StoredLoginRecipe } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { DEVICE_TIMEOUT_MS, createServiceTransport, type ServiceTransport } from "./transport";

import {
  registerPairRequestCases,
  registerPairResponseCases,
} from "../../test/service/transport/pair";
import { registerSettingsCases } from "../../test/service/transport/settings";
import { registerGenerationCases } from "../../test/service/transport/generation";
import { registerTimingCases } from "../../test/service/transport/timing";
import { registerOutcomeCases } from "../../test/service/transport/outcome";

export type TransportTestContext = {
  ORIGIN: typeof ORIGIN;
  CREDENTIAL: typeof CREDENTIAL;
  respond: typeof respond;
  untimed: typeof untimed;
};

// Synthetic responses only; no request leaves the test.

const ORIGIN = "https://pateat.example.com";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;

/** A result without its timing, which "service timing" below checks on its own. */
async function untimed<T extends object>(result: Promise<T>) {
  const { timing: _timing, ...rest } = (await result) as T & { timing?: unknown };
  return rest;
}

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
  const PROFILE = { id: "00000000-0000-4000-8000-000000000010", name: "Default" };
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

  registerPairRequestCases({ ORIGIN, respond, LABEL, PROFILE, issued, pair, json });

  /** A response that is not the Worker's JSON, as Access or the Cloudflare edge sends. */
  const page = (status: number, body: string, type: string | undefined) =>
    vi.fn<typeof globalThis.fetch>(async (input) => {
      const response = new Response(body, { status });
      if (type) response.headers.set("Content-Type", type);
      else response.headers.delete("Content-Type");
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    });

  registerPairResponseCases({ respond, PROFILE, issued, pair, json, page });
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
    // The device routes send no X-Requested-With or other header.
    expect(init!.headers).toEqual({ Authorization: `Bearer ${CREDENTIAL}` });
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
    expect(
      await untimed(createServiceTransport({ fetch }).recipeChanges(ORIGIN, CREDENTIAL, 3)),
    ).toEqual({
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

  describe("a change this build cannot read (#959)", () => {
    const layout = (target: unknown) => ({
      key: "1760000000000",
      createdAt: 1760000000000,
      pageKind: "sign-in",
      slots: ["password"],
      steps: [
        {
          kind: "fill",
          path: "/login",
          fields: [{ slot: "password", target }],
          effect: "submit",
          event: "change",
        },
      ],
      maxSubmissions: 1,
    });
    const change = (recipeId: string, target: unknown) => ({
      recipeId,
      revision: 2,
      state: "active",
      recipe: {
        version: 1,
        id: recipeId,
        revision: 2,
        origin: "https://shop.example",
        layouts: [layout(target)],
      },
    });
    const readable = change("shop-signin", { by: "id", value: "password" });
    // A locator kind a newer build might add.
    const newer = change("card-signin", { by: "future-locator", value: "password" });
    const read = (body: unknown) =>
      untimed(
        createServiceTransport({ fetch: respond(200, body) }).recipeChanges(ORIGIN, CREDENTIAL, 3),
      );

    it("leaves it out and keeps the rest of the page", async () => {
      expect(
        await read({ ...recipePage, changes: [newer, readable, recipePage.changes[0]] }),
      ).toEqual({
        kind: "page",
        page: { ...recipePage, changes: [readable, recipePage.changes[0]] },
        unreadable: ["card-signin"],
      });
    });

    it("names every change of a page that only holds unreadable recipes", async () => {
      const other = change("card-otp", { by: "future-locator", value: "code" });
      expect(await read({ ...recipePage, changes: [newer, other] })).toEqual({
        kind: "page",
        page: { ...recipePage, changes: [] },
        unreadable: ["card-signin", "card-otp"],
      });
    });

    it.each([
      ["a tombstone that does not read", [{ ...recipePage.changes[0], revision: 0 }]],
      ["a change without a recipe ID", [{ ...newer, recipeId: "" }]],
      ["an unknown state", [{ ...newer, state: "paused" }]],
      ["a recipe left out twice", [newer, newer]],
      ["a bad revision", [{ ...newer, revision: 0, recipe: { ...newer.recipe, revision: 0 } }]],
      ["a recipe of another ID", [{ ...newer, recipe: { ...newer.recipe, id: "shop-signin" } }]],
      ["a recipe of another revision", [{ ...newer, recipe: { ...newer.recipe, revision: 3 } }]],
      ["an active change without a recipe", [{ ...newer, recipe: undefined }]],
      ["another field on a change", [{ ...newer, note: "x" }]],
      [
        "a tombstone with a key a strict object refuses",
        [JSON.parse('{"recipeId":"bank-signin","revision":2,"state":"revoked","constructor":1}')],
      ],
      [
        "a recipe left out and read once",
        [newer, change("card-signin", { by: "id", value: "password" })],
      ],
    ])("still refuses a page with %s", async (_, changes) => {
      expect(await read({ ...recipePage, changes })).toEqual({
        kind: "failed",
        error: "unexpected-response",
      });
    });
  });

  it("accepts a page larger than the pairing limit", async () => {
    const body = `${" ".repeat(64 * 1024)}${JSON.stringify({ ...recipePage, cursor: 3 })}`;
    expect(
      await untimed(
        createServiceTransport({ fetch: respond(200, body) }).recipeChanges(ORIGIN, CREDENTIAL, 3),
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
      await untimed(
        createServiceTransport({ fetch: respond(status, body) }).recipeChanges(
          ORIGIN,
          CREDENTIAL,
          3,
        ),
      ),
    ).toEqual({ kind: "failed", error });
  });

  it.each(["device_revoked", "device_expired", "unauthorized"])(
    "reports a rejected device: %s",
    async (error) => {
      expect(
        await untimed(
          createServiceTransport({ fetch: respond(401, { error }) }).recipeChanges(
            ORIGIN,
            CREDENTIAL,
            0,
          ),
        ),
      ).toEqual({ kind: "rejected" });
    },
  );
});

describe("settings", () => {
  const document = {
    connections: [],
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [],
    repromptSites: [],
    passkeyBrowserSites: [],
    siteDefaults: [],
    bindings: [],
  };
  const state = {
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 4,
    settings: document,
  };

  registerSettingsCases({ ORIGIN, CREDENTIAL, respond, untimed, document, state });
});

/** A Cloudflare edge rate-limit page: HTML, not the Worker's JSON. */
function edgeRateLimitPage() {
  return respond(429, "<!doctype html><title>Error 1015: You are being rate limited</title>", {
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

describe("rate limits on device-credential routes", () => {
  const document = {
    connections: [],
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [],
    passkeyBrowserSites: [],
    repromptSites: [],
    siteDefaults: [],
    bindings: [],
  };
  const write = { version: 1, expectedRevision: 3, settings: document } as const;
  const routes: [string, (transport: ServiceTransport) => Promise<object>][] = [
    ["recipe changes", (transport) => transport.recipeChanges(ORIGIN, CREDENTIAL, 3)],
    ["the settings read", (transport) => transport.settings(ORIGIN, CREDENTIAL)],
    ["the settings write", (transport) => transport.saveSettings(ORIGIN, CREDENTIAL, write)],
    ["the device read", (transport) => transport.device(ORIGIN, CREDENTIAL)],
    ["revocation", (transport) => transport.revoke(ORIGIN, CREDENTIAL)],
  ];

  it.each(routes)("reports the Worker's JSON 429 on %s as rate limiting", async (_, call) => {
    const fetch = respond(
      429,
      { error: "rate_limited" },
      {
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(await untimed(call(createServiceTransport({ fetch })))).toEqual({
      kind: "failed",
      error: "rate-limited",
    });
  });

  // The edge answers before the Worker, so its page is HTML; it still asks Pateat to
  // slow down, which starts the sync back-off instead of reading as a broken answer.
  it.each(routes)("reports an edge HTML 429 on %s as rate limiting", async (_, call) => {
    expect(await untimed(call(createServiceTransport({ fetch: edgeRateLimitPage() })))).toEqual({
      kind: "failed",
      error: "rate-limited",
    });
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

  registerGenerationCases({
    ORIGIN,
    CREDENTIAL,
    respond,
    untimed,
    edgeRateLimitPage,
    observation,
    request,
    recipeId,
  });
});

describe("reportOutcome", () => {
  const report = {
    version: 1,
    revision: 3,
    branch: "1760000000000",
    outcome: "unknown-submit",
    cause: "settled",
    step: 1,
  } as const;
  const send = (fetch: typeof globalThis.fetch) =>
    createServiceTransport({ fetch }).reportOutcome(ORIGIN, CREDENTIAL, "gen-0123", report);

  registerOutcomeCases({ ORIGIN, CREDENTIAL, respond, report, send });
});

describe("reportLogin", () => {
  const record = {
    version: 1,
    revision: 3,
    branch: "1760000000000",
    outcome: "authenticated",
    extensionBuild: "1c42ad3",
    totalMs: 4210,
    serviceMs: 0,
    networkMs: 0,
    personMs: 0,
    pageMs: 0,
  } as const;
  const send = (fetch: typeof globalThis.fetch) =>
    createServiceTransport({ fetch }).reportLogin(ORIGIN, CREDENTIAL, "gen-0123", record);

  it("posts only the record with the device credential, no cookies and no redirects", async () => {
    const fetch = respond(204);
    expect(await send(fetch)).toEqual({ kind: "kept" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes/gen-0123/logins`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(init!.headers).toEqual({
      Authorization: `Bearer ${CREDENTIAL}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init!.body as string)).toEqual(record);
  });

  it.each([
    [404, { error: "not_found" }, { kind: "refused" }],
    [413, { error: "payload_too_large" }, { kind: "refused" }],
    [401, { error: "device_revoked" }, { kind: "rejected" }],
    [429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
    [503, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
  ])("answers %i as its kind", async (status, body, expected) => {
    expect(await send(respond(status, body))).toEqual(expected);
  });
});

describe("reportUse", () => {
  const report = { version: 1, revision: 3, layout: "1760000000000" } as const;
  const send = (fetch: typeof globalThis.fetch, recipeId = "gen-0123") =>
    createServiceTransport({ fetch }).reportUse(ORIGIN, CREDENTIAL, recipeId, report);

  it("posts only the revision and layout with the device credential, no cookies and no redirects", async () => {
    const fetch = respond(204);
    expect(await send(fetch)).toEqual({ kind: "kept" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes/gen-0123/use`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(init!.headers).toEqual({
      Authorization: `Bearer ${CREDENTIAL}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      version: 1,
      revision: 3,
      layout: "1760000000000",
    });
  });

  it("encodes the recipe ID into the path", async () => {
    const fetch = respond(204);
    await send(fetch, "a/b c");
    expect(fetch.mock.calls[0]![0]).toBe(`${ORIGIN}/v1/recipes/a%2Fb%20c/use`);
  });

  it.each([
    [404, { error: "not_found" }, { kind: "refused" }],
    [400, { error: "bad_request" }, { kind: "refused" }],
    [405, { error: "method_not_allowed" }, { kind: "refused" }],
    [413, { error: "payload_too_large" }, { kind: "refused" }],
    [401, { error: "device_revoked" }, { kind: "rejected" }],
    [429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
    [500, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
    [503, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
    [200, {}, { kind: "failed", error: "unexpected-response" }],
  ])("answers %i as its kind", async (status, body, expected) => {
    expect(await send(respond(status, body))).toEqual(expected);
  });

  it("reports an unreachable service", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await send(fetch)).toEqual({ kind: "failed", error: "unreachable" });
  });
});

describe("reportProblems (ADR 0066)", () => {
  const report: ProblemReport = {
    version: 1,
    extensionBuild: "1c42ad3",
    logId: "0123456789abcdef0123456789abcdef",
    entries: [{ seq: 1, time: 1, level: "warn", event: "vault.sync", fields: {} }],
  };
  const send = (fetch: typeof globalThis.fetch) =>
    createServiceTransport({ fetch }).reportProblems(ORIGIN, CREDENTIAL, report);

  it("posts the lines with the device credential", async () => {
    const fetch = respond(204);
    expect(await send(fetch)).toEqual({ kind: "kept" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/device/problems`);
    expect(init).toMatchObject({ method: "POST", credentials: "omit" });
    expect(JSON.parse(init!.body as string)).toEqual(report);
  });

  it("passes on how long a rate limit asks to wait", async () => {
    expect(
      await send(respond(429, { error: "rate_limited" }, { headers: { "Retry-After": "3600" } })),
    ).toEqual({ kind: "failed", error: "rate-limited", retryAfterMs: 3_600_000 });
    expect(
      await send(respond(429, { error: "rate_limited" }, { headers: { "Retry-After": "soon" } })),
    ).toEqual({ kind: "failed", error: "rate-limited" });
    expect(await send(respond(400, { error: "bad_request" }))).toEqual({ kind: "refused" });
  });

  it("keeps the lines when the service does not have the route yet", async () => {
    for (const status of [404, 405])
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time
      expect(await send(respond(status, { error: "not_found" }))).toEqual({
        kind: "failed",
        error: "unexpected-response",
      });
  });
});

describe("revokeRecipe (ADR 0058 A)", () => {
  const recipeId = "gen-0123456789abcdef0123456789abcdef";
  const other = "gen-fedcba9876543210fedcba9876543210";
  const tombstone = { recipeId, revision: 4, state: "revoked" } as const;
  const active = {
    recipeId,
    revision: 4,
    state: "active",
    recipe: {
      version: 1,
      id: recipeId,
      revision: 4,
      origin: "https://shop.example",
      layouts: [
        {
          key: "1760000000000",
          createdAt: 1760000000000,
          pageKind: "sign-in",
          slots: ["password"],
          steps: [
            {
              kind: "fill",
              path: "/login",
              fields: [{ slot: "password", target: { by: "id", value: "password" } }],
              effect: "submit",
              event: "change",
            },
          ],
          maxSubmissions: 1,
        },
      ],
    },
  } as const;
  const send = (fetch: typeof globalThis.fetch, id = recipeId) =>
    untimed(createServiceTransport({ fetch }).revokeRecipe(ORIGIN, CREDENTIAL, id, 3));

  it("puts a conditional revocation with the device credential, no cookies and no redirects", async () => {
    const fetch = respond(200, { version: 1, change: tombstone });
    expect(await send(fetch)).toEqual({ kind: "revoked", change: tombstone });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes/${recipeId}`);
    expect(init).toMatchObject({
      method: "PUT",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(init!.headers).toEqual({
      Authorization: `Bearer ${CREDENTIAL}`,
      "Content-Type": "application/json",
    });
    // Only the revision it expects and the state: no recipe, origin or page.
    expect(JSON.parse(init!.body as string)).toEqual({
      version: 1,
      expectedRevision: 3,
      state: "revoked",
    });
  });

  it("encodes the recipe ID into the path", async () => {
    const fetch = respond(200, { version: 1, change: tombstone });
    // No recipe ID the sync contract accepts holds these; only the path is checked.
    await send(fetch, "a/b c");
    expect(fetch.mock.calls[0]![0]).toBe(`${ORIGIN}/v1/recipes/a%2Fb%20c`);
  });

  it.each([
    ["another recipe's tombstone", { version: 1, change: { ...tombstone, recipeId: other } }],
    ["an active head", { version: 1, change: active }],
    ["a malformed change", { version: 1, change: { ...tombstone, revision: 0 } }],
    ["no change", { version: 1 }],
    ["an extra field", { version: 1, change: tombstone, recipe: active.recipe }],
  ])("takes a 200 with %s as no answer to the revocation", async (_, body) => {
    expect(await send(respond(200, body))).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
  });

  it.each([
    ["no head", null],
    [
      "the recipe's newer head",
      { ...active, revision: 5, recipe: { ...active.recipe, revision: 5 } },
    ],
    ["the recipe's tombstone", { ...tombstone, revision: 5 }],
  ])("returns the service's head on a conflict with %s", async (_, current) => {
    expect(await send(respond(409, { error: "recipe_conflict", current }))).toEqual({
      kind: "conflict",
      current,
    });
  });

  it.each([
    [
      "another recipe's head",
      { error: "recipe_conflict", current: { ...tombstone, recipeId: other } },
    ],
    ["no head field", { error: "recipe_conflict" }],
    ["the recipe limit", { error: "recipe_limit" }],
    ["a malformed head", { error: "recipe_conflict", current: { ...tombstone, revision: 0 } }],
  ])("takes a 409 with %s as no answer to the revocation", async (_, body) => {
    expect(await send(respond(409, body))).toEqual({
      kind: "failed",
      error: "unexpected-response",
    });
  });

  it.each([
    [401, { error: "device_revoked" }, { kind: "rejected" }],
    [401, { error: "device_expired" }, { kind: "rejected" }],
    [401, { error: "unauthorized" }, { kind: "rejected" }],
    [429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
    [400, { error: "bad_request" }, { kind: "failed", error: "unexpected-response" }],
    [404, { error: "not_found" }, { kind: "failed", error: "unexpected-response" }],
    [500, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
    [502, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
    [503, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
  ])("answers %i as its kind", async (status, body, expected) => {
    expect(await send(respond(status, body))).toEqual(expected);
  });

  it("reports an unreachable service", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await send(fetch)).toEqual({ kind: "failed", error: "unreachable" });
  });

  it("times its answer", async () => {
    const result = await createServiceTransport({
      fetch: respond(200, { version: 1, change: tombstone }),
    }).revokeRecipe(ORIGIN, CREDENTIAL, recipeId, 3);
    expect(result.timing).toMatchObject({ roundTripMs: expect.any(Number) });
  });
});

describe("writeRecipe (ADR 0040)", () => {
  const recipeId = "gen-0123456789abcdef0123456789abcdef";
  const other = "gen-fedcba9876543210fedcba9876543210";
  const recipe: StoredLoginRecipe = {
    version: 1,
    id: recipeId,
    revision: 1,
    origin: "https://shop.example",
    layouts: [
      {
        key: "1760000000000",
        createdAt: 1760000000000,
        pageKind: "sign-in",
        slots: ["password"],
        steps: [
          {
            kind: "fill",
            path: "/login",
            fields: [{ slot: "password", target: { by: "id", value: "password" } }],
            effect: "submit",
            event: "change",
          },
        ],
        maxSubmissions: 1,
      },
    ],
  };
  const active = { recipeId, revision: 1, state: "active", recipe } as const;
  const write = { version: 1 as const, expectedRevision: 0, state: "active" as const, recipe };
  const send = (fetch: typeof globalThis.fetch) =>
    untimed(createServiceTransport({ fetch }).writeRecipe(ORIGIN, CREDENTIAL, recipeId, write));

  it("puts the new recipe with the device credential", async () => {
    const fetch = respond(200, { version: 1, change: active });
    expect(await send(fetch)).toEqual({ kind: "written", change: active });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes/${recipeId}`);
    expect(init).toMatchObject({ method: "PUT", redirect: "error", credentials: "omit" });
    expect(JSON.parse(init!.body as string)).toEqual(write);
  });

  it("takes a 200 with another recipe's head as no answer", async () => {
    expect(
      await send(respond(200, { version: 1, change: { ...active, recipeId: other } })),
    ).toEqual({ kind: "failed", error: "unexpected-response" });
  });

  it.each([
    ["an active head", active],
    ["a tombstone", { recipeId, revision: 3, state: "revoked" }],
  ])("returns the service's head when it already holds the ID with %s", async (_, current) => {
    expect(await send(respond(409, { error: "recipe_conflict", current }))).toEqual({
      kind: "conflict",
      current,
    });
  });

  it.each([
    ["no head", { error: "recipe_conflict", current: null }],
    [
      "another recipe's head",
      { error: "recipe_conflict", current: { ...active, recipeId: other } },
    ],
    ["an unknown body", { error: "something_else" }],
  ])("refuses for good on a 409 with %s", async (_, body) => {
    expect(await send(respond(409, body))).toEqual({ kind: "refused" });
  });

  it.each([
    [409, { error: "recipe_limit" }, { kind: "failed", error: "recipe-limit" }],
    [400, { error: "bad_request" }, { kind: "refused" }],
    [405, { error: "method_not_allowed" }, { kind: "refused" }],
    [413, { error: "payload_too_large" }, { kind: "refused" }],
    [401, { error: "device_revoked" }, { kind: "rejected" }],
    [429, { error: "rate_limited" }, { kind: "failed", error: "rate-limited" }],
    [500, { error: "internal_error" }, { kind: "failed", error: "unexpected-response" }],
  ])("answers %i as its kind", async (status, body, expected) => {
    expect(await send(respond(status, body))).toEqual(expected);
  });
});

describe("service timing", () => {
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

  registerTimingCases({ ORIGIN, CREDENTIAL, request });
});

describe("logout generation (ADR 0063)", () => {
  const request = {
    version: 1 as const,
    observation: {
      version: 1 as const,
      origin: "https://shop.example",
      path: "/home",
      language: "en" as const,
      complete: true,
      candidates: [
        { id: "c1", role: "button" as const, target: { by: "id" as const, value: "sign-out" } },
      ],
    },
  };

  it("posts a signed-in page with the device credential and returns the service's answer", async () => {
    const answer = { version: 1, status: "signed-out" };
    const fetch = respond(200, answer);
    expect(
      await untimed(createServiceTransport({ fetch }).generateLogout(ORIGIN, CREDENTIAL, request)),
    ).toEqual({ kind: "result", result: answer });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/v1/recipes/logout`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { Authorization: `Bearer ${CREDENTIAL}`, "Content-Type": "application/json" },
    });
    expect(JSON.parse(init!.body as string)).toEqual(request);
  });

  it("refuses an answer that is no logout answer", async () => {
    const fetch = respond(200, { version: 1, status: "abstained", reason: "no-login-form" });
    expect(
      await untimed(createServiceTransport({ fetch }).generateLogout(ORIGIN, CREDENTIAL, request)),
    ).toEqual({ kind: "failed", error: "unexpected-response" });
  });
});
