import {
  registerLiveOperationAuthorityCases,
  registerMutableArgumentCases,
  registerInvalidInputCases,
} from "../../test/vault/manager/live-operations";
import { registerAcceptanceCases } from "../../test/vault/manager/acceptance";
import { registerComparisonCases } from "../../test/vault/manager/comparison";
import { registerDisableCases } from "../../test/vault/manager/disable";
import { registerRemovalCases } from "../../test/vault/manager/removal";
import { registerRestoreCases } from "../../test/vault/manager/restore";
import { registerIdentityCases } from "../../test/vault/manager/identity";
import { registerDurableAuthorityCases } from "../../test/vault/manager/durable-authority";
import { registerHostLifecycleCases } from "../../test/vault/manager/host-lifecycle";
import {
  registerRetainedAcceptanceCases,
  registerRetainedRestoreCases,
  registerRetainedKeyLookupCases,
  registerUnlockCases,
  registerVaultLockCases,
  registerKeyRetentionChangeCases,
  registerLogoutRemovalCases,
} from "../../test/vault/manager/retention";
import { registerSsoCases } from "../../test/vault/manager/sso";
import { afterEach, describe, expect, vi, type Mock } from "vitest";
import {
  createLocalVaultManager,
  type KeyRetention,
  type LocalVaultManager,
  type LocalVaultHandle,
  type VaultCheckpoint,
  type VaultCryptoHost,
} from "./manager";
import { type VaultEntry, vaultFailure } from "./record";
import { memorySessionKeyStore, type SessionKeyStore } from "./session-key";
import type { DurableVaultStore } from "./storage";
import type { HostSessionRef } from "../crypto/wire";
import type { OpenedHostSession } from "../crypto/host";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import {
  legacyItemKey,
  v1Password,
  V2_DECRYPTED_USER_KEY,
} from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { preparedVault } from "../../../../packages/bitwarden/src/__fixtures__/unlock";
import { snapshotId } from "./__fixtures__/vault";

