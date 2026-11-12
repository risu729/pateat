import type { BadgeTestFixtures } from "../../../src/login/badge.test";
import type { LoginReport } from "../../../src/login/runtime/report";

type Generation = Extract<LoginReport, { type: "generation" }>;
type CaseBase = Pick<BadgeTestFixtures, "harness" | "attempt" | "start" | "origin" | "tabId">;
type BadgeViews = Pick<
  BadgeTestFixtures,
  "NONE" | "choose" | "CHOICE" | "BUSY" | "FAILED" | "SUCCEEDED" | "UNSETTLED"
>;

export type PresentationContext = CaseBase & BadgeViews;
export type WritesNavigationContext = CaseBase & BadgeViews & Pick<BadgeTestFixtures, "OTHER_TAB">;
export type PersistenceContext = CaseBase &
  Pick<BadgeTestFixtures, "NONE" | "FAILED" | "SUCCEEDED">;
export type StatusRecordingContext = CaseBase &
  Pick<BadgeTestFixtures, "refused"> & {
    report: (fields: Partial<Generation> & Pick<Generation, "outcome">) => Generation;
  };
