import { expect, it, vi } from "vitest";
import type { CryptoHost } from "../../../src/crypto/host";
import type { HostSessionRef } from "../../../src/crypto/wire";
import type { VaultEntry } from "../../../src/vault/record";
import { activeEntry } from "../../../src/vault/__fixtures__/vault";
import { accountProfile } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { createConnectionRuntime } from "../../../src/connections/runtime";

export function registerCurrentCatalogCases({ stored }: { stored: { entry: VaultEntry | null } }) {
  it("restores a vault whose session the crypto host has ended", async () => {
    const entry = activeEntry();
    stored.entry = entry;
    // Sessions the fake host still has; a Worker timeout or a lost offscreen document ends them.
    const sessions = new Set<string>();
    const host = {
      open: vi.fn<CryptoHost["open"]>(async (request) => {
        const session: HostSessionRef = {
          brokerGeneration: "synthetic-generation",
          connectionId: accountProfile.connectionId,
          userId: request.prepared.binding.userId,
          snapshotId: request.snapshotId,
          sessionId: crypto.randomUUID(),
        };
        sessions.add(session.sessionId);
        return {
          ok: true,
          data: {
            session,
            metadata: {
              connectionId: accountProfile.connectionId,
              userId: request.prepared.binding.userId,
              accountVersion: request.prepared.binding.accountVersion,
              securityVersion: 1,
            },
          },
        };
      }),
      verifyReceivedCiphers: vi.fn<CryptoHost["verifyReceivedCiphers"]>(async () => ({
        ok: true,
        data: {
          verifiedCipherCount: entry.accepted.prepared.ciphers.length,
          unusableItems: [],
          partialItems: [],
        },
      })),
      catalog: vi.fn<CryptoHost["catalog"]>(async (session) =>
        sessions.has(session.sessionId)
          ? {
              ok: true,
              data: {
                connectionId: session.connectionId,
                userId: session.userId,
                snapshotId: session.snapshotId,
                groups: [],
                items: [],
              },
            }
          : { ok: false, error: { code: "crypto-locked" } },
      ),
      lock: vi.fn<CryptoHost["lock"]>(async (session) => {
        sessions.delete(session.sessionId);
        return { ok: true, data: null };
      }),
      isOpen: vi.fn((session: HostSessionRef) => sessions.has(session.sessionId)),
    };
    const configuration = {
      profile: accountProfile,
      label: "Synthetic",
      email: "synthetic@example.com",
      deviceIdentifier: crypto.randomUUID(),
    };
    const runtime = createConnectionRuntime(host as unknown as CryptoHost, {
      registry: { list: async () => [configuration], get: async () => configuration } as never,
    });
    const id = accountProfile.connectionId;
    expect((await runtime.current(id)).catalog.snapshotId).toBe(entry.accepted.snapshotId);
    expect(host.open).toHaveBeenCalledOnce();
    sessions.clear();
    expect((await runtime.current(id)).catalog.snapshotId).toBe(entry.accepted.snapshotId);
    expect(host.open).toHaveBeenCalledTimes(2);
  });
}
