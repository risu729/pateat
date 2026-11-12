import { expect, it, vi } from "vitest";
import { type BitwardenProfile } from "@pateat/bitwarden";
import { createConnectionSetupService } from "../../../src/connections/setup";
import {
  accountProfile,
  accountUserId,
} from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import { createProviderSessions } from "../../../src/connections/sessions";
import { memorySessionStore } from "../../../src/connections/__fixtures__/sessions";
export function registerPermissionCases() {
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
}
