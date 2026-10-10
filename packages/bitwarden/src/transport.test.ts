import { afterEach, describe, expect, it, vi } from "vitest";
import { createBitwardenTransport, normalizeBitwardenProfile } from "./index";
import {
  encryptedSync,
  jsonResponse,
  legacyPrelogin,
  passwordPrelogin,
  streamedResponse,
} from "./__fixtures__/transport";

const cloudProfile = {
  connectionId: "synthetic-provider",
  environment: { kind: "cloud", region: "us" },
} as const;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function transport(fetch: Fetch, options: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  const result = createBitwardenTransport(cloudProfile, { fetch, ...options });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Synthetic transport configuration rejected");
  return result.data;
}

afterEach(() => vi.useRealTimers());

describe("provider endpoint admission", () => {
  it.each([
    [
      { kind: "cloud", region: "us" },
      "https://identity.bitwarden.com/accounts/prelogin",
      "https://api.bitwarden.com/sync",
    ],
    [
      { kind: "cloud", region: "eu" },
      "https://identity.bitwarden.eu/accounts/prelogin",
      "https://api.bitwarden.eu/sync",
    ],
    [
      { kind: "self-hosted", baseUrl: "https://VAULT.example.test:443/" },
      "https://vault.example.test/identity/accounts/prelogin",
      "https://vault.example.test/api/sync",
    ],
    [
      { kind: "self-hosted", baseUrl: "https://vault.example.test:8443" },
      "https://vault.example.test:8443/identity/accounts/prelogin",
      "https://vault.example.test:8443/api/sync",
    ],
    [
      { kind: "self-hosted", baseUrl: "https://vault.example.test./" },
      "https://vault.example.test./identity/accounts/prelogin",
      "https://vault.example.test./api/sync",
    ],
  ])("builds fixed routes for %j", async (environment, preloginUrl, syncUrl) => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse(legacyPrelogin))
      .mockResolvedValueOnce(jsonResponse(encryptedSync()));
    const created = createBitwardenTransport({ ...cloudProfile, environment }, { fetch });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await created.data.prelogin({
      connectionId: cloudProfile.connectionId,
      email: "synthetic-user@example.test",
      mode: "legacy",
    });
    await created.data.sync({
      connectionId: cloudProfile.connectionId,
      accessToken: "synthetic-access-token",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([preloginUrl, syncUrl]);
  });

  it.each([
    "http://vault.example.test",
    "https://user:synthetic-password@vault.example.test",
    "https://vault.example.test?token=synthetic",
    "https://vault.example.test#synthetic",
    "https://vault.example.test/custom",
    "https://vault.example.test/api",
    "https://vault.example.test/identity",
    "https://vault.example.test/%2f",
    "https://vault.example.test/../",
    "https://vault.example.test\\custom",
    "https://vault.example.test:invalid",
    "not-a-provider-url",
  ])("rejects an inadmissible server URL before any request: %s", (baseUrl) => {
    const fetch = vi.fn<Fetch>();
    const profile = { ...cloudProfile, environment: { kind: "self-hosted", baseUrl } };
    expect(normalizeBitwardenProfile(profile)).toMatchObject({
      ok: false,
      error: { code: "invalid-profile" },
    });
    expect(createBitwardenTransport(profile, { fetch })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed profiles and prevents input mutation from changing an admitted destination", async () => {
    for (const input of [
      null,
      { ...cloudProfile, connectionId: "" },
      { ...cloudProfile, environment: { kind: "cloud", region: "other" } },
      { ...cloudProfile, apiUrl: "https://other.example.test" },
    ]) {
      expect(normalizeBitwardenProfile(input)).toMatchObject({ ok: false });
    }
    const profile = {
      connectionId: cloudProfile.connectionId,
      environment: { kind: "self-hosted", baseUrl: "https://vault.example.test" },
    };
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(legacyPrelogin));
    const created = createBitwardenTransport(profile, { fetch });
    if (!created.ok) throw new Error("Synthetic profile rejected");
    profile.environment.baseUrl = "https://other.example.test";
    await created.data.prelogin({
      connectionId: profile.connectionId,
      email: "synthetic@example.test",
      mode: "legacy",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://vault.example.test/identity/accounts/prelogin");
  });
});

describe("read-only provider requests", () => {
  it.each(["legacy", "password"] as const)(
    "sends only email to the explicit %s prelogin endpoint",
    async (mode) => {
      const payload = mode === "legacy" ? legacyPrelogin : passwordPrelogin;
      const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload));
      const result = await transport(fetch).prelogin({
        connectionId: cloudProfile.connectionId,
        email: "synthetic-user@example.test",
        mode,
      });
      expect(result).toEqual({ ok: true, data: payload });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0]!;
      const request = new Request(url, init);
      expect(url).toBe(
        `https://identity.bitwarden.com/accounts/prelogin${mode === "password" ? "/password" : ""}`,
      );
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({ email: "synthetic-user@example.test" });
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.has("authorization")).toBe(false);
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("performs one authenticated GET and returns unknown encryption metadata unchanged", async () => {
    const payload = encryptedSync();
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload));
    const client = transport(fetch);
    const result = await client.sync({
      connectionId: cloudProfile.connectionId,
      accessToken: "synthetic-access-token",
    });
    expect(result).toEqual({ ok: true, data: payload });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    const request = new Request(url, init);
    expect(url).toBe("https://api.bitwarden.com/sync");
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-access-token");
    expect(init.body).toBeUndefined();
    expect(await request.text()).toBe("");
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(Object.keys(client).sort()).toEqual([
      "passwordToken",
      "prelogin",
      "profile",
      "refreshToken",
      "sync",
    ]);
  });

  it("rejects a different connection and malformed credentials without sending anything", async () => {
    const fetch = vi.fn<Fetch>();
    const client = transport(fetch);
    const invalid = await Promise.all(
      ["", "synthetic\r\nInjected: header"].map((accessToken) =>
        client.sync({ connectionId: cloudProfile.connectionId, accessToken }),
      ),
    );
    for (const result of invalid) expect(result).toMatchObject({ ok: false });
    expect(
      await client.sync({ connectionId: "other-provider", accessToken: "synthetic-token" }),
    ).toMatchObject({ ok: false });
    expect(
      await client.prelogin({
        connectionId: "other-provider",
        email: "synthetic@example.test",
        mode: "legacy",
      }),
    ).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry or silently switch prelogin routes when the chosen route fails", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(jsonResponse({ message: "synthetic-body-secret" }, { status: 404 }));
    const result = await transport(fetch).prelogin({
      connectionId: cloudProfile.connectionId,
      email: "synthetic@example.test",
      mode: "password",
    });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("synthetic-body-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://identity.bitwarden.com/accounts/prelogin/password",
    );
  });
});

