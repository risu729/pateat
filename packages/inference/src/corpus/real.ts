import {
  builtInLoginSlots,
  customFieldSlotDescriptions,
  type LoginObservation,
  type SemanticSlot,
} from "@pateat/contracts";
import { customField, type EvaluationCase, type ExpectedResult } from "./cases";
import formasaurus from "./formasaurus.json";
import japanese from "./japanese.json";
import { slots } from "./slots";
import web from "./web.json";

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
 * A vault item's field: a built-in username or password, or a custom field by name. A
 * Text field gives a synthetic value only for its name and value shape; a Hidden or
 * secret one gives none.
 */
export type PageSlot =
  | "username"
  | "password"
  | { name: string; value: string }
  | { name: string; kind: "secret" | "hidden" };

/**
 * One public login page observed with no account signed in, on the date and at the
 * commit `source` records. `slots` names the vault item the case sends: `login` for a
 * username and a password, `bank` for branch and account number custom fields and a
 * password, or the item's own fields for a page that asks for others.
 */
export type LivePageCase<Dataset extends string> = {
  id: string;
  source: { dataset: Dataset; url: string; observed: string; commit: string };
  slots: "login" | "bank" | PageSlot[];
  observation: LoginObservation;
  expected: ExpectedResult;
};

/** A public login page shown in Japanese, or in Japanese and English. */
export type JapanesePageCase = LivePageCase<"japanese">;

/** A public login page shown in English, observed the same way. */
export type WebPageCase = LivePageCase<"web">;

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

/**
 * The slots a live page case sends, as the extension orders them: the built-in slots
 * first, then the custom fields as `custom-1` and on, in the listed order.
 */
export const livePageSlots = (slotSet: LivePageCase<string>["slots"]): SemanticSlot[] => {
  if (slotSet === "login") return realPageSlots;
  if (slotSet === "bank") return bankPageSlots;
  const builtIn = (["username", "password"] as const).filter((slot) => slotSet.includes(slot));
  const custom = slotSet.filter((entry) => typeof entry !== "string");
  return [
    ...builtIn.map((slot) => builtInLoginSlots[slot]),
    ...custom.map((entry, index): SemanticSlot => {
      const id = `custom-${index + 1}`;
      if ("value" in entry) {
        return customField(
          { id, kind: "identifier", description: customFieldSlotDescriptions.identifier },
          entry.name,
          entry.value,
        );
      }
      return {
        id,
        kind: entry.kind,
        description: customFieldSlotDescriptions[entry.kind],
        fieldName: entry.name,
      };
    }),
  ];
};

const livePageCorpus = (cases: LivePageCase<string>[]): EvaluationCase[] =>
  cases.map((entry) => ({
    id: entry.id,
    locale: entry.observation.language,
    summary: entry.source.url,
    observation: entry.observation,
    slots: livePageSlots(entry.slots),
    expected: entry.expected,
  }));

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
export const japanesePageCorpus = livePageCorpus(japanese.cases as unknown as JapanesePageCase[]);

/** Public English login pages, scored the same way. */
export const webPageCorpus = livePageCorpus(web.cases as unknown as WebPageCase[]);