const managers: LocalVaultManager[] = [];
const itemId = preparedVault().ciphers[0]!.id! as unknown as string;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function harness(
  options: {
    initial?: VaultEntry;
    checkpoint?: (stage: VaultCheckpoint) => Promise<void>;
    /** Where the manager keeps a key it writes; absent leaves the option out. */
    retention?: KeyRetention | (() => Promise<KeyRetention>);
  } = {},
) {
  let entry: VaultEntry | null = options.initial ? structuredClone(options.initial) : null;
  let retention = typeof options.retention === "string" ? options.retention : undefined;
  const retentionOption = options.retention;
  const events: string[] = [];
  const memory = memorySessionKeyStore();
  const sessionKey = {
    read: vi.fn<SessionKeyStore["read"]>(() => memory.read()),
    write: vi.fn<SessionKeyStore["write"]>((value) => memory.write(value)),
    clear: vi.fn<SessionKeyStore["clear"]>(() => memory.clear()),
  };
  const opened = new Map<
    string,
    { data: OpenedHostSession; prepared: ReturnType<typeof preparedVault> }
  >();
  const store = {
    read: vi.fn<DurableVaultStore["read"]>(async () => ({
      ok: true as const,
      data: structuredClone(entry),
    })),
    compareAndSwap: vi.fn<DurableVaultStore["compareAndSwap"]>(async (expected, next) => {
      events.push("commit");
      if ((entry?.revision ?? null) !== expected) return vaultFailure("storage-conflict");
      entry = structuredClone(next);
      return { ok: true as const, data: { revision: next.revision } };
    }),
    remove: vi.fn<DurableVaultStore["remove"]>(async () => {
      events.push("remove");
      entry = null;
      return { ok: true as const, data: true as const };
    }),
    close: vi.fn(),
  };
  const host = {
    open: vi.fn<VaultCryptoHost["open"]>(async (request) => {
      events.push("open");
      const session: HostSessionRef = {
        brokerGeneration: crypto.randomUUID(),
        connectionId: accountProfile.connectionId,
        userId: request.prepared.binding.userId,
        snapshotId: request.snapshotId,
        sessionId: crypto.randomUUID(),
      };
      const metadata = {
        connectionId: accountProfile.connectionId,
        userId: request.prepared.binding.userId,
        accountVersion: request.prepared.binding.accountVersion,
        securityVersion:
          request.prepared.binding.accountVersion === "v2" ? (2 as const) : (1 as const),
      };
      const data = { session, metadata };
      opened.set(session.sessionId, { data, prepared: request.prepared });
      return { ok: true as const, data };
    }),
    verifyReceivedCiphers: vi.fn<VaultCryptoHost["verifyReceivedCiphers"]>(async (session) => {
      events.push("verify-all");
      return {
        ok: true as const,
        data: {
          verifiedCipherCount: opened.get(session.sessionId)!.prepared.ciphers.length,
          unusableItems: [],
          partialItems: [],
        },
      };
    }),
    exportUnlockMaterial: vi.fn<VaultCryptoHost["exportUnlockMaterial"]>(async (session) => {
      events.push("export");
      const active = opened.get(session.sessionId)!;
      return {
        ok: true as const,
        data: {
          metadata: structuredClone(active.data.metadata),
          userKey:
            active.data.metadata.accountVersion === "v2" ? V2_DECRYPTED_USER_KEY : legacyItemKey,
        },
      };
    }),
    lock: vi.fn<VaultCryptoHost["lock"]>(async (session) => {
      events.push("lock");
      opened.delete(session.sessionId);
      return { ok: true as const, data: null };
    }),
    // The host forgets a session on lock, a timed-out job or a lost offscreen document.
    isOpen: vi.fn((session: HostSessionRef) => opened.has(session.sessionId)),
    catalog: vi.fn<VaultCryptoHost["catalog"]>(async (session) => ({
      ok: true as const,
      data: {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
        groups: [],
        items: [],
      },
    })),
    loginUsernames: vi.fn<VaultCryptoHost["loginUsernames"]>(async (_session, itemIds) => ({
      ok: true as const,
      data: { usernames: Object.fromEntries(itemIds.map((id) => [id, "alice@example.test"])) },
    })),
    matchUris: vi.fn<VaultCryptoHost["matchUris"]>(async (session, targetUrl) => ({
      ok: true as const,
      data: {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
        targetOrigin: new URL(targetUrl).origin,
        candidates: [{ itemId, matches: [{ uriIndex: 0, match: 0 as const }] }],
        unavailableUris: [],
        unavailableItemIds: [],
      },
    })),
    listFields: vi.fn<VaultCryptoHost["listFields"]>(async (session, selectedId) => {
      const active = opened.get(session.sessionId);
      if (!active?.prepared.ciphers.some((cipher) => String(cipher.id) === selectedId))
        return { ok: false as const, error: { code: "field-missing" as const } };
      return {
        ok: true as const,
        data: [
          {
            kind: "hidden" as const,
            name: null,
            label: "Password",
            ref: {
              connectionId: session.connectionId,
              userId: session.userId,
              snapshotId: session.snapshotId,
              itemId: selectedId,
              fieldId: "login.password",
            },
          },
        ],
      };
    }),
    resolveField: vi.fn<VaultCryptoHost["resolveField"]>(async (_session, _ref, grant) =>
      grant.allowedFieldIds.includes("login.password")
        ? { ok: true as const, data: { kind: "text" as const, value: "synthetic-unit-password" } }
        : { ok: false as const, error: { code: "field-denied" as const } },
    ),
    // Stands in for the offscreen-keyed digest: equal for an item present in both sessions.
    customFieldDigests: vi.fn<VaultCryptoHost["customFieldDigests"]>(async (session, ids) => {
      events.push("digest");
      const active = opened.get(session.sessionId);
      return {
        ok: true as const,
        data: {
          digests: Object.fromEntries(
            ids.map((id) => [
              id,
              active?.prepared.ciphers.some((cipher) => String(cipher.id) === id)
                ? "A".repeat(43)
                : null,
            ]),
          ),
        },
      };
    }),
    findPasskeys: vi.fn<VaultCryptoHost["findPasskeys"]>(async (session, rpId) => {
      const binding = {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
      };
      return {
        ok: true as const,
        data: {
          ...binding,
          rpId,
          candidates: [
            {
              ...binding,
              itemId,
              credentialId: "AQID",
              rpId,
              userHandle: "BAUG",
              discoverable: true,
              counter: 0,
              userName: null,
            },
          ],
          unavailableItemIds: [],
        },
      };
    }),
    passkeyRpIds: vi.fn<VaultCryptoHost["passkeyRpIds"]>(async (session, id) => ({
      ok: true as const,
      data: {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
        itemId: id,
        rpIds: ["example.com"],
      },
    })),
    verifyMasterPassword: vi.fn<VaultCryptoHost["verifyMasterPassword"]>(
      async (_session, password) => ({
        ok: true as const,
        data: { matches: password === "synthetic-master-password" },
      }),
    ),
    signPasskey: vi.fn<VaultCryptoHost["signPasskey"]>(async (session, input) => ({
      ok: true as const,
      data: {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
        itemId: input.itemId,
        credentialId: input.credentialId,
        signature: "MEUCIQ",
      },
    })),
  };
  const manager = createLocalVaultManager({
    profile: accountProfile,
    store,
    host,
    nowMs: () => 2_000_000_000_000,
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    ...(retentionOption
      ? {
          retention:
            typeof retentionOption === "function" ? retentionOption : async () => retention!,
        }
      : {}),
    sessionKey,
  });
  managers.push(manager);
  return {
    manager,
    store,
    host,
    opened,
    events,
    sessionKey,
    /** This browser session's key, as the manager left it. */
    sessionValue: () => memory.read(),
    setRetention: (value: KeyRetention) => {
      retention = value;
    },
    entry: () => structuredClone(entry),
    setEntry: (value: VaultEntry | null) => {
      entry = structuredClone(value);
    },
  };
}
function candidate(autoUnlock: "enable" | "preserve" = "enable") {
  return {
    prepared: preparedVault(),
    unlock: { kind: "password" as const, password: v1Password },
    autoUnlock,
  };
}
async function accepted(h: ReturnType<typeof harness>) {
  const result = await h.manager.accept(candidate());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Synthetic unit accept failed");
  return result.data;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
});

