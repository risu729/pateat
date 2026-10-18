import { builtInLoginSlots, type LoginObservation, type SemanticSlot } from "@pateat/contracts";
import { customField, type EvaluationCase, type ExpectedResult } from "./cases";
import formasaurus from "./formasaurus.json";
import japanese from "./japanese.json";
import { slots } from "./slots";

/**
 * One real page as a derived observation with its labeled mapping (ADR 0012). No page
 * HTML, values or account data; `source` names the dataset page it was derived from.
 */
export type RealPageCase = {
  id: string;
  source: { dataset: "formasaurus"; page: string };
  observation: LoginObservation;
  expected: ExpectedResult;
};

/**
 * One public Japanese login page observed with no account signed in, on the date and at
 * the commit `source` records. `slots` names the vault item the case sends: `login` for a
 * username and a password, `bank` for branch and account number custom fields and a
 * password.
 */
export type JapanesePageCase = {
  id: string;
  source: { dataset: "japanese"; url: string; observed: string; commit: string };
  slots: "login" | "bank";
  observation: LoginObservation;
  expected: ExpectedResult;
};

/**
 * The slots the extension sends for a vault item with a username and a password, the
 * common case; built-in slots carry no field name or value shape.
 */
export const realPageSlots = [builtInLoginSlots.username, builtInLoginSlots.password];

/**
 * A bank item with branch and account number custom fields. The field names and the
 * synthetic values only set the name and value shape the trusted side would send.
 */
export const bankPageSlots: SemanticSlot[] = [
  customField(slots.branch, "支店番号", "123"),
  customField(slots.account, "口座番号", "1234567"),
  builtInLoginSlots.password,
];

/** Real pages from Formasaurus, scored with the same roles and judge as the synthetic corpus. */
export const realPageCorpus: EvaluationCase[] = (
  formasaurus.cases as unknown as RealPageCase[]
).map((entry) => ({
  id: entry.id,
  locale: entry.observation.language,
  summary: `Formasaurus ${entry.source.page}`,
  observation: entry.observation,
  slots: realPageSlots,
  expected: entry.expected,
}));

/** Public Japanese login pages, scored the same way. */
export const japanesePageCorpus: EvaluationCase[] = (
  japanese.cases as unknown as JapanesePageCase[]
).map((entry) => ({
  id: entry.id,
  locale: entry.observation.language,
  summary: entry.source.url,
  observation: entry.observation,
  slots: entry.slots === "bank" ? bankPageSlots : realPageSlots,
  expected: entry.expected,
}));
