import type { PopupTestFixtures } from "../popup.test";

export type PopupOpeningContext = Pick<
  PopupTestFixtures,
  "saved" | "demoSiteAccounts" | "store" | "noChoice" | "mount"
>;

export type PopupPolicyContext = Pick<
  PopupTestFixtures,
  "saved" | "store" | "noChoice" | "mount" | "pageOf"
>;

export type PopupSettingsContext = Pick<
  PopupTestFixtures,
  | "saved"
  | "demoSiteAccounts"
  | "store"
  | "noChoice"
  | "mount"
  | "fakeDeadline"
  | "pageOf"
  | "pressWithKeyboard"
  | "holdNextSave"
  | "resultMessage"
  | "onPage"
  | "lineText"
>;

export type PopupChoiceContext = Pick<
  PopupTestFixtures,
  "saved" | "demoSiteAccounts" | "store" | "noChoice" | "mount" | "POLL_MS" | "fakePolls" | "pageOf"
>;

export type PopupPageContext = Pick<
  PopupTestFixtures,
  | "saved"
  | "store"
  | "noChoice"
  | "mount"
  | "POLL_MS"
  | "fakePolls"
  | "onPage"
  | "lineText"
  | "pageLines"
>;

export type PopupDetailContext = Pick<
  PopupTestFixtures,
  | "saved"
  | "store"
  | "noChoice"
  | "noDetails"
  | "mount"
  | "resultMessage"
  | "onPage"
  | "withDetails"
  | "birthOffer"
>;

export type PopupAvailabilityContext = Pick<PopupTestFixtures, "store" | "mount" | "withLocked">;

export type PopupPageBehaviorContext = Pick<PopupTestFixtures, "saved" | "store" | "mount">;
