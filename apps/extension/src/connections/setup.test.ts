import { afterEach, describe, expect, it, vi } from "vitest";
import { createBitwardenTransport, type BitwardenProfile } from "@pateat/bitwarden";
import { createConnectionSetupService } from "./setup";
import type {
  BitwardenConnectionConfiguration,
  ConnectionSetupDependencies,
  SetupBegin,
} from "./types";
import {
  accountNow,
  accountProfile,
  accountUserId,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { rawCustomAccount } from "../../../../packages/bitwarden/src/__fixtures__/connection";
import { rawV1Account } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email, v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { activeEntry } from "../vault/__fixtures__/vault";
import type { VaultEntry } from "../vault/record";
import { createProviderSessions } from "./sessions";
import { memorySessionStore } from "./__fixtures__/sessions";

const authenticationHash = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function newInput(): Extract<SetupBegin, { kind: "new" }> {
  return {
    kind: "new",
    environment: { kind: "cloud", region: "us" },
    label: "Synthetic personal vault",
    email: v1Email,
    password: v1Password,
    enabled: true,
  };
}
const closers: (() => unknown)[] = [];
function harness(options: { existing?: boolean } = {}) {
  let clock = accountNow * 1000;
  let permission = true;
  let durable: VaultEntry | null = options.existing ? activeEntry() : null;
  let raw = rawCustomAccount();
  const events: string[] = [];
  const configurations = new Map<string, BitwardenConnectionConfiguration>();
  if (options.existing)
    configurations.set(accountProfile.connectionId, {
      profile: structuredClone(accountProfile),
      label: "Synthetic personal vault",
      email: v1Email,
      deviceIdentifier: crypto.randomUUID(),
    });
  const registry = {
    list: vi.fn(async () => structuredClone([...configurations.values()])),
    get: vi.fn(async (id: string) => structuredClone(configurations.get(id))),
    put: vi.fn(async (config: BitwardenConnectionConfiguration) => {
      configurations.set(config.profile.connectionId, structuredClone(config));
    }),
  };
  const permissions = {
    contains: vi.fn(async (_profile: BitwardenProfile) => {
      events.push("permission");
      return permission;
    }),
  };
  const tokenResponses: { body: unknown; status: number }[] = [];
  const syncResponses: { body: unknown; status: number }[] = [];
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    const path = new URL(url).pathname;
    const stage = path.includes("prelogin")
      ? "prelogin"
      : path.endsWith("/token")
        ? "token"
        : path.endsWith("/sync")
          ? "sync"
          : "unexpected";
    events.push(stage);
    let body: unknown;
    let status = 200;
    if (stage === "prelogin")
      body = { kdfSettings: { kdfType: 0, iterations: 100_000 }, salt: v1Email };
    else if (stage === "token") {
      const next = tokenResponses.shift();
      body = next?.body ?? raw.token;
      status = next?.status ?? 200;
    } else if (stage === "sync") {
      const next = syncResponses.shift();
      body = next?.body ?? raw.sync;
      status = next?.status ?? 200;
    }
    else throw new Error("Unexpected synthetic provider route");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const host = {
    deriveAuthentication: vi.fn<ConnectionSetupDependencies["host"]["deriveAuthentication"]>(
      async (input) => {
        events.push("derive");
        const request = input as { connectionId: string };
        return {
          ok: true,
          data: { connectionId: request.connectionId, masterPasswordHash: authenticationHash },
        };
      },
    ),
  };
  const store = {
    read: vi.fn(async () => ({ ok: true as const, data: structuredClone(durable) })),
    compareAndSwap: vi.fn(),
    close: vi.fn(),
  };
  const manager = {
    accept: vi.fn<ReturnType<ConnectionSetupDependencies["vaultFor"]>["manager"]["accept"]>(
      async (
        request: Parameters<
          ReturnType<ConnectionSetupDependencies["vaultFor"]>["manager"]["accept"]
        >[0],
      ) => {
        events.push("accept");
        const snapshotId = crypto.randomUUID();
        const recordId = crypto.randomUUID();
        durable = {
          schemaVersion: 1,
          revision: crypto.randomUUID(),
          profile: request.prepared.binding.profile,
          state: "active",
          userKey: activeEntry().userKey,
          accepted: {
            recordId,
            snapshotId,
            userId: request.prepared.binding.userId,
            accountVersion: request.prepared.binding.accountVersion,
            minimumSecurityVersion: request.prepared.minimumSecurityVersion,
            acceptedAt: clock,
            coverage: "received-envelope",
            prepared: structuredClone(request.prepared),
          },
        };
        return {
          ok: true as const,
          data: {
            handle: {
              managerGeneration: crypto.randomUUID(),
              handleId: crypto.randomUUID(),
              connectionId: durable.profile.connectionId,
              userId: durable.accepted.userId,
              recordId,
              snapshotId,
            },
            summary: {
              connectionId: durable.profile.connectionId,
              revision: durable.revision,
              autoUnlock: "enabled" as const,
            },
          },
        };
      },
    ),
    catalog: vi.fn(async (handle: { connectionId: string; snapshotId: string }) => ({
      ok: true as const,
      data: {
        connectionId: handle.connectionId,
        userId: accountUserId,
        snapshotId: handle.snapshotId,
        groups: [],
        items: [
          {
            id: raw.sync.ciphers[0]!.id,
            label: "test_item",
            type: 1 as const,
            groupIds: [],
            fields: [{ id: "login.password", label: "Password", kind: "hidden" as const }],
          },
        ],
      },
    })),
    disableAutoUnlock: vi.fn(),
    dispose: vi.fn(),
    restore: vi.fn(),
    listFields: vi.fn(),
    resolveField: vi.fn(),
    status: vi.fn(() => ({ ready: true })),
    generation: crypto.randomUUID(),
  };
  const policy = {
    adopt: vi.fn<ConnectionSetupDependencies["policy"]["adopt"]>(async () => {
      events.push("policy");
      return { policyReviewItemIds: [] };
    }),
  };
  const transportFor = vi.fn((profile: BitwardenProfile) =>
    createBitwardenTransport(profile, { fetch }),
  );
  const sessionMemory = memorySessionStore({
    profile: accountProfile,
    cacheRevision: () => (durable?.state === "active" ? durable.revision : null),
  });
  const build = () =>
    createConnectionSetupService({
      host,
      sessions: createProviderSessions({
        storeFor: () => sessionMemory.store,
        nowMs: () => clock,
      }),
      transportFor,
      permissions,
      registry,
      policy,
      vaultFor: () =>
        ({ store, manager }) as unknown as ReturnType<ConnectionSetupDependencies["vaultFor"]>,
      nowMs: () => clock,
    });
  const service = build();
  const caller = service.createCaller();
  closers.push(() => caller.dispose());
  return {
    caller,
    service,
    host,
    registry,
    configurations,
    manager,
    policy,
    store,
    fetch,
    transportFor,
    permissions,
    events,
    tokenResponses,
    syncResponses,
    sessionMemory,
    /** A new background incarnation: no in-memory state, same durable stores. */
    restart() {
      const next = build();
      const caller = next.createCaller();
      closers.push(() => caller.dispose());
      return { service: next, caller };
    },
    durable: () => structuredClone(durable),
    permission: (allowed: boolean) => {
      permission = allowed;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    setRaw: (value: typeof raw) => {
      raw = value;
    },
  };
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

function noSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    v1Password,
    authenticationHash,
    rawCustomAccount().token.access_token,
    "synthetic-refresh-token",
    "test_password",
    "00001234",
  ])
    expect(serialized).not.toContain(secret);
}

