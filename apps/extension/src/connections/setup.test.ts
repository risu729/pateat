import { afterEach, describe, expect, vi } from "vitest";
import { createBitwardenTransport, type BitwardenProfile } from "@pateat/bitwarden";
import { createVaultSyncRecords, type VaultApplyHold } from "./auto-sync";
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
import { v1Email, v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { activeEntry, lockedEntry } from "../vault/__fixtures__/vault";
import type { VaultEntry } from "../vault/record";
import { createProviderSessions } from "./sessions";
import { memorySessionStore } from "./__fixtures__/sessions";
import { registerCompositionCases } from "../../test/connections/setup/composition-cases";
import { registerChallengeCases } from "../../test/connections/setup/challenge-cases";
import { registerRefreshCases } from "../../test/connections/setup/refresh-cases";
import {
  registerSessionLifecycleCases,
  registerSessionRestartCases,
  registerSessionRevisionCases,
} from "../../test/connections/setup/session-cases";
import { registerPermissionCases } from "../../test/connections/setup/permission-cases";
import { registerLockUnlockCases } from "../../test/connections/setup/lock-unlock-cases";

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
function harness(
  options: {
    existing?: boolean;
    prelogin?: unknown;
    vaultFor?: (
      profile: BitwardenProfile,
    ) => ReturnType<ConnectionSetupDependencies["vaultFor"]> | undefined;
  } = {},
) {
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
    lock: vi.fn(async () => {}),
    remove: vi.fn<ReturnType<ConnectionSetupDependencies["vaultFor"]>["manager"]["remove"]>(
      async () => {
        events.push("remove");
        durable = null;
        return { ok: true as const, data: true as const };
      },
    ),
    dispose: vi.fn(),
    restore: vi.fn(),
    keyFor: vi.fn(async (entry: VaultEntry | null) =>
      entry?.state === "active" ? entry.userKey : undefined,
    ),
    unlock: vi.fn(),
    lockVault: vi.fn(),
    listFields: vi.fn(),
    resolveField: vi.fn(),
    status: vi.fn(() => ({ ready: true })),
    generation: crypto.randomUUID(),
  };
  const policy = {
    register: vi.fn<ConnectionSetupDependencies["policy"]["register"]>(async () => {
      events.push("register");
    }),
    forget: vi.fn<NonNullable<ConnectionSetupDependencies["policy"]["forget"]>>(async () => {}),
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
      vaultFor: (profile) =>
        options.vaultFor?.(profile) ??
        ({ store, manager } as unknown as ReturnType<ConnectionSetupDependencies["vaultFor"]>),
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
    setDurable: (value: VaultEntry | null) => {
      durable = structuredClone(value);
    },
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
  registerCompositionCases({ authenticationHash, newInput, harness, noSecrets });
});

describe("manual challenges and isolated caller lifetime", () => {
  registerChallengeCases({ newInput, harness, noSecrets, closers });
});

describe("failed refresh does not destroy a previously usable cache", () => {
  registerRefreshCases({ authenticationHash, gate, newInput, harness, noSecrets, closers });
});

describe("durable provider sessions", () => {
  async function connected(h: ReturnType<typeof harness>) {
    const begun = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    expect(begun.ok).toBe(true);
  }
  registerSessionRestartCases({ harness, noSecrets, connected });
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
  registerSessionRevisionCases({ harness, connected, hold });
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
  registerSessionLifecycleCases({
    gate,
    newInput,
    harness,
    connected,
    hold,
    waitingForCode,
    closers,
  });
});

describe("permission removal across connections", () => {
  registerPermissionCases();
});

describe("vault lock and offline unlock (ADR 0075)", () => {
  const connectionId = accountProfile.connectionId;
  function unlockedReply() {
    return {
      ok: true as const,
      data: {
        handle: {
          managerGeneration: crypto.randomUUID(),
          handleId: crypto.randomUUID(),
          connectionId,
          userId: accountUserId,
          recordId: lockedEntry().accepted.recordId,
          snapshotId: lockedEntry().accepted.snapshotId,
        },
        summary: {
          connectionId,
          revision: lockedEntry().revision,
          autoUnlock: "disabled" as const,
        },
      },
    };
  }
  async function signedIn(h: ReturnType<typeof harness>) {
    const begun = await h.caller.begin({ kind: "existing", connectionId, password: v1Password });
    expect(begun.ok).toBe(true);
  }
  /** The accepted record, locked in place: the same revision without its key. */
  function lockInPlace(h: ReturnType<typeof harness>) {
    const entry = h.durable();
    if (entry?.state !== "active") throw new Error("Synthetic record not active");
    const { userKey: _userKey, ...rest } = entry;
    h.setDurable({ ...rest, state: "locked" });
    return entry;
  }

  function lockingManager(h: ReturnType<typeof harness>) {
    h.manager.lockVault.mockImplementation(async () => {
      const entry = h.durable();
      if (entry?.state === "active") {
        const { userKey: _userKey, ...rest } = entry;
        h.setDurable({ ...rest, state: "locked", revision: crypto.randomUUID() });
      }
      return { ok: true as const, data: null };
    });
  }

  registerLockUnlockCases({
    gate,
    harness,
    noSecrets,
    connectionId,
    unlockedReply,
    signedIn,
    lockInPlace,
    lockingManager,
    closers,
  });
});
