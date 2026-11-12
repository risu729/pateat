import type { UriTestFixtures } from "../../src/uri.test";

export type OrdinarySemanticsContext = Pick<UriTestFixtures, "emptyResult" | "saved" | "target">;

export type EquivalentDomainContext = Pick<
  UriTestFixtures,
  "emptyResult" | "saved" | "target" | "userDomains"
>;

export type RetainedContextContext = Pick<
  UriTestFixtures,
  "emptyResult" | "saved" | "target" | "userDomains"
>;

export type StrictAdmissionContext = Pick<
  UriTestFixtures,
  "emptyResult" | "saved" | "target" | "userDomains"
>;

export type RegexAnswerContext = Pick<UriTestFixtures, "target">;