describe("options setup composition using the fixed real transport", () => {
  it("checks permission before prelogin and publishes only metadata after durable native acceptance", async () => {
    const h = harness();
    const result = await h.caller.begin(newInput());
    expect(result).toMatchObject({ ok: true, kind: "ready", policyReviewItemIds: [] });
    expect(h.events.indexOf("permission")).toBeLessThan(h.events.indexOf("prelogin"));
    expect(
      h.events.filter((event) =>
        ["prelogin", "derive", "token", "sync", "accept", "policy"].includes(event),
      ),
    ).toEqual(["prelogin", "derive", "token", "sync", "accept", "policy"]);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    const token = h.fetch.mock.calls.find(([url]) => url.endsWith("/token"))!;
    const form = new URLSearchParams(String(token[1].body));
    expect(form.get("password")).toBe(authenticationHash);
    expect(form.get("username")).toBe(v1Email);
    expect(token[0]).toBe("https://identity.bitwarden.com/connect/token");
    expect(h.fetch.mock.calls.find(([url]) => url.endsWith("/sync"))?.[0]).toBe(
      "https://api.bitwarden.com/sync",
    );
    noSecrets(result);
    noSecrets([...h.configurations.values()]);
    expect(h.policy.adopt.mock.calls[0]?.[0].catalog.items[0]?.allowedOrigins).toEqual([]);
  });
  it("a missing provider permission performs no HTTP or expensive crypto", async () => {
    const h = harness();
    h.permission(false);
    expect(await h.caller.begin(newInput())).toEqual({
      ok: false,
      error: { code: "provider-permission-required" },
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.host.deriveAuthentication).not.toHaveBeenCalled();
    expect(h.manager.accept).not.toHaveBeenCalled();
  });
  it.each([
    "http://vault.example",
    "https://vault.example/path",
    "https://user@vault.example",
    "https://vault.example?token=private",
  ])("rejects invalid configured root %s before permission or HTTP", async (baseUrl) => {
    const h = harness();
    expect(
      (await h.caller.begin({ ...newInput(), environment: { kind: "self-hosted", baseUrl } })).ok,
    ).toBe(false);
    expect(h.permissions.contains).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("uses the persisted provider/email for existing connections and rejects retargeting payload extras", async () => {
    const h = harness({ existing: true });
    const result = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    expect(result.ok).toBe(true);
    expect(h.permissions.contains.mock.calls[0]?.[0]).toEqual(accountProfile);
    expect(h.host.deriveAuthentication.mock.calls[0]?.[0]).toMatchObject({ email: v1Email });
    expect(h.manager.accept.mock.calls[0]?.[0].autoUnlock).toBe("preserve");
    const count = h.fetch.mock.calls.length;
    const malformed = {
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
      environment: { kind: "cloud", region: "eu" },
    };
    expect((await h.caller.begin(malformed as SetupBegin)).ok).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(count);
  });
});

describe("manual challenges and isolated caller lifetime", () => {
  it("new-device verification sends only the explicitly entered OTP and does not synthesize an MFA token", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "device_error", error_description: "New device verification required" },
    });
    const result = await h.caller.begin(newInput());
    expect(result).toMatchObject({
      ok: true,
      kind: "new-device-verification-required",
      invalidOtp: false,
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    if (!result.ok || result.kind !== "new-device-verification-required")
      throw new Error("Synthetic new-device challenge failed");
    expect((await h.caller.continue({ flowId: result.flowId, newDeviceOtp: "000987" })).ok).toBe(
      true,
    );
    const token = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"))[1]!;
    const form = new URLSearchParams(String(token[1].body));
    expect(form.get("newDeviceOtp")).toBe("000987");
    expect(form.has("twoFactorToken")).toBe(false);
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it("an unsupported offered MFA provider stops without a password replay or native cache mutation", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "5": null } },
    });
    expect(await h.caller.begin(newInput())).toEqual({
      ok: true,
      kind: "interaction-required",
      reason: "unsupported-challenge",
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.manager.accept).not.toHaveBeenCalled();
    expect(h.durable()).toBeNull();
  });
  it("holds MFA without replay, then uses the explicit selected provider and code exactly once", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null, "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    expect(challenge).toMatchObject({ ok: true, kind: "mfa-required", providers: [0, 1] });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.manager.accept).not.toHaveBeenCalled();
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    noSecrets(challenge);
    const completed = await h.caller.continue({
      flowId: challenge.flowId,
      twoFactor: { provider: 1, code: "000123" },
    });
    expect(completed).toMatchObject({ ok: true, kind: "ready" });
    const tokens = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(tokens).toHaveLength(2);
    const form = new URLSearchParams(String(tokens[1]![1].body));
    expect(form.get("twoFactorToken")).toBe("000123");
    expect(form.get("twoFactorProvider")).toBe("1");
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    noSecrets(completed);
  });
  it("another options caller cannot continue or cancel an owned MFA flow", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(
      (
        await other.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "123456" },
        })
      ).ok,
    ).toBe(false);
    await other.cancel(challenge.flowId);
    expect(
      (
        await h.caller.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "123456" },
        })
      ).ok,
    ).toBe(true);
  });
  it("cancelled and expired challenges cannot send another password grant", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    await h.caller.cancel(challenge.flowId);
    expect(
      (
        await h.caller.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "123456" },
        })
      ).ok,
    ).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const next = await h.caller.begin(newInput());
    if (!next.ok || next.kind !== "mfa-required") throw new Error("Synthetic MFA challenge failed");
    h.advance(600_000);
    expect(
      (await h.caller.continue({ flowId: next.flowId, twoFactor: { provider: 0, code: "123456" } }))
        .ok,
    ).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it("revoked permission between challenge and continuation prevents the next HTTP request", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    h.permission(false);
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 0, code: "123456" },
      }),
    ).toEqual({ ok: false, error: { code: "provider-permission-required" } });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("failed refresh does not destroy a previously usable cache", () => {
  it("withholds an uncertain initial commit after caller disposal without blindly disabling its unknown durable revision", async () => {
    const h = harness();
    const held = gate();
    const commit = h.manager.accept.getMockImplementation()!;
    h.manager.accept.mockImplementationOnce(async (input) => {
      await commit(input);
      await held.promise;
      return { ok: false, error: { code: "storage-uncertain" } };
    });
    const pending = h.caller.begin(newInput());
    await vi.waitFor(() => expect(h.durable()?.state).toBe("active"));
    const written = h.durable();
    h.caller.dispose();
    held.release();
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.policy.adopt).not.toHaveBeenCalled();
    expect(h.durable()).toEqual(written);
    const caller = h.service.createCaller();
    closers.push(() => caller.dispose());
    if (!written) throw new Error("Synthetic uncertain commit failed");
    expect(await caller.sync(written.profile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    const status = await caller.status();
    expect(status).toMatchObject({
      ok: true,
      kind: "status",
      connections: [{ connectionId: written.profile.connectionId, autoUnlock: "enabled" }],
    });
    noSecrets(status);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it("native permission removal cancels a held derivation and withholds its late result without disabling the old cache", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    const held = gate();
    h.host.deriveAuthentication.mockImplementationOnce(async () => {
      await held.promise;
      return {
        ok: true,
        data: { connectionId: accountProfile.connectionId, masterPasswordHash: authenticationHash },
      };
    });
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    await vi.waitFor(() => expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1));
    h.service.permissionsRemoved();
    expect(h.host.deriveAuthentication.mock.calls[0]?.[1]?.aborted).toBe(true);
    held.release();
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.durable()).toEqual(previous);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("status reads only local metadata and never attempts provider authentication or sync", async () => {
    const h = harness({ existing: true });
    const result = await h.caller.status();
    expect(result).toMatchObject({ ok: true, kind: "status", connections: [{ state: "ready" }] });
    noSecrets(result);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.host.deriveAuthentication).not.toHaveBeenCalled();
    expect(h.manager.accept).not.toHaveBeenCalled();
  });
  it("sync refreshes expired authorization, uses its new bearer, and keeps the rotated refresh out of the vault record", async () => {
    const h = harness({ existing: true });
    expect(
      (
        await h.caller.begin({
          kind: "existing",
          connectionId: accountProfile.connectionId,
          password: v1Password,
          autoUnlock: "preserve",
        })
      ).ok,
    ).toBe(true);
    const oldKey = h.durable();
    if (oldKey?.state !== "active") throw new Error("Synthetic acceptance failed");
    h.advance(3_601_000);
    const fresh = rawCustomAccount("unchanged", accountNow + 3601);
    h.setRaw(fresh);
    h.tokenResponses.push({
      status: 200,
      body: {
        access_token: fresh.token.access_token,
        token_type: "Bearer",
        expires_in: 1,
        refresh_token: "synthetic-rotated-refresh",
      },
    });
    const result = await h.caller.sync(accountProfile.connectionId);
    expect(result).toMatchObject({ ok: true, kind: "ready" });
    const tokens = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(new URLSearchParams(String(tokens[1]![1].body))).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "browser",
        refresh_token: "synthetic-refresh-token",
      }),
    );
    const syncs = h.fetch.mock.calls.filter(([url]) => url.endsWith("/sync"));
    expect(new Headers(syncs[1]![1].headers).get("Authorization")).toBe(
      `Bearer ${fresh.token.access_token}`,
    );
    expect(h.manager.accept.mock.calls[1]?.[0]).toMatchObject({
      unlock: { kind: "decrypted-key", userKey: oldKey.userKey },
      autoUnlock: "preserve",
    });
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    h.advance(2_000);
    const latest = rawCustomAccount("unchanged", accountNow + 3603);
    h.setRaw(latest);
    h.tokenResponses.push({
      status: 200,
      body: { access_token: latest.token.access_token, token_type: "Bearer", expires_in: 3600 },
    });
    expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    const allTokens = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(new URLSearchParams(String(allTokens[2]![1].body)).get("refresh_token")).toBe(
      "synthetic-rotated-refresh",
    );
    expect(JSON.stringify(h.durable())).not.toContain("synthetic-rotated-refresh");
    expect(h.sessionMemory.raw()).toMatchObject({ refreshToken: "synthetic-rotated-refresh" });
    noSecrets(result);
    expect(h.fetch).toHaveBeenCalledTimes(7);
  });
  it("a rejected refresh sends no sync or password fallback and preserves the exact accepted record", async () => {
    const h = harness({ existing: true });
    expect(
      (
        await h.caller.begin({
          kind: "existing",
          connectionId: accountProfile.connectionId,
          password: v1Password,
          autoUnlock: "preserve",
        })
      ).ok,
    ).toBe(true);
    const previous = h.durable();
    h.advance(3_601_000);
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", error_description: "synthetic-invalid-refresh-secret" },
    });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.fetch.mock.calls.filter(([url]) => url.endsWith("/sync"))).toHaveLength(1);
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    expect(h.manager.accept).toHaveBeenCalledTimes(1);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.durable()).toEqual(previous);
  });
  it.each(["token", "sync", "sync-after-read", "refresh"] as const)(
    "rechecks permission immediately before the %s HTTP call",
    async (stage) => {
      const h = harness({ existing: true });
      if (stage === "token") {
        h.host.deriveAuthentication.mockImplementationOnce(async () => {
          h.permission(false);
          return {
            ok: true,
            data: {
              connectionId: accountProfile.connectionId,
              masterPasswordHash: authenticationHash,
            },
          };
        });
      } else if (stage === "sync") {
        const fetch = h.fetch.getMockImplementation()!;
        h.fetch.mockImplementation(async (url, init) => {
          const result = await fetch(url, init);
          if (url.endsWith("/token")) h.permission(false);
          return result;
        });
      }
      if (stage === "sync-after-read")
        h.store.read.mockImplementationOnce(async () => {
          h.permission(false);
          return { ok: true, data: h.durable() };
        });
      const begun = await h.caller.begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
        autoUnlock: "preserve",
      });
      if (stage !== "refresh") {
        expect(begun).toEqual({ ok: false, error: { code: "provider-permission-required" } });
        expect(h.fetch).toHaveBeenCalledTimes(stage === "token" ? 1 : 2);
        expect(h.manager.accept).not.toHaveBeenCalled();
      } else {
        expect(begun.ok).toBe(true);
        const previous = h.durable();
        h.advance(3_601_000);
        // A native-store await can outlive the permission checked at sync entry.
        h.store.read.mockImplementationOnce(async () => {
          h.permission(false);
          return { ok: true, data: previous };
        });
        expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
          ok: false,
          error: { code: "provider-permission-required" },
        });
        expect(h.fetch).toHaveBeenCalledTimes(3);
        expect(h.durable()).toEqual(previous);
      }
    },
  );
  it("disposes an options caller while KDF is pending without later provider grant or cache disable", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    const held = gate();
    h.host.deriveAuthentication.mockImplementationOnce(async () => {
      await held.promise;
      return {
        ok: true,
        data: { connectionId: accountProfile.connectionId, masterPasswordHash: authenticationHash },
      };
    });
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    await vi.waitFor(() => expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1));
    await h.caller.dispose();
    held.release();
    expect((await pending).ok).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.durable()).toEqual(previous);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("a sanitized provider network failure has no retry, legacy fallback, or cache mutation", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    h.fetch.mockRejectedValueOnce(new Error(`Synthetic provider leaked ${v1Password}`));
    const result = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    expect(result.ok).toBe(false);
    noSecrets(result);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.durable()).toEqual(previous);
    expect(h.manager.accept).not.toHaveBeenCalled();
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("subject mismatch after encrypted sync never reaches native acceptance", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    const wrong = rawCustomAccount();
    wrong.sync.profile.id = crypto.randomUUID();
    h.setRaw(wrong);
    const result = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    expect(result).toEqual({ ok: false, error: { code: "account-mismatch" } });
    expect(h.manager.accept).not.toHaveBeenCalled();
    expect(h.durable()).toEqual(previous);
  });
});

