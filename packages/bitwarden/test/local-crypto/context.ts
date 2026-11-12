import type { LocalCryptoTestFixtures } from "../../src/local-crypto.test";

export type AccountInitializationContext = Pick<
  LocalCryptoTestFixtures,
  | "sessions"
  | "v1Input"
  | "v2Input"
  | "organizationInput"
  | "corrupt"
  | "securityStateWithVersion"
  | "verifiedAsRecordedSdk"
  | "session"
>;

export type CipherIsolationContext = Pick<
  LocalCryptoTestFixtures,
  | "connectionId"
  | "sessions"
  | "v1Input"
  | "v2Input"
  | "blobInput"
  | "blobCipher"
  | "organizationInput"
  | "unopenedOrganizationId"
  | "organizationCipher"
  | "expectOrganizationLeftOut"
  | "corrupt"
  | "viewOverrideSdk"
  | "session"
>;

export type ItemRepairContext = Pick<
  LocalCryptoTestFixtures,
  "connectionId" | "corrupt" | "session"
>;
