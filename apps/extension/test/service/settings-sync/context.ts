import type { LocalSettings } from "@pateat/contracts";
import type { SettingsSyncFixtures } from "../../../src/service/settings-sync.test";

export type AfterFirstContext = Pick<
  SettingsSyncFixtures,
  | "setup"
  | "localConnection"
  | "state"
  | "baseOf"
  | "CONNECTION"
  | "never"
  | "account"
  | "binding"
  | "settingsOf"
  | "site"
  | "PROFILE"
> & { agreed: LocalSettings };

type AccountOwner = { provider: string; server: string; userId: string };
export type VaultPolicyContext = Pick<
  SettingsSyncFixtures,
  | "settingsOf"
  | "localConnection"
  | "setup"
  | "CONNECTION"
  | "never"
  | "state"
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
  | "setup"
  | "settingsOf"
  | "state"
  | "baseOf"
  | "CONNECTION"
  | "never"
  | "localConnection"
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
