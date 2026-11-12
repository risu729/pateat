import type { SettingsAppTestFixtures } from "../settings-app.test";

export type SettingsChangeContext = Pick<
  SettingsAppTestFixtures,
  "saved" | "mockClient" | "control" | "mount" | "addSite" | "deferred"
>;

export type VaultPolicyContext = Pick<
  SettingsAppTestFixtures,
  "saved" | "mockClient" | "control" | "mount" | "expand"
>;

export type SitePolicyContext = Pick<
  SettingsAppTestFixtures,
  "saved" | "demoSiteAccounts" | "mockClient" | "control" | "mount" | "addSite" | "deferred"
>;

export type ReloadAndDraftContext = Pick<
  SettingsAppTestFixtures,
  "saved" | "mockClient" | "control" | "mount" | "addSite" | "deferred"
>;

export type SaveConflictContext = Pick<
  SettingsAppTestFixtures,
  | "saved"
  | "demoSiteAccounts"
  | "mockClient"
  | "control"
  | "mount"
  | "addSite"
  | "deferred"
  | "conflict"
  | "written"
>;

export type NavigationPreferenceContext = Pick<
  SettingsAppTestFixtures,
  "saved" | "mockClient" | "control" | "mount" | "navLink" | "disconnectedService"
>;
