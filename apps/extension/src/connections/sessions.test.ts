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
import { createProviderSessions, type RefreshReport } from "./sessions";

type Authenticated = Extract<PasswordTokenOutcome, { kind: "authenticated" }>;
const cacheRevision = "50000000-0000-4000-8000-000000000001";

function authenticated(
  refreshToken: string | null = "synthetic-refresh-token",
  accessToken = rawV1Account().token.access_token,
) {
  const raw = rawV1Account().token;
  return {
    kind: "authenticated",
    tokens: {
      accessToken,
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
  const reports: RefreshReport[] = [];
  /** A worker; a second one models the worker that starts after one stopped. */
  const worker = () =>
    createProviderSessions({
      storeFor: () => memory.store,
      nowMs: () => clock,
      report: (event) => reports.push(event),
    });
  const sessions = worker();
  const refreshToken = vi.fn<BitwardenTransport["refreshToken"]>();
  const transport = { refreshToken } as unknown as BitwardenTransport;
  const context = (signal = new AbortController().signal) => ({
    cacheRevision: cache ?? cacheRevision,
    transport,
    permitted: async () => true,
    signal,
  });
  const retain = (value: Authenticated = authenticated()) =>
    sessions.retain(
      accountProfile,
      value,
      { userId: accountUserId, email: v1Email },
      cacheRevision,
      clock,
    );
  const refreshed = (claims: Record<string, unknown> = {}, refresh?: string) => ({
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
    reports,
    worker,
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
  it("narrows the encrypted context and keeps only the refresh token in a claim", async () => {
    const h = harness();
    expect(await h.retain()).toEqual({ ok: true, data: expect.any(String) });
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
    const { accessToken: _a, receivedAt: _t, expiresIn: _e, ...resumable } = claim;
    expect(admitProviderSession(resumable, accountProfile).ok).toBe(true);
    const { refreshToken: _r, ...final } = resumable;
    expect(admitProviderSession(final, accountProfile).ok).toBe(true);
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
    expect(result).toMatchObject({ ok: true, data: { authenticated: { kind: "authenticated" } } });
    expect(h.refreshToken).not.toHaveBeenCalled();
  });
  it("commits a claim with only the refresh token before HTTP and commits rotation before returning", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    expect(await h.sessions.status(accountProfile)).toBe("refresh-required");
    h.refreshToken.mockImplementationOnce(async (input) => {
      const during = h.memory.raw() as Record<string, unknown>;
      expect(during).toMatchObject({
        state: "refreshing",
        refreshToken: "synthetic-refresh-token",
      });
      expect(during).not.toHaveProperty("accessToken");
      // An in-flight refresh is not reported as needing the password.
      expect(await h.sessions.status(accountProfile)).toBe("refresh-required");
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
  it("keeps the captured refresh token when the response returns none", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce(h.refreshed({}, undefined));
    expect((await h.sessions.acquire(accountProfile, h.context())).ok).toBe(true);
    expect(h.memory.raw()).toMatchObject({ refreshToken: "synthetic-refresh-token" });
  });
  it.each([
    { label: "network", error: { code: "network" } },
    { label: "timeout", error: { code: "timeout" } },
    { label: "429", error: { code: "http-error", status: 429 } },
    { label: "503", error: { code: "http-error", status: 503 } },
  ] as const)("a refresh that fails with $label restores the session", async ({ error }) => {
    const h = harness();
    await h.retain();
    const before = h.memory.raw() as Record<string, unknown>;
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce({ ok: false, error });
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({ ok: false, error });
    const restored = h.memory.raw() as Record<string, unknown>;
    expect(restored).toEqual({ ...before, revision: expect.any(String) });
    expect(restored["revision"]).not.toBe(before["revision"]);
    expect(await h.sessions.status(accountProfile)).toBe("refresh-required");
    // The same refresh token is sent again; the provider reuses it.
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    const retried = await h.sessions.acquire(accountProfile, h.context());
    expect(retried.ok).toBe(true);
    expect(h.refreshToken).toHaveBeenLastCalledWith({
      connectionId: accountProfile.connectionId,
      refreshToken: "synthetic-refresh-token",
    });
  });
  it.each([
    { label: "401", error: { code: "http-error", status: 401 } },
    { label: "redirect", error: { code: "redirect" } },
    { label: "invalid-response", error: { code: "invalid-response" } },
  ] as const)(
    "a refresh that fails with $label keeps the claim without its token",
    async ({ error }) => {
      const h = harness();
      await h.retain();
      h.advance(3_600_000);
      h.refreshToken.mockResolvedValueOnce({ ok: false, error });
      expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({ ok: false, error });
      expect(h.memory.raw()).toMatchObject({ state: "refreshing" });
      expect(h.memory.raw()).not.toHaveProperty("refreshToken");
      expect(await h.sessions.status(accountProfile)).toBe("reauthentication-required");
      // A worker that starts later does not resume it either.
      expect(await h.worker().acquire(accountProfile, h.context())).toEqual({
        ok: false,
        error: { code: "setup-reauthentication-required" },
      });
      expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
        ok: false,
        error: { code: "setup-reauthentication-required" },
      });
      expect(h.refreshToken).toHaveBeenCalledTimes(1);
    },
  );
  it("a password session retained during a failing refresh is not overwritten", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.refreshToken.mockImplementationOnce(async () => {
      await held;
      return { ok: false, error: { code: "network" } };
    });
    const pending = h.sessions.acquire(accountProfile, h.context());
    await vi.waitFor(() => expect(h.refreshToken).toHaveBeenCalled());
    const retained = await h.retain(authenticated("synthetic-new-refresh-token"));
    expect(retained.ok).toBe(true);
    release();
    expect(await pending).toEqual({ ok: false, error: { code: "network" } });
    expect((h.memory.raw() as Record<string, unknown>)["refreshToken"]).toBe(
      "synthetic-new-refresh-token",
    );
  });
  it("a restore that cannot be written leaves the claim with its token to resume", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockImplementationOnce(async () => {
      h.memory.failNext("storage-uncertain");
      return { ok: false, error: { code: "network" } };
    });
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "network" },
    });
    expect(h.memory.raw()).toMatchObject({
      state: "refreshing",
      refreshToken: "synthetic-refresh-token",
    });
    expect(await h.sessions.status(accountProfile)).toBe("refresh-required");
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    expect((await h.sessions.acquire(accountProfile, h.context())).ok).toBe(true);
  });
  it("forget during a refresh that later fails is not undone by the restore", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.refreshToken.mockImplementationOnce(async () => {
      await held;
      return { ok: false, error: { code: "network" } };
    });
    const pending = h.sessions.acquire(accountProfile, h.context());
    await vi.waitFor(() => expect(h.refreshToken).toHaveBeenCalled());
    expect(await h.sessions.forget(accountProfile)).toEqual({ ok: true, data: true });
    release();
    expect(await pending).toEqual({ ok: false, error: { code: "network" } });
    expect(h.memory.raw()).toBeUndefined();
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
      accountNow * 1000,
    );
    h.advance(3_600_000);
    expect(await h.sessions.status(accountProfile)).toBe("reauthentication-required");
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.refreshToken).not.toHaveBeenCalled();
  });
  it("a caller abort after the claim commits still completes and commits the rotation", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    const controller = new AbortController();
    h.refreshToken.mockImplementationOnce(async (_input, signal) => {
      // The options page closes while the claimed request is in flight.
      controller.abort();
      expect(signal).toBeUndefined();
      return h.refreshed({}, "synthetic-rotated-refresh");
    });
    expect(await h.sessions.acquire(accountProfile, h.context(controller.signal))).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    const rotated = h.memory.raw() as { state: string; accessToken: string; refreshToken: string };
    expect(rotated).toMatchObject({ state: "active", refreshToken: "synthetic-rotated-refresh" });
    const next = await h.sessions.acquire(accountProfile, h.context());
    expect(next).toMatchObject({
      ok: true,
      data: { authenticated: { tokens: { accessToken: rotated.accessToken } } },
    });
    expect(h.refreshToken).toHaveBeenCalledTimes(1);
  });
  it("a JWT exp earlier than the response lifetime triggers a refresh", async () => {
    const h = harness();
    await h.retain(
      authenticated("synthetic-refresh-token", syntheticJwt({ exp: accountNow + 120 })),
    );
    expect(await h.sessions.status(accountProfile)).toBe("active");
    // Within 60 s of `exp`, although `receivedAt + expires_in` is an hour away.
    h.advance(61_000);
    expect(await h.sessions.status(accountProfile)).toBe("refresh-required");
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    expect((await h.sessions.acquire(accountProfile, h.context())).ok).toBe(true);
    expect(h.refreshToken).toHaveBeenCalledTimes(1);
  });
  it("records the response receipt time, not when the caller retains it", async () => {
    const h = harness();
    await h.sessions.retain(
      accountProfile,
      authenticated(),
      { userId: accountUserId, email: v1Email },
      cacheRevision,
      accountNow * 1000 - 3_550_000,
    );
    expect(await h.sessions.status(accountProfile)).toBe("refresh-required");
  });
  it("a bound discard leaves a newer session in place", async () => {
    const h = harness();
    await h.retain();
    const used = await h.sessions.acquire(accountProfile, h.context());
    if (!used.ok) throw new Error("Synthetic acquire failed");
    await h.retain();
    const newer = h.memory.raw() as { revision: string };
    expect(newer.revision).not.toBe(used.data.revision);
    expect(await h.sessions.discard(accountProfile, used.data.revision)).toEqual({
      ok: true,
      data: true,
    });
    expect(h.memory.raw()).toMatchObject({ revision: newer.revision });
    expect(await h.sessions.discard(accountProfile, newer.revision)).toEqual({
      ok: true,
      data: true,
    });
    expect(h.memory.raw()).toBeUndefined();
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

describe("a refresh left by a stopped worker", () => {
  /** Starts a refresh in one worker whose request never returns, as when it stops. */
  async function abandoned() {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockImplementationOnce(() => new Promise(() => undefined));
    void h.sessions.acquire(accountProfile, h.context());
    await vi.waitFor(() => expect(h.refreshToken).toHaveBeenCalledTimes(1));
    return h;
  }
  it("is resumed by the next worker with the same refresh token", async () => {
    const h = await abandoned();
    const next = h.worker();
    expect(await next.status(accountProfile)).toBe("refresh-required");
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    const result = await next.acquire(accountProfile, h.context());
    expect(result.ok).toBe(true);
    expect(h.refreshToken).toHaveBeenLastCalledWith({
      connectionId: accountProfile.connectionId,
      refreshToken: "synthetic-refresh-token",
    });
    expect(h.memory.raw()).toMatchObject({
      state: "active",
      refreshToken: "synthetic-refresh-token",
    });
    expect(await next.status(accountProfile)).toBe("active");
  });
  it("is not taken over by a second acquire in the worker that holds it", async () => {
    const h = await abandoned();
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(h.refreshToken).toHaveBeenCalledTimes(1);
  });
  it("stays resumable after a resumed request fails with a network error", async () => {
    const h = await abandoned();
    const next = h.worker();
    h.refreshToken.mockResolvedValueOnce({ ok: false, error: { code: "network" } });
    expect(await next.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "network" },
    });
    expect(h.memory.raw()).toMatchObject({
      state: "refreshing",
      refreshToken: "synthetic-refresh-token",
    });
    expect(await next.status(accountProfile)).toBe("refresh-required");
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    expect((await next.acquire(accountProfile, h.context())).ok).toBe(true);
  });
  it("drops its token when the resumed request fails without a retry", async () => {
    const h = await abandoned();
    h.refreshToken.mockResolvedValueOnce({ ok: false, error: { code: "invalid-response" } });
    const next = h.worker();
    expect(await next.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "invalid-response" },
    });
    expect(h.memory.raw()).not.toHaveProperty("refreshToken");
    expect(await next.status(accountProfile)).toBe("reauthentication-required");
  });
  it("stays resumable when the rotation commit cannot be written", async () => {
    const h = await abandoned();
    const next = h.worker();
    h.refreshToken.mockImplementationOnce(async () => {
      h.memory.failNext("storage-uncertain");
      return h.refreshed();
    });
    expect(await next.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
    expect(await next.status(accountProfile)).toBe("refresh-required");
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    expect((await next.acquire(accountProfile, h.context())).ok).toBe(true);
  });
  it("two new workers resume it at most once", async () => {
    const h = await abandoned();
    h.refreshToken.mockImplementation(async () => h.refreshed());
    const results = await Promise.all([
      h.worker().acquire(accountProfile, h.context()),
      h.worker().acquire(accountProfile, h.context()),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(h.refreshToken).toHaveBeenCalledTimes(2);
  });
  it("forget during a resumed request wins over its late commit", async () => {
    const h = await abandoned();
    const next = h.worker();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.refreshToken.mockImplementationOnce(async () => {
      await held;
      return h.refreshed();
    });
    const pending = next.acquire(accountProfile, h.context());
    await vi.waitFor(() => expect(h.refreshToken).toHaveBeenCalledTimes(2));
    expect(await next.forget(accountProfile)).toEqual({ ok: true, data: true });
    release();
    expect(await pending).toEqual({ ok: false, error: { code: "storage-conflict" } });
    expect(h.memory.raw()).toBeUndefined();
  });
  it("forget removes it", async () => {
    const h = await abandoned();
    expect(await h.worker().forget(accountProfile)).toEqual({ ok: true, data: true });
    expect(h.memory.raw()).toBeUndefined();
  });
});

describe("refresh reports for the local log", () => {
  const connectionId = accountProfile.connectionId;
  it("reports a committed refresh once and nothing for a live token", async () => {
    const h = harness();
    await h.retain();
    expect((await h.sessions.acquire(accountProfile, h.context())).ok).toBe(true);
    expect(h.reports).toEqual([]);
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce(h.refreshed());
    expect((await h.sessions.acquire(accountProfile, h.context())).ok).toBe(true);
    expect(h.reports).toEqual([{ connectionId, outcome: "refreshed" }]);
  });
  it.each([
    {
      error: { code: "http-error", status: 503 },
      report: { outcome: "restored", cause: "http-error", status: 503 },
    },
    { error: { code: "timeout" }, report: { outcome: "restored", cause: "timeout" } },
    {
      error: { code: "http-error", status: 401 },
      report: { outcome: "failed", cause: "http-error", status: 401 },
    },
    {
      error: { code: "invalid-response" },
      report: { outcome: "failed", cause: "invalid-response" },
    },
  ] as const)("reports $error.code $error.status as $report.outcome", async ({ error, report }) => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce({ ok: false, error });
    await h.sessions.acquire(accountProfile, h.context());
    expect(h.reports).toEqual([{ connectionId, ...report }]);
  });
  it("reports why no refresh was sent", async () => {
    const h = harness();
    // No session yet: the sync sign-in needs the password.
    await h.sessions.acquire(accountProfile, h.context());
    await h.retain();
    h.advance(3_600_000);
    const denied = { ...h.context(), permitted: async () => false };
    await h.sessions.acquire(accountProfile, denied);
    const aborted = new AbortController();
    aborted.abort();
    await h.sessions.acquire(accountProfile, h.context(aborted.signal));
    expect(h.refreshToken).not.toHaveBeenCalled();
    expect(h.reports).toEqual([
      { connectionId, outcome: "not-sent", cause: "no-session" },
      { connectionId, outcome: "not-sent", cause: "provider-permission-required" },
      { connectionId, outcome: "not-sent", cause: "cancelled" },
    ]);
  });
  it("reports a restore that could not be written as failed", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockImplementationOnce(async () => {
      h.memory.failNext("storage-uncertain");
      return { ok: false, error: { code: "network" } };
    });
    await h.sessions.acquire(accountProfile, h.context());
    expect(h.reports).toEqual([{ connectionId, outcome: "failed", cause: "network" }]);
  });
  it("reports a rejection and a subject mismatch", async () => {
    const h = harness();
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce({
      ok: true,
      data: { kind: "rejected", reason: "refresh" },
    });
    await h.sessions.acquire(accountProfile, h.context());
    await h.retain();
    h.advance(3_600_000);
    h.refreshToken.mockResolvedValueOnce(h.refreshed({ sub: "another-user" }));
    await h.sessions.acquire(accountProfile, h.context());
    expect(h.reports).toEqual([
      { connectionId, outcome: "rejected", cause: "refresh" },
      { connectionId, outcome: "account-mismatch" },
    ]);
  });
  it("a throwing report does not change the refresh", async () => {
    let clock = accountNow * 1000;
    const memory = memorySessionStore({
      profile: accountProfile,
      cacheRevision: () => cacheRevision,
    });
    const sessions = createProviderSessions({
      storeFor: () => memory.store,
      nowMs: () => clock,
      report: () => {
        throw new Error("log unavailable");
      },
    });
    await sessions.retain(
      accountProfile,
      authenticated(),
      { userId: accountUserId, email: v1Email },
      cacheRevision,
      clock,
    );
    clock += 3_600_000;
    const refreshToken = vi.fn<BitwardenTransport["refreshToken"]>().mockResolvedValueOnce({
      ok: true,
      data: {
        kind: "authenticated",
        tokens: {
          accessToken: syntheticJwt({ exp: Math.floor(clock / 1000) + 3600 }),
          tokenType: "Bearer",
          expiresIn: 3600,
        },
      },
    });
    const result = await sessions.acquire(accountProfile, {
      cacheRevision,
      transport: { refreshToken } as unknown as BitwardenTransport,
      permitted: async () => true,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(await sessions.status(accountProfile)).toBe("active");
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
  it("forgets or replaces a record bound to another profile, but never reuses it", async () => {
    const h = harness();
    await h.retain();
    const other: Record<string, unknown> = {
      ...(h.memory.raw() as Record<string, unknown>),
      profile: { ...accountProfile, connectionId: crypto.randomUUID() },
    };
    h.memory.set(other);
    expect(await h.sessions.status(accountProfile)).toBe("unavailable");
    expect(await h.sessions.acquire(accountProfile, h.context())).toEqual({
      ok: false,
      error: { code: "account-mismatch" },
    });
    expect(await h.sessions.forget(accountProfile)).toEqual({ ok: true, data: true });
    expect(h.memory.raw()).toBeUndefined();
    h.memory.set(other);
    // A password sign-in replaces it.
    expect(await h.retain()).toEqual({ ok: true, data: expect.any(String) });
    expect(await h.sessions.status(accountProfile)).toBe("active");
  });
});
