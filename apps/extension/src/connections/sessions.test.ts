import { describe, expect, it, vi } from "vitest";
import type { BitwardenTransport, PasswordTokenOutcome } from "@pateat/bitwarden";
import {
  accountNow,
  accountProfile,
  accountUserId,
  syntheticJwt,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { rawV1Account } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { memorySessionStore } from "./__fixtures__/sessions";
import { admitProviderSession } from "./session-record";
import { createProviderSessions } from "./sessions";

type Authenticated = Extract<PasswordTokenOutcome, { kind: "authenticated" }>;
const cacheRevision = "50000000-0000-4000-8000-000000000001";

function authenticated(refreshToken: string | null = "synthetic-refresh-token") {
  const raw = rawV1Account().token;
  return {
    kind: "authenticated",
    tokens: {
      accessToken: raw.access_token,
      tokenType: "Bearer",
      expiresIn: 3600,
      ...(refreshToken ? { refreshToken } : {}),
    },
    encryptedAccount: {
      Key: raw.Key,
      PrivateKey: raw.PrivateKey,
      Kdf: raw.Kdf,
      KdfIterations: raw.KdfIterations,
      KdfMemory: null,
      KdfParallelism: null,
      MasterPasswordPolicy: { minLength: 12 },
    },
  } satisfies Authenticated;
}
function harness() {
  let clock = accountNow * 1000;
  let cache: string | null = cacheRevision;
  const memory = memorySessionStore({ profile: accountProfile, cacheRevision: () => cache });
  const sessions = createProviderSessions({ storeFor: () => memory.store, nowMs: () => clock });
  const refreshToken = vi.fn<BitwardenTransport["refreshToken"]>();
  const transport = { refreshToken } as unknown as BitwardenTransport;
  const context = (signal = new AbortController().signal) => ({
    cacheRevision: cache ?? cacheRevision,
    transport,
    permitted: async () => true,
    signal,
  });
  const retain = () =>
    sessions.retain(
      accountProfile,
      authenticated(),
      { userId: accountUserId, email: v1Email },
      cacheRevision,
    );
  const refreshed = (claims: Record<string, unknown> = {}, refresh?: string | null) => ({
    ok: true as const,
    data: {
      kind: "authenticated" as const,
      tokens: {
        accessToken: syntheticJwt({ exp: Math.floor(clock / 1000) + 3600, ...claims }),
        tokenType: "Bearer" as const,
        expiresIn: 3600,
        ...(refresh ? { refreshToken: refresh } : {}),
      },
    },
  });
  return {
    sessions,
    memory,
    refreshToken,
    context,
    retain,
    refreshed,
    advance: (ms: number) => {
      clock += ms;
    },
    setCache: (revision: string | null) => {
      cache = revision;
    },
  };
}

describe("provider session record admission", () => {
  it("narrows the encrypted context and keeps tokens out of a refresh claim", async () => {
    const h = harness();
    expect(await h.retain()).toEqual({ ok: true, data: true });
    const stored = h.memory.raw() as Record<string, unknown> & {
      accessToken?: unknown;
      refreshToken?: unknown;
      receivedAt?: unknown;
      expiresIn?: unknown;
    };
    expect(stored).toMatchObject({
      state: "active",
      binding: { userId: accountUserId, email: v1Email },
      refreshToken: "synthetic-refresh-token",
    });
    expect(stored["encryptedAccount"]).not.toHaveProperty("MasterPasswordPolicy");
    const claim = {
      ...stored,
      state: "refreshing",
      claimId: crypto.randomUUID(),
      claimedAt: 1,
    };
    expect(admitProviderSession(claim, accountProfile).ok).toBe(false);
    const { accessToken: _a, refreshToken: _r, receivedAt: _t, expiresIn: _e, ...clean } = claim;
    expect(admitProviderSession(clean, accountProfile).ok).toBe(true);
  });
  it("rejects another profile, unknown members and oversized records", () => {
    const h = harness();
    void h;
    const base = {
      schemaVersion: 1,
      revision: crypto.randomUUID(),
      profile: accountProfile,
      binding: { userId: accountUserId, email: v1Email },
      encryptedAccount: {},
      state: "active",
      accessToken: "a.b.c",
      receivedAt: 1,
      expiresIn: 60,
    };
    expect(admitProviderSession(base, accountProfile).ok).toBe(true);
    expect(
      admitProviderSession(base, { ...accountProfile, connectionId: "other-connection" }),
    ).toEqual({ ok: false, error: { code: "account-mismatch" } });
    expect(admitProviderSession({ ...base, password: "x" }, accountProfile).ok).toBe(false);
    expect(
      admitProviderSession(
        { ...base, encryptedAccount: { Key: "x".repeat(300_000) } },
        accountProfile,
      ).ok,
    ).toBe(false);
  });
});

describe("explicit sync acquisition", () => {
  it("uses a live access token without any provider request", async () => {
    const h = harness();
    await h.retain();
    expect(await h.sessions.status(accountProfile)).toBe("active");
    const result = await h.sessions.acquire(accountProfile, h.context());
    expect(result).toMatchObject({ ok: true, data: { kind: "authenticated" } });
    expect(h.refreshToken).not.toHaveBeenCalled();
  });
  it("commits a token-free claim before HTTP and commits rotation before returning", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    expect(await h.sessions.status(accountProfile)).toBe("refresh-required");
    h.refreshToken.mockImplementationOnce(async (input) => {
      const during = h.memory.raw() as Record<string, unknown>;
      expect(during["state"]).toBe("refreshing");
      expect(JSON.stringify(during)).not.toContain("synthetic-refresh-token");
      expect(input).toEqual({
        connectionId: accountProfile.connectionId,
        refreshToken: "synthetic-refresh-token",
      });
      return h.refreshed({}, "synthetic-rotated-refresh");
    });
    const result = await h.sessions.acquire(accountProfile, h.context());
    expect(result.ok).toBe(true);
    expect(h.memory.raw()).toMatchObject({
      state: "active",
      refreshToken: "synthetic-rotated-refresh",
    });
    expect(h.memory.writes.map((entry) => entry?.state ?? null)).toEqual([
      "active",
      "refreshing",
      "active",
    ]);
  });
  it.each([undefined, null])(
    "keeps the captured refresh token when the response returns %s",
    async (refresh) => {
      const h = harness();
      await h.retain();
      h.advance(3_600_000);
      h.refreshToken.mockResolvedValueOnce(h.refreshed({}, refresh));
      expect((await h.sessions.acquire(accountProfile, h.context())).ok).toBe(true);
      expect(h.memory.raw()).toMatchObject({ refreshToken: "synthetic-refresh-token" });
    },
  );
  it("an unknown network outcome leaves the claim and never replays it", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce({ ok: false, error: { code: "network" } });
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "network" },
    });
    expect(await h.sessions.status(accountProfile)).toBe("reauthentication-required");
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.refreshToken).toHaveBeenCalledTimes(1);
  });
  it("a rejected refresh forgets the session", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce({
      ok: true,
      data: { kind: "rejected", reason: "refresh" },
    });
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.memory.raw()).toBeUndefined();
  });
  it("a refreshed subject that does not match the binding is never committed", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce(
      h.refreshed({ sub: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "account-mismatch" },
    });
    expect(h.memory.raw()).toBeUndefined();
  });
  it("only one of two concurrent writers may send the refresh request", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockImplementation(async () => h.refreshed());
    const results = await Promise.all([
      h.sessions.acquire(accountProfile, h.context()),
      h.sessions.acquire(accountProfile, h.context()),
    ]);
    expect(h.refreshToken).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({
      ok: false,
      error: { code: "storage-conflict" },
    });
  });
  it("forget during an in-flight refresh wins over the late commit", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.refreshToken.mockImplementationOnce(async () => {
      await held;
      return h.refreshed({}, "synthetic-rotated-refresh");
    });
    const pending = h.sessions.acquire(accountProfile, h.context());
    await vi.waitFor(() => expect(h.refreshToken).toHaveBeenCalled());
    expect(await h.sessions.forget(accountProfile)).toEqual({ ok: true, data: true });
    release();
    expect(await pending).toEqual({ ok: false, error: { code: "storage-conflict" } });
    expect(h.memory.raw()).toBeUndefined();
  });
  it("a changed cache authority refuses the claim, but later operations use the new revision", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    const stale = h.context();
    h.setCache("50000000-0000-4000-8000-000000000002");
    expect(await h.sessions.acquire(accountProfile, stale)).toEqual({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(h.refreshToken).not.toHaveBeenCalled();
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    expect((await h.sessions.acquire(accountProfile, h.context())).ok).toBe(true);
  });
  it("without a refresh token an expired session asks for password sign-in", async () => {
    const h = harness();
    await h.sessions.retain(
      accountProfile,
      authenticated(null),
      { userId: accountUserId, email: v1Email },
      cacheRevision,
    );
    h.advance(3_600_000);
    expect(await h.sessions.status(accountProfile)).toBe("reauthentication-required");
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.refreshToken).not.toHaveBeenCalled();
  });
  it("a missing permission sends nothing and writes no claim", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    expect(
      await h.sessions.acquire(accountProfile, { ...h.context(), permitted: async () => false }),
    ).toEqual({ ok: false, error: { code: "provider-permission-required" } });
    expect(h.refreshToken).not.toHaveBeenCalled();
    expect(h.memory.writes).toHaveLength(1);
  });
});

describe("forget", () => {
  it("deletes a corrupt record instead of reusing it", async () => {
    const h = harness();
    h.memory.set({ schemaVersion: 1, state: "active", accessToken: "x" });
    expect(await h.sessions.status(accountProfile)).toBe("unavailable");
    expect(await h.sessions.forget(accountProfile)).toEqual({ ok: true, data: true });
    expect(await h.sessions.status(accountProfile)).toBe("none");
  });
});