describe("durable provider sessions", () => {
  async function connected(h: ReturnType<typeof harness>) {
    const begun = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    expect(begun.ok).toBe(true);
  }
  it("a new background incarnation syncs without the password and without HTTP at startup", async () => {
    const h = harness({ existing: true });
    await connected(h);
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
    expect(JSON.stringify(h.sessionMemory.raw())).not.toContain(v1Password);
    const fresh = h.restart();
    const status = await fresh.caller.status();
    expect(status).toMatchObject({ connections: [{ providerSession: "active" }] });
    noSecrets(status);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect((await fresh.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    // A second consecutive sync still works against the newly accepted cache revision.
    expect((await fresh.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    expect(h.manager.accept).toHaveBeenCalledTimes(3);
  });
  it("a sync failure after a committed rotation keeps the rotated token", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    h.advance(3_601_000);
    const fresh = rawCustomAccount("unchanged", accountNow + 3601);
    h.tokenResponses.push({
      status: 200,
      body: {
        access_token: fresh.token.access_token,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "synthetic-rotated-refresh",
      },
    });
    h.syncResponses.push({ status: 500, body: {} });
    expect(await h.restart().caller.sync(accountProfile.connectionId)).toMatchObject({
      ok: false,
      error: { code: "http-error" },
    });
    expect(h.sessionMemory.raw()).toMatchObject({
      state: "active",
      refreshToken: "synthetic-rotated-refresh",
    });
    expect(h.durable()).toEqual(previous);
  });
  it("a rejected access token forgets only the sync session", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    h.syncResponses.push({ status: 401, body: {} });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()).toEqual(previous);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("changed account crypto requires password sign-in and preserves the cache", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    const changed = rawCustomAccount();
    changed.sync.profile.privateKey = rawV1Account().token.Key;
    h.setRaw(changed);
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()).toEqual(previous);
    expect(h.manager.accept).toHaveBeenCalledTimes(1);
  });
  it("local forget keeps offline unlock and is not a server logout", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const calls = h.fetch.mock.calls.length;
    expect(await h.caller.forget(accountProfile.connectionId)).toEqual({
      ok: true,
      kind: "forgotten",
      connectionId: accountProfile.connectionId,
    });
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()?.state).toBe("active");
    expect(await h.caller.status()).toMatchObject({
      connections: [{ providerSession: "none", autoUnlock: "enabled" }],
    });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
  });
  it("disabling automatic unlock also forgets sync credentials", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.manager.disableAutoUnlock.mockResolvedValueOnce({
      ok: true,
      data: { connectionId: accountProfile.connectionId, revision: crypto.randomUUID() },
    });
    expect((await h.caller.disable(accountProfile.connectionId)).ok).toBe(true);
    expect(h.sessionMemory.raw()).toBeUndefined();
  });
  it("permission removal forgets only connections whose provider lost access", async () => {
    const h = harness({ existing: true });
    await connected(h);
    await h.service.permissionsRemoved();
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
    h.permission(false);
    await h.service.permissionsRemoved();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()?.state).toBe("active");
  });
});
