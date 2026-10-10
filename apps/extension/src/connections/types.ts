import type {
  BitwardenProfile,
  BitwardenResult,
  BitwardenTransport,
  LocalVaultMetadata,
} from "@pateat/bitwarden";
import type { CryptoHost } from "../crypto/host";
import type { LocalVaultManager, LocalVaultHandle } from "../vault/manager";
import type { DurableVaultStore } from "../vault/storage";
import type { ProviderSessions, ProviderSessionState } from "./sessions";
import type { VaultEntry, VaultErrorCode, VaultResult } from "../vault/record";
import type { VaultCatalog } from "@pateat/contracts";

/** Connection configuration contains no password, provider token or vault value. */
export type BitwardenConnectionConfiguration = {
  profile: BitwardenProfile;
  label: string;
  email: string;
  deviceIdentifier: string;
};
export interface ConnectionRegistry {
  list(): Promise<BitwardenConnectionConfiguration[]>;
  get(connectionId: string): Promise<BitwardenConnectionConfiguration | undefined>;
  /** Profiles are immutable for an existing ID. A different account needs a new connection. */
  put(configuration: BitwardenConnectionConfiguration): Promise<void>;
}
export type SetupBegin =
  | {
      kind: "new";
      environment: BitwardenProfile["environment"];
      label: string;
      email: string;
      password: string;
      enabled: boolean;
    }
  | {
      kind: "existing";
      connectionId: string;
      password: string;
      autoUnlock: "enable" | "preserve";
    };
export type SetupContinuation = {
  flowId: string;
  twoFactor?: { provider: 0 | 1; code: string };
  newDeviceOtp?: string;
};
export type SetupReply =
  | { ok: true; kind: "disabled"; connectionId: string }
  | { ok: true; kind: "forgotten"; connectionId: string }
  | {
      ok: true;
      kind: "status";
      connections: {
        connectionId: string;
        label: string;
        email: string;
        environment: BitwardenProfile["environment"];
        autoUnlock: "enabled" | "disabled" | "unknown";
        state: "configured" | "ready" | "disabled" | "review-required" | "unavailable";
        /** Sync sign-in, independent of offline unlock. Never contains a token. */
        providerSession: ProviderSessionState | "unavailable";
        snapshotId?: string;
      }[];
    }
  | {
      ok: true;
      kind: "ready";
      connectionId: string;
      snapshotId: string;
      policyReviewItemIds: string[];
    }
  | { ok: true; kind: "mfa-required"; flowId: string; providers: (0 | 1)[] }
  | {
      ok: true;
      kind: "new-device-verification-required";
      flowId: string;
      invalidOtp: boolean;
    }
  | {
      ok: true;
      kind: "interaction-required";
      reason: "sso" | "protocol-compatibility" | "unsupported-challenge";
    }
  | { ok: true; kind: "cancelled" }
  | {
      ok: false;
      error: {
        code:
          | VaultErrorCode
          | "provider-permission-required"
          | "setup-expired"
          | "setup-unavailable"
          | "authentication-rejected"
          | "setup-reauthentication-required"
          | "revision-conflict";
      };
    };
export interface ConnectionPolicy {
  quarantined?(connectionId: string, snapshotId: string): Promise<string[]>;
  review?(input: {
    connectionId: string;
    itemId: string;
    snapshotId: string;
    expectedRevision: number;
    excludedFieldIds: string[];
  }): Promise<{ policyReviewItemIds: string[] }>;
  /** Reconcile after durable cache acceptance; an unmatched binding never authorizes release. */
  adopt(input: {
    previous: VaultEntry | null;
    next: VaultEntry;
    catalog: VaultCatalog["connections"][number];
    enabled?: boolean;
  }): Promise<{ policyReviewItemIds: string[] }>;
}
export type ConnectionSetupDependencies = {
  host: Pick<CryptoHost, "deriveAuthentication">;
  transportFor(profile: BitwardenProfile): BitwardenResult<BitwardenTransport>;
  permissions: { contains(profile: BitwardenProfile): Promise<boolean> };
  vaultFor(profile: BitwardenProfile): {
    manager: Pick<
      LocalVaultManager,
      "accept" | "restore" | "disableAutoUnlock" | "status" | "dispose"
    > & {
      lock?(): Promise<void>;
      catalog(
        handle: LocalVaultHandle,
        signal?: AbortSignal,
      ): Promise<VaultResult<LocalVaultMetadata>>;
    };
    store: DurableVaultStore;
  };
  registry: ConnectionRegistry;
  policy: ConnectionPolicy;
  sessions: Pick<ProviderSessions, "status" | "retain" | "acquire" | "forget" | "discard">;
  nowMs?: () => number;
  randomId?: () => string;
};
