import type { AccountTestFixtures } from "../../src/account.test";

export type BindingAdmissionContext = Pick<
  AccountTestFixtures,
  "bootstrap" | "known" | "setAt" | "authenticated" | "mapper" | "mapRaw"
>;

export type ModernAccountContext = Pick<AccountTestFixtures, "known" | "setAt" | "mapRaw">;

export type ItemMappingContext = Pick<
  AccountTestFixtures,
  "setAt" | "mapRaw" | "expectLeftOut" | "received" | "rawWithCollection"
>;

export type SameAccountUriContext = Pick<AccountTestFixtures, "mapRaw">;
