import { afterEach, describe, expect, it, vi } from "vitest";
import { createBitwardenTransport, type BitwardenProfile } from "@pateat/bitwarden";
import { createVaultSyncRecords, type VaultApplyHold } from "./auto-sync";
import { createConnectionSetupService } from "./setup";
import { parseSetupReply } from "./wire";
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
function harness(options: { existing?: boolean; prelogin?: unknown } = {}) {
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
    remove: vi.fn(async (id: string) => {
      configurations.delete(id);
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
  const emailResponses: { body: unknown; status: number }[] = [];
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    const path = new URL(url).pathname;
    const stage = path.includes("prelogin")
      ? "prelogin"
      : path.endsWith("/token")
        ? "token"
        : path.endsWith("/sync")
          ? "sync"
          : path.endsWith("/two-factor/send-email-login")
            ? "email"
            : "unexpected";
    events.push(stage);
    let body: unknown;
    let status = 200;
    if (stage === "prelogin")
      body = options.prelogin ?? {
        kdfSettings: { kdfType: 0, iterations: 100_000 },
        salt: v1Email,
      };
    else if (stage === "token") {
      const next = tokenResponses.shift();
      body = next?.body ?? raw.token;
      status = next?.status ?? 200;
    } else if (stage === "sync") {
      const next = syncResponses.shift();
      body = next?.body ?? raw.sync;
      status = next?.status ?? 200;
    } else if (stage === "email") {
      const next = emailResponses.shift();
      if (!next) return new Response(null, { status: 200 });
      body = next.body;
      status = next.status;
    } else throw new Error("Unexpected synthetic provider route");
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
            sameCustomFields: [],
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
            fields: [
              { id: "login.password", label: "Password", name: null, kind: "hidden" as const },
            ],
          },
        ],
      },
    })),
    disableAutoUnlock: vi.fn(),
    remove: vi.fn<ReturnType<ConnectionSetupDependencies["vaultFor"]>["manager"]["remove"]>(
      async () => {
        events.push("remove");
        durable = null;
        return { ok: true as const, data: true as const };
      },
    ),
    dispose: vi.fn(),
    restore: vi.fn(),
    listFields: vi.fn(),
    resolveField: vi.fn(),
    status: vi.fn(() => ({ ready: true })),
    generation: crypto.randomUUID(),
  };
  const policy = {
    register: vi.fn<ConnectionSetupDependencies["policy"]["register"]>(async () => {
      events.push("register");
    }),
    protectedItems: vi.fn<NonNullable<ConnectionSetupDependencies["policy"]["protectedItems"]>>(
      async () => [],
    ),
    adopt: vi.fn<ConnectionSetupDependencies["policy"]["adopt"]>(async () => {
      events.push("policy");
      return { policyReviewItemIds: [] };
    }),
  };
  // The revision-date check is answered here and counted apart, so `fetch` counts only
  // the prelogin, token and sync requests.
  const revisionResponses: { body: unknown; status: number }[] = [];
  const revisionDate = vi.fn(async (_url: string, _init: RequestInit) => {
    events.push("revision");
    const next = revisionResponses.shift();
    return new Response(JSON.stringify(next ? next.body : 1_792_152_000_000), {
      status: next?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  const providerFetch = (url: string, init: RequestInit) =>
    new URL(url).pathname.endsWith("/accounts/revision-date")
      ? revisionDate(url, init)
      : fetch(url, init);
  const transportFor = vi.fn((profile: BitwardenProfile) =>
    createBitwardenTransport(profile, { fetch: providerFetch }),
  );
  let revisionRecord: unknown;
  const revisions = createVaultSyncRecords({
    read: async () => structuredClone(revisionRecord),
    write: async (record) => {
      revisionRecord = structuredClone(record);
    },
  });
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
      revisions,
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
    revisionDate,
    revisionResponses,
    revisions,
    transportFor,
    permissions,
    events,
    tokenResponses,
    syncResponses,
    emailResponses,
    sessionMemory,
    /** A new background incarnation: no in-memory state, same durable stores. */
    restart() {
      const next = build();
      const nextCaller = next.createCaller();
      closers.push(() => nextCaller.dispose());
      return { service: next, caller: nextCaller };
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
  it.each([
    { label: "the replaced snapshot", replaced: true, adopted: true },
    { label: "another snapshot", replaced: false, adopted: false },
  ])(
    "adopts with the items found unchanged against $label only when it is the one replaced",
    async ({ replaced, adopted }) => {
      const h = harness({ existing: true });
      const begun = await h.caller.begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
        autoUnlock: "preserve",
      });
      expect(begun.ok).toBe(true);
      h.manager.accept.mockClear();
      h.policy.adopt.mockClear();
      const itemId = rawCustomAccount().sync.ciphers[0]!.id;
      const previous = h.durable()!.accepted!.snapshotId;
      h.policy.protectedItems.mockResolvedValue([itemId]);
      const commit = h.manager.accept.getMockImplementation()!;
      h.manager.accept.mockImplementationOnce(async (input, signal) => {
        const result = await commit(input, signal);
        return result.ok
          ? {
              ...result,
              data: {
                ...result.data,
                sameCustomFields: [itemId],
                comparedSnapshotId: replaced ? previous : crypto.randomUUID(),
              },
            }
          : result;
      });
      expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
      expect(h.policy.protectedItems).toHaveBeenCalledWith(accountProfile.connectionId);
      expect(h.manager.accept.mock.calls[0]?.[0].compareCustomFields).toEqual([itemId]);
      expect(h.policy.adopt.mock.calls[0]?.[0].sameCustomFields).toEqual(adopted ? [itemId] : []);
    },
  );
  it("still syncs, comparing nothing, when the protected items cannot be read", async () => {
    const h = harness();
    h.policy.protectedItems.mockRejectedValue(new Error("Synthetic settings unavailable"));
    expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
    expect(h.manager.accept.mock.calls[0]?.[0].compareCustomFields).toEqual([]);
    expect(h.policy.adopt.mock.calls[0]?.[0].sameCustomFields).toEqual([]);
  });
  it("completes setup when password prelogin answers only the flat KDF fields", async () => {
    // Bitwarden Cloud US (2026.9.2) answered /accounts/prelogin/password in this shape.
    const prelogin = { kdf: 0, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null };
    const h = harness({ prelogin });
    const result = await h.caller.begin(newInput());
    expect(result).toMatchObject({ ok: true, kind: "ready" });
    expect(h.fetch.mock.calls[0]?.[0]).toBe(
      "https://identity.bitwarden.com/accounts/prelogin/password",
    );
    expect(h.host.deriveAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ prelogin: { mode: "password", response: prelogin } }),
      expect.any(AbortSignal),
    );
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
  // packages/bitwarden's transport tests prove which roots are inadmissible.
  it("rejects an invalid configured root before permission or HTTP", async () => {
    const h = harness();
    const environment = { kind: "self-hosted", baseUrl: "http://vault.example" } as const;
    expect((await h.caller.begin({ ...newInput(), environment })).ok).toBe(false);
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
  it("emails a code with the hash the password grant sent, and the sign-in still waits", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null, "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const grant = new URLSearchParams(
      String(h.fetch.mock.calls.find(([url]) => url.endsWith("/token"))![1].body),
    );
    h.emailResponses.push(
      { status: 200, body: null },
      { status: 429, body: null },
      { status: 400, body: { message: "Email 2FA is disabled", object: "error" } },
      { status: 400, body: { message: "Synthetic refusal", object: "error" } },
      { status: 500, body: null },
    );
    const results = [];
    for (let i = 0; i < 5; i++)
      // oxlint-disable-next-line no-await-in-loop
      results.push(await h.caller.sendEmailCode(challenge.flowId));
    expect(
      results.map((result) => result.ok && result.kind === "email-code" && result.result),
    ).toEqual(["sent", "rate-limited", "unavailable", "refused", "failed"]);
    for (const result of results) noSecrets(result);
    const sends = h.fetch.mock.calls.filter(([url]) =>
      url.endsWith("/two-factor/send-email-login"),
    );
    expect(sends).toHaveLength(5);
    // The account's own server: its API host, as the official clients send it.
    expect(sends[0]![0]).toBe("https://api.bitwarden.com/two-factor/send-email-login");
    expect(sends[0]![1].method).toBe("POST");
    expect(JSON.parse(String(sends[0]![1].body))).toEqual({
      email: grant.get("username"),
      masterPasswordHash: grant.get("password"),
      ssoEmail2FaSessionToken: "",
      deviceIdentifier: grant.get("deviceIdentifier"),
      authRequestAccessCode: "",
      authRequestId: "",
    });
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 1, code: "000123" },
      }),
    ).toMatchObject({ ok: true, kind: "ready" });
  });
  it("answers the page's heartbeat while its sign-in waits, and expired once it ends", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const waiting = { ok: true, kind: "waiting", flowId: challenge.flowId };
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual(waiting);
    // It does not take the page's one running request, so it answers during a send.
    h.emailResponses.push({ status: 200, body: null });
    const sent = h.caller.sendEmailCode(challenge.flowId);
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual(waiting);
    expect(await sent).toMatchObject({ ok: true, kind: "email-code", result: "sent" });
    // Another flow ID, another page, or a flow past its 5 minutes is expired; a worker
    // Chrome restarted holds no flow and answers the same.
    const expired = { ok: false, error: { code: "setup-expired" } };
    expect(await h.caller.keepAlive("not-a-flow")).toEqual(expired);
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.keepAlive(challenge.flowId)).toEqual(expired);
    h.advance(300_000);
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual(expired);
    other.dispose();
    expect(await other.keepAlive(challenge.flowId)).toEqual({
      ok: false,
      error: { code: "setup-unavailable" },
    });
    expect(
      await h.caller.continue({ flowId: challenge.flowId, twoFactor: { provider: 1, code: "1" } }),
    ).toMatchObject({ ok: false });
  });
  it("sends no email code for a flow without email two-step or after it ends", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    expect(await h.caller.sendEmailCode(challenge.flowId)).toMatchObject({ ok: false });
    expect(await h.caller.sendEmailCode("not-a-flow")).toMatchObject({ ok: false });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.sendEmailCode(challenge.flowId)).toMatchObject({ ok: false });
    await h.caller.cancel(challenge.flowId);
    expect(await h.caller.sendEmailCode(challenge.flowId)).toMatchObject({ ok: false });
    expect(
      h.fetch.mock.calls.filter(([url]) => url.endsWith("/two-factor/send-email-login")),
    ).toHaveLength(0);
  });
  it.each([
    ["lost provider access", "provider-permission-required"],
    ["a transport that cannot be built", "invalid-profile"],
  ] as const)(
    "a send refused for %s ends the sign-in so a new one can start",
    async (why, code) => {
      const h = harness();
      h.tokenResponses.push({
        status: 400,
        body: { error: "invalid_grant", TwoFactorProviders2: { "1": {} } },
      });
      const challenge = await h.caller.begin(newInput());
      if (!challenge.ok || challenge.kind !== "mfa-required")
        throw new Error("Synthetic MFA challenge failed");
      if (why === "lost provider access") h.permission(false);
      else h.transportFor.mockReturnValueOnce({ ok: false, error: { code } } as never);
      expect(await h.caller.sendEmailCode(challenge.flowId)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(
        (
          await h.caller.continue({
            flowId: challenge.flowId,
            twoFactor: { provider: 1, code: "1" },
          })
        ).ok,
      ).toBe(false);
      h.permission(true);
      expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
      expect(
        h.fetch.mock.calls.filter(([url]) => url.endsWith("/two-factor/send-email-login")),
      ).toHaveLength(0);
    },
  );
  it("a sign-in cancelled while its code is being sent answers cancelled and ends", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "1": {} } },
    });
    const challenge = await h.caller.begin(newInput());
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const fetch = h.fetch.getMockImplementation()!;
    let reached!: () => void;
    const sending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    h.fetch.mockImplementation(async (url, init) => {
      if (!url.endsWith("/two-factor/send-email-login")) return fetch(url, init);
      reached();
      await new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
      throw new Error("unreachable");
    });
    const sent = h.caller.sendEmailCode(challenge.flowId);
    await sending;
    await h.caller.cancel(challenge.flowId);
    expect(await sent).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(
      (await h.caller.continue({ flowId: challenge.flowId, twoFactor: { provider: 1, code: "1" } }))
        .ok,
    ).toBe(false);
    expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
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
  it("records the add form's policy choice before the first sign-in, so a later sign-in keeps it", async () => {
    const h = harness();
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin({ ...newInput(), enabled: true });
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const [configuration] = [...h.configurations.values()];
    if (!configuration) throw new Error("Synthetic connection was not registered");
    const connectionId = configuration.profile.connectionId;
    expect(h.policy.register.mock.calls).toEqual([[connectionId, true]]);
    expect(h.policy.register.mock.invocationCallOrder[0]).toBeLessThan(
      h.registry.put.mock.invocationCallOrder[0]!,
    );
    // The first attempt ends unfinished; the settings page then offers "Sign in again".
    await h.caller.cancel(challenge.flowId);
    expect(h.policy.adopt).not.toHaveBeenCalled();
    const ready = await h.caller.begin({
      kind: "existing",
      connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    expect(ready).toMatchObject({ ok: true, kind: "ready", connectionId });
    expect(h.policy.register).toHaveBeenCalledTimes(1);
    expect(h.policy.adopt).toHaveBeenCalledTimes(1);
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
  it("status reports the last time the vault was known to match Bitwarden", async () => {
    const h = harness({ existing: true });
    const acceptedAt = h.durable()!.accepted!.acceptedAt;
    const synced = async () => {
      const result = await h.caller.status();
      if (!result.ok || result.kind !== "status") throw new Error("Synthetic status failed");
      return result.connections[0]?.syncedAt;
    };
    expect(await synced()).toBe(acceptedAt);
    // Only a finished check that found no change confirms the open snapshot later.
    await h.revisions.update(accountProfile.connectionId, () => ({
      checkedAt: acceptedAt + 120_000,
      outcome: "failed",
    }));
    expect(await synced()).toBe(acceptedAt);
    await h.revisions.update(accountProfile.connectionId, (entry) => ({
      ...entry,
      unchangedAt: acceptedAt + 60_000,
    }));
    // A time after now (a clock set back) confirms nothing.
    expect(await synced()).toBe(acceptedAt);
    h.advance(120_000);
    expect(await synced()).toBe(acceptedAt + 60_000);
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
    expect(result).toEqual({
      ok: false,
      error: { code: "account-mismatch", check: "token-subject" },
    });
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
    // The revision date is unchanged, and a manual Sync still sends a full sync.
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_000_000);
    expect((await fresh.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    // A second consecutive sync still works against the newly accepted cache revision.
    expect((await fresh.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    expect(h.manager.accept).toHaveBeenCalledTimes(3);
  });
  const hold = (ready = true, take = true): VaultApplyHold & { released: () => boolean } => {
    let released = false;
    return {
      ready: async () => ready,
      take: async () =>
        take
          ? () => {
              released = true;
            }
          : undefined,
      released: () => released,
    };
  };
  it("a password sign-in stores the revision date, and an unchanged vault is not synced again", async () => {
    const h = harness({ existing: true });
    await connected(h);
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_000_000);
    const fetches = h.fetch.mock.calls.length;
    const accepts = h.manager.accept.mock.calls.length;
    const fresh = h.restart();
    expect(await fresh.service.autoSync(accountProfile.connectionId, hold())).toBe("unchanged");
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts);
  });
  it("a moved revision date syncs, accepts under the hold and stores the new date", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const accepts = h.manager.accept.mock.calls.length;
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    const held = hold();
    expect(await h.restart().service.autoSync(accountProfile.connectionId, held)).toBe("synced");
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts + 1);
    expect(held.released()).toBe(true);
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_060_000);
  });
  it("a login in progress defers before the full sync, or after it without accepting", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const fetches = h.fetch.mock.calls.length;
    const accepts = h.manager.accept.mock.calls.length;
    const fresh = h.restart();
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    expect(await fresh.service.autoSync(accountProfile.connectionId, hold(false))).toBe("deferred");
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    expect(await fresh.service.autoSync(accountProfile.connectionId, hold(true, false))).toBe(
      "deferred",
    );
    expect(h.fetch).toHaveBeenCalledTimes(fetches + 1);
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts);
    // Nothing was applied, so the next check still sees a change.
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_000_000);
  });
  it.each([
    { label: "null", response: { status: 200, body: null }, outcome: "synced" },
    { label: "negative", response: { status: 200, body: -1 }, outcome: "account-deleted" },
    { label: "429", response: { status: 429, body: {} }, outcome: "rate-limited" },
    { label: "503", response: { status: 503, body: {} }, outcome: "failed" },
  ] as const)("a $label revision date answers $outcome", async ({ response, outcome }) => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push(response);
    expect(await h.restart().service.autoSync(accountProfile.connectionId, hold())).toBe(outcome);
  });
  it("a 401 on the revision date discards the session it used", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push({ status: 401, body: {} });
    expect(await h.restart().service.autoSync(accountProfile.connectionId, hold())).toBe(
      "reauthentication-required",
    );
    expect(h.sessionMemory.raw()).toBeUndefined();
  });
  it("a manual Sync started with an automatic check waits for it and still syncs", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const fresh = h.restart();
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    let answer!: (ready: boolean) => void;
    const auto = fresh.service.autoSync(accountProfile.connectionId, {
      ready: () => new Promise<boolean>((resolve) => (answer = resolve)),
      take: async () => undefined,
    });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    const before = h.fetch.mock.calls.length;
    let finished = false;
    const manual = fresh.caller.sync(accountProfile.connectionId).finally(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    answer(false);
    expect(await auto).toBe("deferred");
    expect((await manual).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(before + 1);
  });
  async function waitingForCode(h: ReturnType<typeof harness>, input: SetupBegin) {
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin(input);
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    return challenge;
  }
  it.each([
    { label: "another", input: newInput },
    {
      label: "the same",
      input: (): SetupBegin => ({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
        autoUnlock: "preserve",
      }),
    },
  ])(
    "a Sync of $label connection while a sign-in waits for its code is refused and keeps it",
    async ({ input }) => {
      const h = harness({ existing: true });
      await connected(h);
      const challenge = await waitingForCode(h, input());
      const fetches = h.fetch.mock.calls.length;
      expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
        ok: false,
        error: { code: "resource-limit" },
      });
      expect(h.fetch).toHaveBeenCalledTimes(fetches);
      expect(
        await h.caller.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "000123" },
        }),
      ).toMatchObject({ ok: true, kind: "ready" });
      // Nothing of the refused Sync or the finished sign-in keeps the connection busy.
      expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    },
  );
  it("a code for a two-step method not offered ends the sign-in and frees the connection", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const challenge = await waitingForCode(h, {
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 1, code: "000123" },
      }),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
  });
  it("a challenge that permission removal ended no longer blocks the page", async () => {
    const h = harness();
    await waitingForCode(h, newInput());
    h.permission(false);
    await h.service.permissionsRemoved();
    h.permission(true);
    expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
  });
  it("a second sign-in while one waits for its code is refused and keeps the first", async () => {
    const h = harness();
    const challenge = await waitingForCode(h, newInput());
    expect(await h.caller.begin(newInput())).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 0, code: "000123" },
      }),
    ).toMatchObject({ ok: true, kind: "ready" });
  });
  it("an automatic check that has not claimed anything yields to a manual Sync", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const fresh = h.restart();
    const before = h.fetch.mock.calls.length;
    const auto = fresh.service.autoSync(accountProfile.connectionId, hold());
    const manual = fresh.caller.sync(accountProfile.connectionId);
    expect(await auto).toBe("skipped");
    expect((await manual).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(before + 1);
  });
  it("a password sign-in stops an automatic check and waits for it", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    let answer!: (ready: boolean) => void;
    const auto = h.service.autoSync(accountProfile.connectionId, {
      ready: () => new Promise<boolean>((resolve) => (answer = resolve)),
      take: async () => undefined,
    });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    let finished = false;
    const signIn = h.caller
      .begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
        autoUnlock: "preserve",
      })
      .finally(() => {
        finished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    answer(true);
    expect(await auto).toBe("skipped");
    expect((await signIn).ok).toBe(true);
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
    expect(await h.restart().caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "http-error" },
    });
    expect(h.sessionMemory.raw()).toMatchObject({
      state: "active",
      refreshToken: "synthetic-rotated-refresh",
    });
    expect(h.durable()).toEqual(previous);
  });
  it("an HTTP 500 sync failure replies with only a wire-valid error code", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    h.syncResponses.push({ status: 500, body: {} });
    const reply = await h.caller.sync(accountProfile.connectionId);
    expect(reply).toEqual({ ok: false, error: { code: "http-error" } });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
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
    expect(await h.revisions.revision(accountProfile.connectionId)).toBeUndefined();
    expect(await h.service.autoSync(accountProfile.connectionId, hold())).toBe("skipped");
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
  it("forget during an in-progress password setup is refused and never disables auto unlock", async () => {
    const h = harness();
    const held = gate();
    const catalog = h.manager.catalog.getMockImplementation()!;
    h.manager.catalog.mockImplementationOnce(async (handle) => {
      await held.promise;
      return catalog(handle);
    });
    const pending = h.caller.begin(newInput());
    await vi.waitFor(() => expect(h.manager.catalog).toHaveBeenCalled());
    const [connectionId] = [...h.configurations.keys()];
    if (!connectionId) throw new Error("Synthetic setup did not register");
    expect(await h.caller.forget(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.forget(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    held.release();
    expect(await pending).toMatchObject({ ok: true, kind: "ready" });
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.durable()?.state).toBe("active");
  });
  it("forget aborts an in-flight sync flow, then forgets the session", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const held = gate();
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementationOnce(async (url, init) => {
      await held.promise;
      return fetch(url, init);
    });
    const pending = h.caller.sync(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4));
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.forget(accountProfile.connectionId)).toEqual({
      ok: true,
      kind: "forgotten",
      connectionId: accountProfile.connectionId,
    });
    held.release();
    expect((await pending).ok).toBe(false);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("a late 401 for one session does not delete a newer session from a password sign-in", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const used = (h.sessionMemory.raw() as { revision: string }).revision;
    const held = gate();
    h.fetch.mockImplementationOnce(async () => {
      await held.promise;
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    });
    const pending = h.caller.sync(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4));
    // Another incarnation signs in with the password and retains a newer session.
    const fresh = h.restart();
    expect(
      await fresh.caller.begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
        autoUnlock: "preserve",
      }),
    ).toMatchObject({ ok: true, kind: "ready" });
    const newer = h.sessionMemory.raw() as { revision: string; state: string };
    expect(newer.revision).not.toBe(used);
    held.release();
    expect(await pending).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.sessionMemory.raw()).toMatchObject({ revision: newer.revision, state: "active" });
  });
  it("disable reports a failed session forget instead of success", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.manager.disableAutoUnlock.mockResolvedValueOnce({
      ok: true,
      data: { connectionId: accountProfile.connectionId, revision: crypto.randomUUID() },
    });
    h.sessionMemory.failNext("storage-uncertain");
    expect(await h.caller.disable(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
  });
  it("delete removes the session, vault record and registry entry locally without provider HTTP", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const calls = h.fetch.mock.calls.length;
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
    const reply = await h.caller.remove(accountProfile.connectionId);
    expect(reply).toEqual({
      ok: true,
      kind: "deleted",
      connectionId: accountProfile.connectionId,
    });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.manager.remove).toHaveBeenCalledTimes(1);
    expect(h.durable()).toBeNull();
    expect(h.registry.remove).toHaveBeenCalledWith(accountProfile.connectionId);
    expect(h.configurations.size).toBe(0);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(await h.caller.status()).toEqual({ ok: true, kind: "status", connections: [] });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(await h.caller.remove(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  });
  it("delete removes a leftover connection whose first sign-in never completed", async () => {
    const h = harness();
    h.tokenResponses.push({ status: 503, body: {} });
    const reply = await h.caller.begin(newInput());
    expect(reply).toEqual({ ok: false, error: { code: "http-error" } });
    expect(parseSetupReply(reply)).toEqual(reply);
    const [connectionId] = [...h.configurations.keys()];
    if (!connectionId) throw new Error("Synthetic setup did not register");
    expect(await h.caller.status()).toMatchObject({
      connections: [{ connectionId, autoUnlock: "unknown", providerSession: "none" }],
    });
    expect(await h.caller.remove(connectionId)).toEqual({
      ok: true,
      kind: "deleted",
      connectionId,
    });
    expect(await h.caller.status()).toEqual({ ok: true, kind: "status", connections: [] });
  });
  it("delete during an in-progress password setup is refused and keeps every record", async () => {
    const h = harness();
    const held = gate();
    const catalog = h.manager.catalog.getMockImplementation()!;
    h.manager.catalog.mockImplementationOnce(async (handle) => {
      await held.promise;
      return catalog(handle);
    });
    const pending = h.caller.begin(newInput());
    await vi.waitFor(() => expect(h.manager.catalog).toHaveBeenCalled());
    const [connectionId] = [...h.configurations.keys()];
    if (!connectionId) throw new Error("Synthetic setup did not register");
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.remove(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    held.release();
    expect(await pending).toMatchObject({ ok: true, kind: "ready" });
    expect(h.manager.remove).not.toHaveBeenCalled();
    expect(h.registry.remove).not.toHaveBeenCalled();
    expect(h.durable()?.state).toBe("active");
  });
  it("delete aborts an in-flight sync flow before removing its records", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const held = gate();
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementationOnce(async (url, init) => {
      await held.promise;
      return fetch(url, init);
    });
    const pending = h.caller.sync(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4));
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.remove(accountProfile.connectionId)).toEqual({
      ok: true,
      kind: "deleted",
      connectionId: accountProfile.connectionId,
    });
    held.release();
    expect((await pending).ok).toBe(false);
    expect(h.manager.accept).toHaveBeenCalledTimes(1);
    expect(h.durable()).toBeNull();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.configurations.size).toBe(0);
  });
  it("a sign-in begun before delete cannot target the deleted connection", async () => {
    const h = harness({ existing: true });
    const held = gate();
    const get = h.registry.get.getMockImplementation()!;
    h.registry.get.mockImplementationOnce(async (id) => {
      await held.promise;
      return get(id);
    });
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    await vi.waitFor(() => expect(h.registry.get).toHaveBeenCalledTimes(1));
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    const removed = other.remove(accountProfile.connectionId);
    held.release();
    expect(await removed).toMatchObject({ ok: true, kind: "deleted" });
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.durable()).toBeNull();
  });
  it("a sign-in that read the registry during delete cannot recreate the connection", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const removing = gate();
    const remove = h.manager.remove.getMockImplementation()!;
    h.manager.remove.mockImplementationOnce(async () => {
      await removing.promise;
      return remove();
    });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    const removed = other.remove(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.manager.remove).toHaveBeenCalledTimes(1));
    const reading = gate();
    const get = h.registry.get.getMockImplementation()!;
    h.registry.get.mockImplementationOnce(async (id) => {
      const stale = await get(id);
      await reading.promise;
      return stale;
    });
    const fetches = h.fetch.mock.calls.length;
    const reads = h.registry.get.mock.calls.length;
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      autoUnlock: "preserve",
    });
    await vi.waitFor(() => expect(h.registry.get).toHaveBeenCalledTimes(reads + 1));
    removing.release();
    expect(await removed).toMatchObject({ ok: true, kind: "deleted" });
    reading.release();
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    expect(h.durable()).toBeNull();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.configurations.size).toBe(0);
  });
  it("disable, sync and forget during a delete are refused and leave no record", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const removing = gate();
    const remove = h.manager.remove.getMockImplementation()!;
    h.manager.remove.mockImplementationOnce(async () => {
      await removing.promise;
      return remove();
    });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    const removed = other.remove(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.manager.remove).toHaveBeenCalledTimes(1));
    const refused = { ok: false, error: { code: "resource-limit" } };
    expect(await h.caller.disable(accountProfile.connectionId)).toEqual(refused);
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual(refused);
    expect(await h.caller.forget(accountProfile.connectionId)).toEqual(refused);
    expect(await h.caller.remove(accountProfile.connectionId)).toEqual(refused);
    removing.release();
    expect(await removed).toMatchObject({ ok: true, kind: "deleted" });
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.durable()).toBeNull();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.configurations.size).toBe(0);
  });
  it("a failed vault deletion keeps the connection listed for another attempt", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.manager.remove.mockResolvedValueOnce({
      ok: false,
      error: { code: "storage-uncertain" },
    });
    expect(await h.caller.remove(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
    expect(h.registry.remove).not.toHaveBeenCalled();
    expect(h.configurations.size).toBe(1);
    expect((await h.caller.remove(accountProfile.connectionId)).ok).toBe(true);
    expect(h.configurations.size).toBe(0);
  });
  it("permission removal never rejects when the registry or permission check fails", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.registry.list.mockRejectedValueOnce(new Error("synthetic registry failure"));
    await expect(h.service.permissionsRemoved()).resolves.toBeUndefined();
    h.permissions.contains.mockRejectedValueOnce(new Error("synthetic permission failure"));
    await expect(h.service.permissionsRemoved()).resolves.toBeUndefined();
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
  });
  it("a sign-in whose permission is removed after acceptance keeps no sync session", async () => {
    const h = harness({ existing: true });
    const accept = h.manager.accept.getMockImplementation()!;
    h.manager.accept.mockImplementation(async (...input: Parameters<typeof accept>) => {
      const result = await accept(...input);
      h.permission(false);
      return result;
    });
    await connected(h);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()?.state).toBe("active");
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
    expect(await h.revisions.revision(accountProfile.connectionId)).toBeUndefined();
  });
});

