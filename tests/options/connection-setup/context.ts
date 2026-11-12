import type { Mock } from "vitest";
import type { page } from "vitest/browser";
import type { ConnectionClient } from "../../../apps/extension/src/options/connection-client";
import type {
  createMetadataQueryClient,
  SettingsClient,
} from "../../../apps/extension/src/options/client";
import type { SetupReply } from "../../../apps/extension/src/connections/types";

type MockConnectionClient = { [Method in keyof ConnectionClient]: Mock<ConnectionClient[Method]> };
type MockSettingsClient = { [Method in keyof SettingsClient]: Mock<SettingsClient[Method]> };
type RegisteredConnection = {
  connectionId: string;
  label: string;
  email: string;
  environment: { kind: "cloud"; region: "us" };
  state: "configured";
  autoUnlock: "unknown";
  providerSession: "none";
};
type LockedVault = {
  connectionId: string;
  label: string;
  email: string;
  environment: { kind: "cloud"; region: "us" };
  state: "locked";
  autoUnlock: "disabled";
  providerSession: "active";
};

export interface ConnectionSetupTestContext {
  password: string;
  flowId: string;
  expiresAt: number;
  ready: () => SetupReply;
  status: () => Extract<SetupReply, { kind: "status" }>;
  mockClient: () => MockConnectionClient;
  held: <T>() => { promise: Promise<T>; resolve: (value: T) => void };
  painted: () => Promise<unknown>;
  mount: (client?: MockConnectionClient) => Promise<{
    client: MockConnectionClient;
    queryClient: ReturnType<typeof createMetadataQueryClient>;
    changed: Mock;
  }>;
  fillNew: () => Promise<void>;
  withFakeInterval: (run: () => Promise<void>) => Promise<void>;
  expiredText: string;
  endedLine: () => string | null;
  catalogChangeDuringCleanReload: () => Promise<{
    settings: Pick<MockSettingsClient, "getSettings" | "saveSettings" | "findSiteAccounts">;
    finish: () => void;
  }>;
  registered: RegisteredConnection;
  addForm: () => string | null | undefined;
  statusOutput: () => ReturnType<typeof page.elementLocator>;
  pressWithKeyboard: (name: string) => Promise<ReturnType<typeof page.getByRole>>;
  lockedVault: LockedVault;
  unlockField: () => ReturnType<typeof page.getByLabelText>;
  unlockRow: () => ReturnType<typeof page.getByRole>;
  submitUnlock: () => ReturnType<typeof page.getByRole>;
}