describe("response admission and diagnostics", () => {
  it.each([301, 302, 307, 308])(
    "rejects HTTP %s without another authenticated request",
    async (status) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(
        new Response("synthetic-redirect-secret", {
          status,
          headers: { location: "https://other.example.test/synthetic-secret" },
        }),
      );
      const result = await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      });
      expect(result).toMatchObject({ ok: false, error: { code: "redirect" } });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("synthetic");
    },
  );

  it("rejects a fetch-followed redirect even when its status and JSON look valid", async () => {
    const response = jsonResponse(encryptedSync());
    Object.defineProperty(response, "redirected", { value: true });
    Object.defineProperty(response, "url", { value: "https://other.example.test/api/sync" });
    const fetch = vi.fn<Fetch>().mockResolvedValue(response);
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toMatchObject({ ok: false, error: { code: "redirect" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed same-origin response URL even without a redirected flag", async () => {
    const response = jsonResponse(encryptedSync());
    Object.defineProperty(response, "url", { value: "https://api.bitwarden.com/other-boundary" });
    const fetch = vi.fn<Fetch>().mockResolvedValue(response);
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "redirect" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 429, 500])(
    "returns a bounded HTTP %s diagnosis without raw body data",
    async (status) => {
      const fetch = vi
        .fn<Fetch>()
        .mockResolvedValue(jsonResponse({ error: "synthetic-encrypted-private-body" }, { status }));
      expect(
        await transport(fetch).sync({
          connectionId: cloudProfile.connectionId,
          accessToken: "synthetic-token",
        }),
      ).toEqual({ ok: false, error: { code: "http-error", status } });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Response("synthetic-html-secret", { headers: { "content-type": "text/html" } }),
    new Response(JSON.stringify(legacyPrelogin)),
    new Response('{"kdf":0,"kdfIterations":', { headers: { "content-type": "application/json" } }),
    jsonResponse(null),
    jsonResponse([]),
    jsonResponse({ kdf: "0", kdfIterations: 600_000 }),
    jsonResponse({ kdf: 0, kdfIterations: 0 }),
    jsonResponse({ kdf: 1, kdfIterations: 3, kdfMemory: 64 }),
  ])("rejects malformed prelogin data without exposing body text", async (response) => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(response);
    const result = await transport(fetch).prelogin({
      connectionId: cloudProfile.connectionId,
      email: "synthetic@example.test",
      mode: "legacy",
    });
    expect(result).toEqual({ ok: false, error: { code: "invalid-response" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts matching old/new KDF envelopes and rejects mismatched dual settings", async () => {
    const matching = {
      ...legacyPrelogin,
      kdfSettings: { kdfType: 0, iterations: 600_000, memory: null, parallelism: null },
      salt: null,
    };
    const conflicting = { ...matching, kdfSettings: { ...matching.kdfSettings, iterations: 1 } };
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse(matching))
      .mockResolvedValueOnce(jsonResponse(conflicting));
    const client = transport(fetch);
    expect(
      await client.prelogin({
        connectionId: cloudProfile.connectionId,
        email: "synthetic@example.test",
        mode: "password",
      }),
    ).toEqual({ ok: true, data: matching });
    expect(
      await client.prelogin({
        connectionId: cloudProfile.connectionId,
        email: "synthetic@example.test",
        mode: "password",
      }),
    ).toEqual({ ok: false, error: { code: "invalid-response" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts null legacy KDF fields with a complete password-prelogin envelope", async () => {
    const payload = { ...passwordPrelogin, kdf: null, kdfIterations: null };
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload));
    const client = transport(fetch);
    expect(
      await client.prelogin({
        connectionId: cloudProfile.connectionId,
        email: "synthetic@example.test",
        mode: "password",
      }),
    ).toEqual({ ok: true, data: payload });
    // Legacy mode still requires its own non-null KDF configuration.
    fetch.mockResolvedValue(jsonResponse(payload));
    expect(
      await client.prelogin({
        connectionId: cloudProfile.connectionId,
        email: "synthetic@example.test",
        mode: "legacy",
      }),
    ).toEqual({ ok: false, error: { code: "invalid-response" } });
  });

  it("preserves future KDF metadata without claiming that a crypto implementation supports it", async () => {
    const unknown = {
      kdfSettings: { kdfType: 99, iterations: 1, futureEncryptedParameter: "synthetic-opaque" },
      salt: "synthetic-salt",
    };
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(unknown));
    expect(
      await transport(fetch).prelogin({
        connectionId: cloudProfile.connectionId,
        email: "synthetic@example.test",
        mode: "password",
      }),
    ).toEqual({ ok: true, data: unknown });
  });

  it.each(["legacy", "password"] as const)(
    "rejects a response for the other prelogin mode: %s",
    async (mode) => {
      const fetch = vi
        .fn<Fetch>()
        .mockResolvedValue(jsonResponse(mode === "legacy" ? passwordPrelogin : legacyPrelogin));
      expect(
        await transport(fetch).prelogin({
          connectionId: cloudProfile.connectionId,
          email: "synthetic@example.test",
          mode,
        }),
      ).toEqual({ ok: false, error: { code: "invalid-response" } });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "object",
    "profile",
    "folders",
    "collections",
    "ciphers",
    "policies",
    "sends",
    "domains",
  ])("rejects a truncated sync missing %s", async (missing) => {
    const incomplete: Record<string, unknown> = encryptedSync();
    delete incomplete[missing];
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(incomplete));
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "invalid-response" } });
  });

  it.each([
    { ciphers: null },
    { ciphers: ["synthetic-malformed-cipher"] },
    { folders: {} },
    { profile: {} },
    { profile: { id: 7 } },
    { userDecryption: [] },
    { domains: [] },
    { ciphers: [[]] },
    { policiesNew: [null] },
    { object: "list" },
  ])("rejects a structurally invalid encrypted sync envelope: %j", async (invalid) => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(jsonResponse({ ...encryptedSync(), ...invalid }));
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "invalid-response" } });
  });

  it("accepts an explicitly empty legacy sync without inventing absent version fields", async () => {
    const payload = {
      object: "sync",
      profile: { id: "synthetic-empty-profile" },
      folders: [],
      collections: [],
      ciphers: [],
      policies: [],
      sends: [],
      domains: null,
    };
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload));
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: true, data: payload });
  });

  it("sanitizes thrown network errors containing token, account and destination data", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockRejectedValue(
        new Error("synthetic-token synthetic@example.test https://private.example.test/vault"),
      );
    const result = await transport(fetch).sync({
      connectionId: cloudProfile.connectionId,
      accessToken: "synthetic-token",
    });
    expect(result).toEqual({ ok: false, error: { code: "network" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("bounded response processing", () => {
  it.each([{}, { "content-length": "1" }])(
    "enforces streamed byte limits regardless of Content-Length: %j",
    async (headers) => {
      const stream = streamedResponse(
        ['{"payload":"', "x".repeat(3000), "x".repeat(3000), '"}'],
        headers,
      );
      const fetch = vi.fn<Fetch>().mockResolvedValue(stream.response);
      expect(
        await transport(fetch, { maxResponseBytes: 4096 }).sync({
          connectionId: cloudProfile.connectionId,
          accessToken: "synthetic-token",
        }),
      ).toEqual({ ok: false, error: { code: "response-too-large" } });
      expect(stream.cancelled()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const stream = streamedResponse(['{"payload":"', "界".repeat(2000), '"}']);
    const fetch = vi.fn<Fetch>().mockResolvedValue(stream.response);
    expect(
      await transport(fetch, { maxResponseBytes: 4096 }).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "response-too-large" } });
  });

  it("cancels a response advertising excessive length without reading its body", async () => {
    const stream = streamedResponse([JSON.stringify(encryptedSync())], {
      "content-length": "5000",
    });
    const fetch = vi.fn<Fetch>().mockResolvedValue(stream.response);
    expect(
      await transport(fetch, { maxResponseBytes: 4096 }).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "response-too-large" } });
    expect(stream.cancelled()).toBe(true);
    expect(stream.pulls()).toBe(0);
  });

  it("cancels a rejected content-type body before consuming it", async () => {
    const stream = streamedResponse(["synthetic-private-html"], { "content-type": "text/html" });
    const fetch = vi.fn<Fetch>().mockResolvedValue(stream.response);
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "invalid-response" } });
    expect(stream.cancelled()).toBe(true);
    expect(stream.pulls()).toBe(0);
  });

  it("rejects malformed UTF-8 as response data rather than a network failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]));
        controller.close();
      },
    });
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "invalid-response" } });
  });

  it("accepts valid JSON split across chunks and rejects a truncated byte stream", async () => {
    const body = JSON.stringify(encryptedSync());
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(streamedResponse([body.slice(0, 31), body.slice(31)]).response)
      .mockResolvedValueOnce(streamedResponse([body.slice(0, -1)]).response);
    const client = transport(fetch);
    expect(
      await client.sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: true, data: encryptedSync() });
    expect(
      await client.sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "invalid-response" } });
  });

  it("sanitizes a stream read error and cancels remaining work", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("synthetic-stream-secret"));
      },
    });
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    expect(
      await transport(fetch).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "network" } });
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 64 * 1024 * 1024 + 1 },
    { timeoutMs: NaN },
  ])("rejects invalid processing bounds: %j", (options) => {
    const fetch = vi.fn<Fetch>();
    expect(createBitwardenTransport(cloudProfile, { fetch, ...options })).toEqual({
      ok: false,
      error: { code: "invalid-options" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("cancellation and deadlines", () => {
  it("does not send a request after cancellation and hides the caller abort reason", async () => {
    const fetch = vi.fn<Fetch>();
    const abort = new AbortController();
    abort.abort("synthetic-abort-secret");
    expect(
      await transport(fetch).sync(
        { connectionId: cloudProfile.connectionId, accessToken: "synthetic-token" },
        abort.signal,
      ),
    ).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a late response body after the caller has already cancelled fetch", async () => {
    let deliver: (response: Response) => void = () => {};
    const fetch = vi.fn<Fetch>(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
    const abort = new AbortController();
    const pending = transport(fetch).sync(
      { connectionId: cloudProfile.connectionId, accessToken: "synthetic-token" },
      abort.signal,
    );
    const assertion = expect(pending).resolves.toEqual({ ok: false, error: { code: "cancelled" } });
    abort.abort("synthetic-late-response-secret");
    await assertion;
    const stream = streamedResponse([JSON.stringify(encryptedSync())]);
    deliver(stream.response);
    await vi.waitFor(() => expect(stream.cancelled()).toBe(true));
    expect(stream.pulls()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight fetch once without retrying", async () => {
    const fetch = vi.fn<Fetch>(() => new Promise<Response>(() => {}));
    const abort = new AbortController();
    const pending = transport(fetch).sync(
      { connectionId: cloudProfile.connectionId, accessToken: "synthetic-token" },
      abort.signal,
    );
    const assertion = expect(pending).resolves.toEqual({ ok: false, error: { code: "cancelled" } });
    abort.abort(new Error("synthetic-abort-secret"));
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  it("applies a deadline even when injected fetch never settles", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<Fetch>(() => new Promise<Response>(() => {}));
    const pending = transport(fetch, { timeoutMs: 1000 }).sync({
      connectionId: cloudProfile.connectionId,
      accessToken: "synthetic-token",
    });
    const assertion = expect(pending).resolves.toEqual({ ok: false, error: { code: "timeout" } });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  it("keeps the deadline active through a stalled response body", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const pending = transport(fetch, { timeoutMs: 1000 }).sync({
      connectionId: cloudProfile.connectionId,
      accessToken: "synthetic-token",
    });
    const assertion = expect(pending).resolves.toEqual({ ok: false, error: { code: "timeout" } });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not let an endless immediately readable empty-chunk stream starve its deadline", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array());
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    expect(
      await transport(fetch, { timeoutMs: 20 }).sync({
        connectionId: cloudProfile.connectionId,
        accessToken: "synthetic-token",
      }),
    ).toEqual({ ok: false, error: { code: "timeout" } });
    expect(reads).toBeGreaterThan(0);
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a caller-aborted body read without leaking the abort reason", async () => {
    let signalReadStarted: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          signalReadStarted();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const abort = new AbortController();
    const pending = transport(fetch).sync(
      { connectionId: cloudProfile.connectionId, accessToken: "synthetic-token" },
      abort.signal,
    );
    const assertion = expect(pending).resolves.toEqual({ ok: false, error: { code: "cancelled" } });
    await readStarted;
    abort.abort("synthetic-body-abort-secret");
    await assertion;
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
