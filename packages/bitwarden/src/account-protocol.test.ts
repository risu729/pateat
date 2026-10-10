import { describe, expect, it, vi } from "vitest";
import { BITWARDEN_READ_PROTOCOL, createBitwardenTransport } from "./index";
import { passwordTokenRequest, tokenResponse } from "./__fixtures__/auth";
import {
  encryptedSync,
  jsonResponse,
  legacyPrelogin,
  passwordPrelogin,
} from "./__fixtures__/transport";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

describe("fixed Bitwarden read protocol", () => {
  it("publishes the pinned read profile without exposing a header override", () => {
    expect(BITWARDEN_READ_PROTOCOL).toEqual({ clientVersion: "2026.2.0", deviceType: 2 });
    expect(Object.isFrozen(BITWARDEN_READ_PROTOCOL)).toBe(true);
  });

  it.each([
    { kind: "cloud", region: "us" },
    { kind: "cloud", region: "eu" },
    { kind: "self-hosted", baseUrl: "https://vault.example.test:8443/" },
  ])("sends exactly the read profile on every owned endpoint for %j", async (environment) => {
    const fetch = vi.fn<Fetch>(async (url, init) => {
      if (url.endsWith("/accounts/prelogin/password")) return jsonResponse(passwordPrelogin);
      if (url.endsWith("/accounts/prelogin")) return jsonResponse(legacyPrelogin);
      if (url.endsWith("/sync")) return jsonResponse(encryptedSync());
      expect(new URLSearchParams(String(init.body)).get("client_id")).toBe("browser");
      return jsonResponse(tokenResponse());
    });
    const created = createBitwardenTransport(
      { connectionId: "synthetic-auth-a", environment },
      { fetch },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Synthetic profile rejected");
    const request = passwordTokenRequest();
    await Promise.all([
      created.data.prelogin({
        connectionId: request.connectionId,
        email: request.email,
        mode: "legacy",
      }),
      created.data.prelogin({
        connectionId: request.connectionId,
        email: request.email,
        mode: "password",
      }),
      created.data.passwordToken(request),
      created.data.refreshToken({
        connectionId: request.connectionId,
        refreshToken: "synthetic-refresh-token",
      }),
      created.data.sync({
        connectionId: request.connectionId,
        accessToken: "synthetic-access-token",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const [url, init] of fetch.mock.calls) {
      const headers = new Headers(init.headers);
      expect(headers.get("bitwarden-client-version")).toBe("2026.2.0");
      expect(headers.get("device-type")).toBe("2");
      expect(headers.has("client-version")).toBe(false);
      expect([...headers.keys()].sort()).toEqual(
        url.endsWith("/sync")
          ? ["accept", "authorization", "bitwarden-client-version", "device-type"]
          : ["accept", "bitwarden-client-version", "content-type", "device-type"],
      );
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
    }
  });

  it.each(["version_header_missing", "invalid_client_version"])(
    "never retries or advertises an older profile after %s",
    async (error) => {
      const fetch = vi.fn<Fetch>(async () => jsonResponse({ error }, { status: 400 }));
      const created = createBitwardenTransport(
        { connectionId: "synthetic-auth-a", environment: { kind: "cloud", region: "us" } },
        { fetch },
      );
      if (!created.ok) throw new Error("Synthetic profile rejected");
      expect(await created.data.passwordToken(passwordTokenRequest())).toEqual({
        ok: true,
        data: { kind: "interaction-required", reason: "protocol-compatibility" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new Headers(fetch.mock.calls[0]![1].headers).get("bitwarden-client-version")).toBe(
        "2026.2.0",
      );
    },
  );
});
