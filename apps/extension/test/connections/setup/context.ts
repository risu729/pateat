import type { Mock } from "vitest";
import type { BitwardenProfile, createBitwardenTransport } from "@pateat/bitwarden";
import type { createConnectionSetupService } from "../../../src/connections/setup";
import type {
  BitwardenConnectionConfiguration,
  ConnectionSetupDependencies,
  SetupBegin,
  SetupReply,
} from "../../../src/connections/types";
import type { VaultApplyHold, createVaultSyncRecords } from "../../../src/connections/auto-sync";
import type { memorySessionStore } from "../../../src/connections/__fixtures__/sessions";
import type { rawCustomAccount } from "../../../../../packages/bitwarden/src/__fixtures__/connection";
import type { VaultEntry } from "../../../src/vault/record";

type SetupService = ReturnType<typeof createConnectionSetupService>;
type SetupManager = ReturnType<ConnectionSetupDependencies["vaultFor"]>["manager"];
type VoidMock = Mock<() => Promise<void>>;
type ResponseQueue = { body: unknown; status: number }[];
type SetupHarness = {
  caller: ReturnType<SetupService["createCaller"]>;
  service: SetupService;
  host: { deriveAuthentication: Mock<ConnectionSetupDependencies["host"]["deriveAuthentication"]> };
  registry: {
    list: Mock<() => Promise<BitwardenConnectionConfiguration[]>>;
    get: Mock<(id: string) => Promise<BitwardenConnectionConfiguration | undefined>>;
    put: Mock<(config: BitwardenConnectionConfiguration) => Promise<void>>;
    remove: Mock<(id: string) => Promise<void>>;
  };
  configurations: Map<string, BitwardenConnectionConfiguration>;
  manager: {
    accept: Mock<SetupManager["accept"]>;
    catalog: Mock<
      (handle: { connectionId: string; snapshotId: string }) => Promise<{
        ok: true;
        data: {
          connectionId: string;
          userId: string;
          snapshotId: string;
          groups: never[];
          items: {
            id: string;
            label: string;
            type: 1;
            groupIds: never[];
            fields: { id: string; label: string; name: null; kind: "hidden" }[];
          }[];
        };
      }>
    >;
    disableAutoUnlock: Mock;
    lock: VoidMock;
    remove: Mock<SetupManager["remove"]>;
    dispose: Mock;
    restore: Mock;
    keyFor: Mock<
      (
        entry: VaultEntry | null,
      ) => Promise<Extract<VaultEntry, { state: "active" }>["userKey"] | undefined>
    >;
    unlock: Mock;
    lockVault: Mock;
    listFields: Mock;
    resolveField: Mock;
    status: Mock<() => { ready: boolean }>;
    generation: ReturnType<Crypto["randomUUID"]>;
  };
  policy: {
    register: Mock<ConnectionSetupDependencies["policy"]["register"]>;
    forget: Mock<NonNullable<ConnectionSetupDependencies["policy"]["forget"]>>;
    protectedItems: Mock<NonNullable<ConnectionSetupDependencies["policy"]["protectedItems"]>>;
    adopt: Mock<ConnectionSetupDependencies["policy"]["adopt"]>;
  };
  store: {
    read: Mock<() => Promise<{ ok: true; data: VaultEntry | null }>>;
    compareAndSwap: Mock;
    close: Mock;
  };
  fetch: Mock<(url: string, init: RequestInit) => Promise<Response>>;
  revisionDate: Mock<(url: string, init: RequestInit) => Promise<Response>>;
  revisionResponses: ResponseQueue;
  revisions: ReturnType<typeof createVaultSyncRecords>;
  transportFor: Mock<(profile: BitwardenProfile) => ReturnType<typeof createBitwardenTransport>>;
  permissions: { contains: Mock<(profile: BitwardenProfile) => Promise<boolean>> };
  events: string[];
  tokenResponses: ResponseQueue;
  syncResponses: ResponseQueue;
  emailResponses: ResponseQueue;
  sessionMemory: ReturnType<typeof memorySessionStore>;
  restart: () => { service: SetupService; caller: ReturnType<SetupService["createCaller"]> };
  durable: () => VaultEntry | null;
  setDurable: (value: VaultEntry | null) => void;
  permission: (allowed: boolean) => void;
  advance: (ms: number) => void;
  setRaw: (value: ReturnType<typeof rawCustomAccount>) => void;
};

export interface SetupTestContext {
  hold: (ready?: boolean, take?: boolean) => VaultApplyHold & { released: () => boolean };
  waitingForCode: (
    h: SetupHarness,
    input: SetupBegin,
  ) => Promise<Extract<SetupReply, { kind: "mfa-required" }>>;
  closers: (() => unknown)[];
  authenticationHash: string;
  gate: () => { promise: Promise<void>; release: () => void };
  newInput: () => Extract<SetupBegin, { kind: "new" }>;
  harness: (options?: {
    existing?: boolean;
    prelogin?: unknown;
    vaultFor?: (
      profile: BitwardenProfile,
    ) => ReturnType<ConnectionSetupDependencies["vaultFor"]> | undefined;
  }) => SetupHarness;
  noSecrets: (value: unknown) => void;
  connected: (h: SetupHarness) => Promise<void>;
  connectionId: string;
  unlockedReply: () => {
    ok: true;
    data: {
      handle: {
        managerGeneration: string;
        handleId: string;
        connectionId: string;
        userId: string;
        recordId: string;
        snapshotId: string;
      };
      summary: { connectionId: string; revision: string; autoUnlock: "disabled" };
    };
  };
  signedIn: (h: SetupHarness) => Promise<void>;
  lockInPlace: (h: SetupHarness) => Extract<VaultEntry, { state: "active" }>;
  lockingManager: (h: SetupHarness) => void;
}