describe("live vault operations preserve their authority across asynchronous work", () => {
  type Harness = ReturnType<typeof harness>;
  type OperationName =
    | "listFields"
    | "catalog"
    | "matchUris"
    | "loginUsernames"
    | "findPasskeys"
    | "passkeyRpIds"
    | "signPasskey"
    | "verifyMasterPassword";
  type Operation = {
    name: OperationName;
    args: () => unknown[];
    invoke: (h: Harness, handle: LocalVaultHandle, signal?: AbortSignal) => Promise<unknown>;
    hold: (h: Harness, held: ReturnType<typeof gate>) => void;
  };
  function holdReply<Args extends unknown[], Result>(
    host: Mock<(...args: Args) => Promise<Result>>,
    held: ReturnType<typeof gate>,
  ) {
    const invoke = host.getMockImplementation()!;
    host.mockImplementationOnce(async (...args) => {
      // The host already made a successful result; only its delivery is delayed.
      const result = await invoke(...args);
      await held.promise;
      return result;
    });
  }
  const signingInput = () => ({
    itemId,
    credentialId: "AQID",
    rpId: "example.com",
    authenticatorData: "AQID",
    clientDataHash: "BAUG",
  });
  const operations: Operation[] = [
    {
      name: "listFields",
      args: () => [itemId],
      invoke: (h, handle, signal) => h.manager.listFields(handle, itemId, signal),
      hold: (h, held) => holdReply(h.host.listFields, held),
    },
    {
      name: "catalog",
      args: () => [],
      invoke: (h, handle, signal) => h.manager.catalog(handle, signal),
      hold: (h, held) => holdReply(h.host.catalog, held),
    },
    {
      name: "matchUris",
      args: () => ["https://example.com/login"],
      invoke: (h, handle, signal) =>
        h.manager.matchUris(handle, "https://example.com/login", signal),
      hold: (h, held) => holdReply(h.host.matchUris, held),
    },
    {
      name: "loginUsernames",
      args: () => [[itemId]],
      invoke: (h, handle, signal) => h.manager.loginUsernames(handle, [itemId], signal),
      hold: (h, held) => holdReply(h.host.loginUsernames, held),
    },
    {
      name: "findPasskeys",
      args: () => ["example.com"],
      invoke: (h, handle, signal) => h.manager.findPasskeys(handle, "example.com", signal),
      hold: (h, held) => holdReply(h.host.findPasskeys, held),
    },
    {
      name: "passkeyRpIds",
      args: () => [itemId],
      invoke: (h, handle, signal) => h.manager.passkeyRpIds(handle, itemId, signal),
      hold: (h, held) => holdReply(h.host.passkeyRpIds, held),
    },
    {
      name: "signPasskey",
      args: () => [signingInput()],
      invoke: (h, handle, signal) => h.manager.signPasskey(handle, signingInput(), signal),
      hold: (h, held) => holdReply(h.host.signPasskey, held),
    },
    {
      name: "verifyMasterPassword",
      args: () => ["synthetic-master-password"],
      invoke: (h, handle, signal) =>
        h.manager.verifyMasterPassword(handle, "synthetic-master-password", signal),
      hold: (h, held) => holdReply(h.host.verifyMasterPassword, held),
    },
  ];

  describe.each(operations)("$name", (operation) => {
    registerLiveOperationAuthorityCases({ harness, accepted, gate, operation });
  });

  registerMutableArgumentCases({ harness, accepted, gate, itemId, signingInput });

  const invalid: {
    name: OperationName;
    code: "invalid-request" | "invalid-uri-input";
    invoke: Operation["invoke"];
  }[] = [
    {
      name: "matchUris",
      code: "invalid-uri-input",
      invoke: (h, handle) => h.manager.matchUris(handle, 1 as never),
    },
    {
      name: "findPasskeys",
      code: "invalid-request",
      invoke: (h, handle) => h.manager.findPasskeys(handle, null as never),
    },
    {
      name: "loginUsernames",
      code: "invalid-request",
      invoke: (h, handle) => h.manager.loginUsernames(handle, [() => {}] as never),
    },
    {
      name: "signPasskey",
      code: "invalid-request",
      invoke: (h, handle) =>
        h.manager.signPasskey(handle, { ...signingInput(), extra: () => {} } as never),
    },
    {
      name: "verifyMasterPassword",
      code: "invalid-request",
      invoke: (h, handle) => h.manager.verifyMasterPassword(handle, ""),
    },
  ];
  registerInvalidInputCases({ harness, accepted, invalid });
});