describe("permission removal across connections", () => {
  it("deletes only the session whose provider permission was lost", async () => {
    const kept: BitwardenProfile = structuredClone(accountProfile);
    const lost: BitwardenProfile = { ...kept, connectionId: crypto.randomUUID() };
    const memories = new Map(
      [kept, lost].map((profile) => {
        const memory = memorySessionStore({ profile, cacheRevision: () => null });
        memory.set({
          schemaVersion: 1,
          revision: crypto.randomUUID(),
          profile,
          binding: { userId: accountUserId, email: v1Email },
          encryptedAccount: {},
          state: "active",
          accessToken: "a.b.c",
          receivedAt: 1,
          expiresIn: 60,
        });
        return [profile.connectionId, memory] as const;
      }),
    );
    const configurations = [kept, lost].map((profile) => ({
      profile,
      label: "Synthetic vault",
      email: v1Email,
      deviceIdentifier: crypto.randomUUID(),
    }));
    const service = createConnectionSetupService({
      host: { deriveAuthentication: vi.fn() },
      transportFor: vi.fn(),
      permissions: {
        contains: async (profile) => profile.connectionId === kept.connectionId,
      },
      registry: {
        list: async () => structuredClone(configurations),
        get: async (id) =>
          structuredClone(configurations.find((entry) => entry.profile.connectionId === id)),
        put: vi.fn(),
        remove: vi.fn(),
      },
      policy: { register: vi.fn(), adopt: vi.fn() },
      vaultFor: vi.fn(),
      sessions: createProviderSessions({
        storeFor: (profile) => memories.get(profile.connectionId)!.store,
      }),
    });
    await service.permissionsRemoved();
    expect(memories.get(kept.connectionId)!.raw()).toMatchObject({ state: "active" });
    expect(memories.get(lost.connectionId)!.raw()).toBeUndefined();
  });
});
