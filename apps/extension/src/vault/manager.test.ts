import { afterEach, describe, expect, vi, type Mock } from "vitest";
import { v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import {
  accepted,
  candidate,
  gate,
  harness,
  itemId,
  managers,
} from "../../test/vault-manager/harness";
import type { Operation, OperationName } from "../../test/vault-manager/context";
import {
  registerLiveOperationAuthorityCases,
  registerMutableArgumentCases,
  registerInvalidInputCases,
} from "../../test/vault-manager/live-operation-cases";
import { registerAcceptanceCases } from "../../test/vault-manager/acceptance-cases";
import { registerComparisonCases } from "../../test/vault-manager/comparison-cases";
import { registerDisableCases } from "../../test/vault-manager/disable-cases";
import { registerRemovalCases } from "../../test/vault-manager/removal-cases";
import { registerRestoreCases } from "../../test/vault-manager/restore-cases";
import { registerIdentityCases } from "../../test/vault-manager/identity-cases";
import { registerDurableAuthorityCases } from "../../test/vault-manager/durable-authority-cases";
import { registerHostLifecycleCases } from "../../test/vault-manager/host-lifecycle-cases";
import {
  registerRetainedAcceptanceCases,
  registerRetainedRestoreCases,
  registerRetainedKeyLookupCases,
  registerUnlockCases,
  registerVaultLockCases,
  registerKeyRetentionChangeCases,
  registerLogoutRemovalCases,
} from "../../test/vault-manager/retention-cases";

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
});

describe("live vault operations preserve their authority across asynchronous work", () => {
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
