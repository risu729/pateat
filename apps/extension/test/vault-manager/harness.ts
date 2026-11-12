import { expect, vi } from "vitest";
import {
  createLocalVaultManager,
  type KeyRetention,
  type LocalVaultManager,
  type VaultCheckpoint,
  type VaultCryptoHost,
} from "../../src/vault/manager";
import { type VaultEntry, vaultFailure } from "../../src/vault/record";
import { memorySessionKeyStore, type SessionKeyStore } from "../../src/vault/session-key";
import type { DurableVaultStore } from "../../src/vault/storage";
import type { HostSessionRef } from "../../src/crypto/wire";
import type { OpenedHostSession } from "../../src/crypto/host";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import {
  legacyItemKey,
  v1Password,
  V2_DECRYPTED_USER_KEY,
} from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { preparedVault } from "../../../../packages/bitwarden/src/__fixtures__/unlock";

/** The synthetic vault manager harness shared by the manager test files. */
export const managers: LocalVaultManager[] = [];
export const itemId = preparedVault().ciphers[0]!.id! as unknown as string;
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export function harness(
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
export function candidate(autoUnlock: "enable" | "preserve" = "enable") {
  return {
    prepared: preparedVault(),
    unlock: { kind: "password" as const, password: v1Password },
    autoUnlock,
  };
}
export async function accepted(h: ReturnType<typeof harness>) {
  const result = await h.manager.accept(candidate());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Synthetic unit accept failed");
  return result.data;
}
