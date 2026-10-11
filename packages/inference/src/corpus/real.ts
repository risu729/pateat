import { builtInLoginSlots, type LoginObservation } from "@pateat/contracts";
import type { EvaluationCase, ExpectedResult } from "./cases";
import formasaurus from "./formasaurus.json";

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
 * The slots the extension sends for a vault item with a username and a password, the
 * common case; built-in slots carry no field name or value shape.
 */
export const realPageSlots = [builtInLoginSlots.username, builtInLoginSlots.password];

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