describe("acceptance verification and publication", () => {
  registerAcceptanceCases({ harness, candidate, accepted, gate, itemId });
});

describe("custom-field comparison with the replaced snapshot", () => {
  const compare = (ids: string[] = [itemId]) => ({
    ...candidate("preserve"),
    compareCustomFields: ids,
  });
  registerComparisonCases({ harness, accepted, itemId, compare, managers });
});

describe("durable disable and stale candidate races", () => {
  registerDisableCases({ harness, candidate, accepted, gate, itemId, managers });
});

describe("connection record deletion", () => {
  registerRemovalCases({ harness, candidate, accepted, gate, itemId });
});

describe("offline restore and fresh session scope", () => {
  registerRestoreCases({ harness, candidate, accepted, gate, itemId, managers });
});

describe("prior accepted identity and signed account floor", () => {
  registerIdentityCases({ harness, candidate });
});

describe("durable authority across independent managers", () => {
  registerDurableAuthorityCases({ harness, accepted, gate, itemId, managers });
});

describe("sessions the crypto host has ended", () => {
  registerHostLifecycleCases({ harness, candidate, accepted, itemId });
});

describe("vault lock and key retention (ADR 0075)", () => {
  const passwordFailure = { ok: false as const, error: { code: "crypto-failed" as const } };
  async function unlocked(h: ReturnType<typeof harness>, password = v1Password) {
    const result = await h.manager.unlock(password);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Synthetic unit unlock failed");
    return result.data;
  }
  describe("accept", () => {
    registerRetainedAcceptanceCases({ harness, candidate, accepted, itemId, unlocked });
  });

  describe("restore", () => {
    registerRetainedRestoreCases({ harness });
  });

  describe("keyFor", () => {
    registerRetainedKeyLookupCases({ harness });
  });

  describe("unlock", () => {
    registerUnlockCases({ harness, candidate, gate, itemId, unlocked, passwordFailure });
  });

  describe("lockVault", () => {
    registerVaultLockCases({ harness, candidate, accepted, gate, itemId, unlocked });
  });

  describe("keepKey", () => {
    registerKeyRetentionChangeCases({ harness, candidate, accepted, gate, itemId, unlocked });
  });

  describe("log out and removal", () => {
    registerLogoutRemovalCases({ harness, unlocked });
  });
});

describe("SSO metadata operations preserve durable live-vault authority", () => {
  const sourceInput = { itemId, allowedFieldIds: ["login.username"] };
  const candidateInput = { usernameProof: "P".repeat(43), candidates: [sourceInput] };
  function ssoHarness(kind: "ssoMethods" | "ssoCandidates") {
    const h = harness();
    const data =
      kind === "ssoMethods"
        ? {
            itemId,
            snapshotId,
            sourceEvidence: "E".repeat(43),
            result: { status: "ready", methods: [] },
          }
        : { snapshotId, candidates: [] };
    const host = vi.fn(async (_session: HostSessionRef, _input: unknown) => ({
      ok: true as const,
      data,
    }));
    Object.assign(h.host, { [kind]: host });
    const input = kind === "ssoMethods" ? sourceInput : candidateInput;
    const invoke = (handle: LocalVaultHandle) =>
      kind === "ssoMethods"
        ? h.manager.ssoMethods(handle, sourceInput)
        : h.manager.ssoCandidates(handle, candidateInput);
    return { ...h, invoke, native: host, input };
  }
  describe.each(["ssoMethods", "ssoCandidates"] as const)("%s", (kind) => {
    registerSsoCases({ accepted, gate, itemId, sourceInput, candidateInput, ssoHarness, kind });
  });
});
