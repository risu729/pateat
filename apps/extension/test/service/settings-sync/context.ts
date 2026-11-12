import type { LocalSettings } from "@pateat/contracts";
import type { SettingsSyncFixtures } from "../../../src/service/settings-sync.test";

export type AfterFirstContext = Pick<
  SettingsSyncFixtures,
  | "it"
  | "setup"
  | "localConnection"
  | "state"
  | "baseOf"
  | "expect"
  | "CONNECTION"
  | "never"
  | "account"
  | "binding"
  | "settingsOf"
  | "syncedSettings"
  | "mergeSyncedSettings"
  | "site"
  | "vi"
  | "MAX_SETTINGS_SYNC_ATTEMPTS"
  | "PROFILE"
  | "MAX_SETTINGS_DEFER_MS"
> & { agreed: LocalSettings };

type AccountOwner = { provider: string; server: string; userId: string };
export type VaultPolicyContext = Pick<
  SettingsSyncFixtures,
  | "it"
  | "settingsOf"
  | "localConnection"
  | "setup"
  | "expect"
  | "CONNECTION"
  | "never"
  | "state"
  | "syncedSettings"
  | "mergeSyncedSettings"
  | "binding"
  | "baseOf"
> & {
  owner: AccountOwner;
  demo: AccountOwner;
  accountPolicy: (
    enabled?: boolean,
    who?: AccountOwner,
  ) => LocalSettings["accountPolicies"][number];
  itemPolicy: (
    itemId: string,
    overrides?: Partial<LocalSettings["itemPolicies"][number]>,
  ) => LocalSettings["itemPolicies"][number];
  review: (
    itemId: string,
    digit?: string,
    who?: AccountOwner,
  ) => LocalSettings["customFieldReviews"][number];
  demoEntries: Pick<LocalSettings, "accountPolicies" | "itemPolicies" | "customFieldReviews">;
};

type DetailLink = {
  origin: string;
  provider: string;
  server: string;
  userId: string;
  itemId: string;
  detail: "birth-date" | "card-code" | "secret-answer";
  source: { itemId: string; field: "card.code" | { custom: string } };
  question?: string;
};
export type DetailLinksContext = Pick<
  SettingsSyncFixtures,
  | "it"
  | "setup"
  | "settingsOf"
  | "state"
  | "baseOf"
  | "expect"
  | "CONNECTION"
  | "never"
  | "localConnection"
  | "syncedSettings"
  | "mergeSyncedSettings"
  | "site"
  | "OTHER_PROFILE"
> & {
  link: (
    origin: string,
    detail?: DetailLink["detail"],
    source?: DetailLink["source"],
    question?: string,
  ) => DetailLink;
  birthDate: DetailLink;
  cardCode: DetailLink;
};
