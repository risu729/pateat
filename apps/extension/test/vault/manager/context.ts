import type { Mock } from "vitest";
import type {
  KeyRetention,
  LocalVaultHandle,
  LocalVaultManager,
  VaultCheckpoint,
  VaultCryptoHost,
} from "../../../src/vault/manager";
import type { VaultEntry } from "../../../src/vault/record";
import type { SessionKeyStore } from "../../../src/vault/session-key";
import type { DurableVaultStore } from "../../../src/vault/storage";
import type { OpenedHostSession } from "../../../src/crypto/host";
import type { preparedVault } from "../../../../../packages/bitwarden/src/__fixtures__/unlock";

type Gate = { promise: Promise<void>; release: () => void };
type HostMethod = Exclude<keyof VaultCryptoHost, "ssoMethods" | "ssoCandidates">;
type Harness = {
  manager: LocalVaultManager;
  store: { [K in keyof DurableVaultStore]: Mock<DurableVaultStore[K]> };
  host: { [K in HostMethod]: Mock<VaultCryptoHost[K]> };
  opened: Map<string, { data: OpenedHostSession; prepared: ReturnType<typeof preparedVault> }>;
  events: string[];
  sessionKey: { [K in keyof SessionKeyStore]: Mock<SessionKeyStore[K]> };
  sessionValue: SessionKeyStore["read"];
  setRetention: (value: KeyRetention) => void;
  entry: () => VaultEntry | null;
  setEntry: (value: VaultEntry | null) => void;
};
type Accepted = Extract<Awaited<ReturnType<LocalVaultManager["accept"]>>, { ok: true }>["data"];
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
  hold: (h: Harness, held: Gate) => void;
};
type SourceInput = { itemId: string; allowedFieldIds: string[] };
type CandidateInput = { usernameProof: string; candidates: SourceInput[] };
type SsoData =
  | {
      itemId: string;
      snapshotId: string;
      sourceEvidence: string;
      result: { status: string; methods: never[] };
    }
  | { snapshotId: string; candidates: never[] };

export interface VaultManagerTestContext {
  managers: LocalVaultManager[];
  harness: (options?: {
    initial?: VaultEntry;
    checkpoint?: (stage: VaultCheckpoint) => Promise<void>;
    retention?: KeyRetention | (() => Promise<KeyRetention>);
  }) => Harness;
  candidate: (autoUnlock?: "enable" | "preserve") => {
    prepared: ReturnType<typeof preparedVault>;
    unlock: { kind: "password"; password: string };
    autoUnlock: "enable" | "preserve";
  };
  accepted: (h: Harness) => Promise<Accepted>;
  gate: () => Gate;
  itemId: string;
  compare: (ids?: string[]) => {
    prepared: ReturnType<typeof preparedVault>;
    unlock: { kind: "password"; password: string };
    autoUnlock: "enable" | "preserve";
    compareCustomFields: string[];
  };
  unlocked: (
    h: Harness,
    password?: string,
  ) => Promise<Extract<Awaited<ReturnType<LocalVaultManager["unlock"]>>, { ok: true }>["data"]>;
  passwordFailure: { ok: false; error: { code: "crypto-failed" } };
  operation: Operation;
  signingInput: () => {
    itemId: string;
    credentialId: string;
    rpId: string;
    authenticatorData: string;
    clientDataHash: string;
  };
  invalid: {
    name: OperationName;
    code: "invalid-request" | "invalid-uri-input";
    invoke: Operation["invoke"];
  }[];
  sourceInput: SourceInput;
  candidateInput: CandidateInput;
  ssoHarness: (kind: "ssoMethods" | "ssoCandidates") => Harness & {
    invoke: (handle: LocalVaultHandle) => Promise<unknown>;
    native: Mock<
      (
        session: OpenedHostSession["session"],
        input: unknown,
      ) => Promise<{ ok: true; data: SsoData }>
    >;
    input: SourceInput | CandidateInput;
  };
  kind: "ssoMethods" | "ssoCandidates";
}
