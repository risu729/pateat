import { afterEach, describe, expect, it, vi } from "vitest";
import { createBitwardenTransport } from "./transport";
import {
  authConnectionId,
  authDeviceId,
  passwordTokenRequest,
  tokenResponse,
} from "./__fixtures__/auth";
import { jsonResponse, streamedResponse } from "./__fixtures__/transport";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const profile = {
  connectionId: authConnectionId,
  environment: { kind: "cloud", region: "us" },
} as const;
const refreshRequest = { connectionId: authConnectionId, refreshToken: "synthetic-refresh-token" };
const tokens = {
  accessToken: "synthetic-access-token",
  tokenType: "Bearer",
  expiresIn: 3600,
  refreshToken: "synthetic-refresh-token",
};
function client(fetch: Fetch, options: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  const created = createBitwardenTransport(profile, { fetch, ...options });
  if (!created.ok) throw new Error("Synthetic auth transport rejected");
  return created.data;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fixed password and refresh grants", () => {
  it.each([
    [{ kind: "cloud", region: "us" }, "https://identity.bitwarden.com/connect/token"],
    [{ kind: "cloud", region: "eu" }, "https://identity.bitwarden.eu/connect/token"],
    [
      { kind: "self-hosted", baseUrl: "https://vault.example.test:8443/" },
      "https://vault.example.test:8443/identity/connect/token",
    ],
  ])("uses only the selected identity token route for %j", async (environment, expectedUrl) => {
    const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse(tokenResponse()));
    const created = createBitwardenTransport({ ...profile, environment }, { fetch });
    if (!created.ok) throw new Error("Synthetic environment rejected");
    await created.data.passwordToken(passwordTokenRequest());
    await created.data.refreshToken(refreshRequest);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([expectedUrl, expectedUrl]);
  });

  it("sends precisely the official password grant fields and returns authenticated-but-encrypted metadata", async () => {
    const payload = { ...tokenResponse(), unexpectedServerSecret: "synthetic-unknown-secret" };
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload));
    const result = await client(fetch).passwordToken(passwordTokenRequest());
    expect(result).toMatchObject({ ok: true, data: { kind: "authenticated", tokens } });
    if (result.ok && result.data.kind === "authenticated") {
      expect(JSON.stringify(result.data.encryptedAccount)).toContain(
        "99.synthetic-encrypted-user-key",
      );
      expect(JSON.stringify(result.data.encryptedAccount)).toContain("different-vault-unlock-salt");
      expect(JSON.stringify(result.data)).not.toContain("synthetic-unknown-secret");
      expect(result.data).not.toHaveProperty("unlocked");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    const request = new Request(url, init);
    expect(request.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      grant_type: "password",
      username: "synthetic-user@example.test",
      password: passwordTokenRequest().masterPasswordHash,
      scope: "api offline_access",
      client_id: "browser",
      deviceType: "2",
      deviceIdentifier: authDeviceId,
      deviceName: "Pateat synthetic host",
    });
    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded; charset=utf-8",
    );
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("device-type")).toBe("2");
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("client-version")).toBe(false);
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([0, 1] as const)(
    "sends explicit provider %s, verification inputs and remember preference without altering them",
    async (provider) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(tokenResponse()));
      await client(fetch).passwordToken({
        ...passwordTokenRequest(),
        twoFactor: { provider, token: "012345+&", remember: true },
        newDeviceOtp: "000007",
      });
      const [url, init] = fetch.mock.calls[0]!;
      const body = new URLSearchParams(await new Request(url, init).text());
      expect(body.get("twoFactorProvider")).toBe(String(provider));
      expect(body.get("twoFactorToken")).toBe("012345+&");
      expect(body.get("twoFactorRemember")).toBe("1");
      expect(body.get("newDeviceOtp")).toBe("000007");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, null])(
    "accepts an absent/null refresh token without inventing one %#",
    async (refreshToken) => {
      const payload: Record<string, unknown> = { ...tokenResponse(), token_type: "bearer" };
      if (refreshToken === undefined) delete payload["refresh_token"];
      else payload["refresh_token"] = refreshToken;
      const fetch = vi.fn<Fetch>().mockImplementation(async () => jsonResponse(payload));
      const transport = client(fetch);
      const expected = { accessToken: tokens.accessToken, tokenType: "Bearer", expiresIn: 3600 };
      expect(await transport.refreshToken(refreshRequest)).toEqual({
        ok: true,
        data: { kind: "authenticated", tokens: expected },
      });
      expect(await transport.passwordToken(passwordTokenRequest())).toMatchObject({
        ok: true,
        data: { kind: "authenticated", tokens: expected },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("defaults explicit MFA remember to false and retains validated email spelling", async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(tokenResponse()));
    await client(fetch).passwordToken({
      ...passwordTokenRequest(),
      email: "Synthetic-User@Example.Test",
      twoFactor: { provider: 0, token: "123456" },
    });
    const [url, init] = fetch.mock.calls[0]!;
    const body = new URLSearchParams(await new Request(url, init).text());
    expect(body.get("twoFactorRemember")).toBe("0");
    expect(body.get("username")).toBe("Synthetic-User@Example.Test");
  });

  it("refreshes once with only its fixed grant fields and no password or unlock metadata", async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(tokenResponse()));
    expect(await client(fetch).refreshToken(refreshRequest)).toEqual({
      ok: true,
      data: { kind: "authenticated", tokens },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    const request = new Request(url, init);
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      grant_type: "refresh_token",
      client_id: "browser",
      refresh_token: "synthetic-refresh-token",
    });
    expect(request.headers.get("device-type")).toBe("2");
    expect(request.headers.has("authorization")).toBe(false);
  });

  it.each([
    { ...passwordTokenRequest(), connectionId: "another-connection" },
    { ...passwordTokenRequest(), password: "raw-master-password" },
    { ...passwordTokenRequest(), masterPasswordHash: "not-a-base64-hash" },
    { ...passwordTokenRequest(), masterPasswordHash: btoa("short") },
    {
      ...passwordTokenRequest(),
      masterPasswordHash: passwordTokenRequest().masterPasswordHash.slice(0, -2) + "x=",
    },
    { ...passwordTokenRequest(), device: { identifier: "not-a-uuid", name: "Pateat" } },
    { ...passwordTokenRequest(), twoFactor: { provider: 5, token: "recovery-code" } },
    { ...passwordTokenRequest(), twoFactor: { provider: 7, token: "unimplemented-webauthn" } },
    { ...passwordTokenRequest(), twoFactor: { provider: 0, token: "", remember: false } },
    { ...passwordTokenRequest(), grant_type: "client_credentials" },
    { ...passwordTokenRequest(), endpoint: "https://outside.example.test/token" },
  ])("rejects unauthorized password request shape before fetch %#", async (input) => {
    const fetch = vi.fn<Fetch>();
    const result = await client(fetch).passwordToken(input);
    expect(result).toEqual({
      ok: false,
      error: {
        code:
          input.connectionId === profile.connectionId ? "invalid-request" : "connection-mismatch",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...refreshRequest, password: "must-not-fallback" },
    { ...refreshRequest, refreshToken: "" },
    { ...refreshRequest, connectionId: "another-connection" },
  ])("rejects invalid refresh input without password fallback %#", async (input) => {
    const fetch = vi.fn<Fetch>();
    const result = await client(fetch).refreshToken(input);
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("sanitized explicit authentication states", () => {
  it.each([
    {
      TwoFactorProviders2: {
        "0": null,
        "1": { Email: "synthetic-private-address" },
        "7": { challenge: "synthetic-private-challenge" },
      },
    },
    {
      twoFactorProviders2: {
        "0": null,
        "1": { Email: "synthetic-private-address" },
        "7": { challenge: "synthetic-private-challenge" },
      },
    },
    { TwoFactorProviders: ["0", "1", "7"] },
    { twoFactorProviders: [0, 1, 7] },
  ])(
    "reports provider availability without returning challenge parameters %#",
    async (challenge) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: "invalid_grant",
            error_description: "synthetic-private-message",
            ...challenge,
          },
          { status: 400 },
        ),
      );
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: true,
        data: { kind: "mfa-required", providers: [0, 1, 7], supportedProviders: [0, 1] },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["version_header_missing", "invalid_client_version"])(
    "reports protocol compatibility for %s without advertising a fabricated official version",
    async (error) => {
      const fetch = vi
        .fn<Fetch>()
        .mockResolvedValue(
          jsonResponse(
            { error, error_description: "synthetic-private-version-details" },
            { status: 400 },
          ),
        );
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: true,
        data: { kind: "interaction-required", reason: "protocol-compatibility" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new Headers(fetch.mock.calls[0]![1].headers).has("client-version")).toBe(false);
    },
  );

  it.each(["version_header_missing", "invalid_client_version"])(
    "rejects a contradictory HTTP 200 compatibility error %s instead of authenticating",
    async (error) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse({ ...tokenResponse(), error }));
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: false,
        error: { code: "invalid-response" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts consistent modern and legacy provider availability in canonical sorted order", async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: "invalid_grant",
          TwoFactorProviders2: { "0": null, "1": null, "7": null },
          TwoFactorProviders: ["7", "1", "0"],
        },
        { status: 400 },
      ),
    );
    expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
      ok: true,
      data: { kind: "mfa-required", providers: [0, 1, 7], supportedProviders: [0, 1] },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains unsupported numeric MFA availability without silently selecting another method", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: "invalid_grant", TwoFactorProviders2: { "99": { secret: "synthetic-secret" } } },
          { status: 400 },
        ),
      );
    expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
      ok: true,
      data: { kind: "mfa-required", providers: [99], supportedProviders: [] },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["New device verification required", false],
    ["Invalid New Device OTP", true],
  ])(
    "reports device verification (%s) without sending a second request",
    async (error_description, invalidOtp) => {
      const fetch = vi
        .fn<Fetch>()
        .mockResolvedValue(
          jsonResponse({ error: "device_error", error_description }, { status: 400 }),
        );
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: true,
        data: { kind: "new-device-verification-required", invalidOtp },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      { error: "invalid_grant", ErrorModel: { Message: "Two-step token is invalid. Try again." } },
      "mfa",
    ],
    [
      {
        error: "invalid_grant",
        ErrorModel: { Message: "Username or password is incorrect. Try again." },
      },
      "credentials",
    ],
  ])("returns a fixed rejection reason without server message %#", async (payload, reason) => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload, { status: 400 }));
    expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
      ok: true,
      data: { kind: "rejected", reason },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: "invalid_grant" },
    {
      error: "invalid_grant",
      error_description: "synthetic organization policy requires another authentication flow",
    },
    {
      error: "invalid_grant",
      ErrorModel: { Message: "synthetic private policy message with no organization identifier" },
    },
  ])(
    "withholds credential rejection for unrecognized invalid-grant policy details %#",
    async (payload) => {
      // Synthetic unknown policy text, not a claimed official SSO description or an implemented SSO flow.
      const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload, { status: 400 }));
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: true,
        data: { kind: "interaction-required", reason: "unsupported-challenge" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not replay a rejected refresh or fall back to a password grant", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: "invalid_grant", error_description: "synthetic-refresh-secret" },
          { status: 400 },
        ),
      );
    expect(await client(fetch).refreshToken(refreshRequest)).toEqual({
      ok: true,
      data: { kind: "rejected", reason: "refresh" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ error: "invalid_grant", SsoOrganizationIdentifier: "synthetic-organization-secret" }, "sso"],
    [
      { error: "invalid_grant", HCaptcha_SiteKey: "synthetic-captcha-site-key" },
      "unsupported-challenge",
    ],
    [
      { error: "invalid_grant", captchaBypassToken: "synthetic-captcha-bypass-secret" },
      "unsupported-challenge",
    ],
    [
      { error: "future_challenge", error_description: "synthetic-unknown-secret" },
      "unsupported-challenge",
    ],
    [
      { error: "device_error", error_description: "synthetic-unknown-device-secret" },
      "unsupported-challenge",
    ],
  ])(
    "reports required interaction without returning provider-controlled details %#",
    async (payload, reason) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(payload, { status: 400 }));
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: true,
        data: { kind: "interaction-required", reason },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      TwoFactorProviders2: { "0": null },
      SsoOrganizationIdentifier: "synthetic-private-org",
      reason: "sso",
    },
    {
      TwoFactorProviders2: { "0": null },
      futureChallenge: "synthetic-private-challenge",
      reason: "unsupported-challenge",
    },
  ])(
    "does not let MFA availability bypass a concurrent interaction guard %#",
    async ({ reason, ...challenge }) => {
      const fetch = vi
        .fn<Fetch>()
        .mockResolvedValue(jsonResponse({ error: "invalid_grant", ...challenge }, { status: 400 }));
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: true,
        data: { kind: "interaction-required", reason },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { TwoFactorProviders: ["not-an-id"] },
    { TwoFactorProviders: [256] },
    { TwoFactorProviders: [] },
    { TwoFactorProviders2: { "-1": null } },
    { TwoFactorProviders2: { "0": [] } },
    { TwoFactorProviders2: { "0": null }, twoFactorProviders2: { "1": null } },
    { TwoFactorProviders2: { "0": null }, TwoFactorProviders: ["1"] },
    { TwoFactorProviders2: { "0": null }, TwoFactorProviders: ["bad"] },
    { TwoFactorProviders2: null, TwoFactorProviders: ["0"] },
    { errorModel: { message: 123 } },
    { SsoOrganizationIdentifier: 123 },
  ])(
    "rejects malformed or conflicting challenge fields without leaking parameters %#",
    async (challenge) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: "invalid_grant",
            error_description: "synthetic-secret-description",
            ...challenge,
          },
          { status: 400 },
        ),
      );
      expect(await client(fetch).passwordToken(passwordTokenRequest())).toEqual({
        ok: false,
        error: { code: "invalid-response" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe.each(["passwordToken", "refreshToken"] as const)("bounded %s HTTP response", (method) => {
  const input = method === "passwordToken" ? passwordTokenRequest() : refreshRequest;

  it("rejects pre-aborted work before any fetch", async () => {
    const controller = new AbortController();
    controller.abort("synthetic-secret-cancel-reason");
    const fetch = vi.fn<Fetch>();
    expect(await client(fetch)[method](input, controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts in flight without passing caller reason or retrying", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<Fetch>().mockImplementation(async () => new Promise<Response>(() => {}));
    const pending = client(fetch)[method](input, controller.signal);
    controller.abort("synthetic-secret-cancel-reason");
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = fetch.mock.calls[0]![1].signal;
    expect(sent?.aborted).toBe(true);
    expect(sent?.reason).not.toBe("synthetic-secret-cancel-reason");
  });

  it("cancels a stalled response body instead of waiting or replaying the grant", async () => {
    const controller = new AbortController();
    let entered = () => {};
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            entered();
          },
          cancel: cancelled,
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
    const fetch = vi.fn<Fetch>().mockResolvedValue(response);
    const pending = client(fetch)[method](input, controller.signal);
    await reading;
    controller.abort("synthetic-secret-cancel-reason");
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("times out a noncooperative fetch with one request only", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<Fetch>().mockImplementation(async () => new Promise<Response>(() => {}));
    const pending = client(fetch, { timeoutMs: 20 })[method](input);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ ok: false, error: { code: "timeout" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
  });

  it.each([
    [
      new Response("synthetic-secret", {
        status: 302,
        headers: { location: "https://outside.example.test" },
      }),
      "redirect",
    ],
    [
      new Response("synthetic-secret", { status: 200, headers: { "content-type": "text/html" } }),
      "invalid-response",
    ],
    [
      new Response('{"access_token":', { headers: { "content-type": "application/json" } }),
      "invalid-response",
    ],
  ])("rejects redirect or malformed body without fallback %#", async (response, code) => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(response);
    expect(await client(fetch)[method](input)).toEqual({ ok: false, error: { code } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an injected cross-origin final response even with HTTP 200", async () => {
    const response = jsonResponse(tokenResponse());
    Object.defineProperty(response, "url", { value: "https://outside.example.test/token" });
    const fetch = vi.fn<Fetch>().mockResolvedValue(response);
    expect(await client(fetch)[method](input)).toEqual({ ok: false, error: { code: "redirect" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([200, 400])(
    "enforces streamed byte limits for HTTP %s before consuming the rest of a secret-bearing body",
    async (status) => {
      const streamed = streamedResponse(
        ['{"access_token":"', "a".repeat(40), "synthetic-secret-unread"],
        { "content-length": "1" },
      );
      const fetch = vi
        .fn<Fetch>()
        .mockResolvedValue(
          new Response(streamed.response.body, { status, headers: streamed.response.headers }),
        );
      expect(await client(fetch, { maxResponseBytes: 32 })[method](input)).toEqual({
        ok: false,
        error: { code: "response-too-large" },
      });
      expect(streamed.cancelled()).toBe(true);
      expect(streamed.pulls()).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 429, 500])(
    "sanitizes HTTP %s without reading it as an authentication challenge",
    async (status) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: "invalid_grant",
            TwoFactorProviders2: { "0": null },
            error_description: "synthetic-private-server-message",
          },
          { status },
        ),
      );
      expect(await client(fetch)[method](input)).toEqual({
        ok: false,
        error: { code: "http-error", status },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes a network exception containing credentials and tokens", async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockRejectedValue(
        new Error(
          "synthetic-refresh-token synthetic-master-password https://private-provider.test",
        ),
      );
    expect(await client(fetch)[method](input)).toEqual({ ok: false, error: { code: "network" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { ...tokenResponse(), token_type: "Basic" },
    { ...tokenResponse(), expires_in: 0 },
    { ...tokenResponse(), expires_in: "3600" },
    { ...tokenResponse(), access_token: "token\r\nsecret" },
    { ...tokenResponse(), refresh_token: {} },
    { ...tokenResponse(), error: "invalid_grant" },
  ])("rejects malformed success metadata without exposing raw response %#", async (response) => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(jsonResponse(response));
    expect(await client(fetch)[method](input)).toEqual({
      ok: false,
      error: { code: "invalid-response" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
