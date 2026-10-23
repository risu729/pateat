import {
  builtInLoginSlots,
  customFieldSlotDescriptions,
  loginObservationSchema,
  semanticSlotsSchema,
  type LoginObservation,
} from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { validateGeneratedPage, validatePagePlan } from "../plan";
import { expectedFields, type EvaluationCase } from "./cases";
import formasaurus from "./formasaurus.json";
import japanese from "./japanese.json";
import { valueShapeOf } from "../values";
import {
  japanesePageCorpus,
  livePageSlots,
  realPageCorpus,
  webPageCorpus,
  type JapanesePageCase,
  type LivePageCase,
  type WebPageCase,
} from "./real";
import web from "./web.json";

const expectCompleteWithValidTruth = (corpus: EvaluationCase[]) => {
  expect(new Set(corpus.map((entry) => entry.id)).size).toBe(corpus.length);
  for (const entry of corpus) {
    // Inference rejects an incomplete observation before any call, so none is scored.
    const observation = v.parse(loginObservationSchema, entry.observation);
    expect(observation.complete, entry.id).toBe(true);
    const slots = v.parse(semanticSlotsSchema, entry.slots);
    if (entry.expected.kind === "abstain") continue;
    const result = validatePagePlan(observation, slots, {
      fields: expectedFields(entry.expected),
      action: { candidate: entry.expected.action, purpose: entry.expected.purpose },
    });
    expect(result.ok, entry.id).toBe(true);
    // The purpose read from the page matches the ground truth whatever the model answers
    // (#834), and a passkey button in the truth passes the generated plan's own check (ADR
    // 0027).
    for (const answered of ["advance", "submit"] as const) {
      const generated = validateGeneratedPage(observation, slots, {
        fields: expectedFields(entry.expected),
        action: { candidate: entry.expected.action, purpose: answered },
        passkeyButton: entry.expected.passkeyButton,
      });
      expect(generated.ok && generated.plan.action.purpose, entry.id).toBe(entry.expected.purpose);
      expect(generated.ok && generated.plan.passkeyButton, entry.id).toBe(
        entry.expected.passkeyButton,
      );
    }
  }
};

describe("real-page corpus", () => {
  it("records its source and holds complete observations with valid ground truth", () => {
    expect(formasaurus.source.repository).toBe("https://github.com/scrapinghub/Formasaurus");
    expect(formasaurus.source.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(realPageCorpus.some((entry) => entry.expected.kind === "abstain")).toBe(true);
    expectCompleteWithValidTruth(realPageCorpus);
  });
});

const expectSourced = (
  cases: LivePageCase<string>[],
  dataset: string,
  languages: LoginObservation["language"][],
) => {
  for (const entry of cases) {
    expect(entry.source.dataset, entry.id).toBe(dataset);
    expect(entry.source.observed, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(entry.source.commit, entry.id).toMatch(/^[0-9a-f]{7,40}$/u);
    expect(entry.source.url, entry.id).toBe(`${entry.observation.origin}${entry.observation.path}`);
    expect(languages, entry.id).toContain(entry.observation.language);
    if (typeof entry.slots === "string") expect(["login", "bank"], entry.id).toContain(entry.slots);
  }
};

describe("live page slots", () => {
  it("sends an item's own fields in order, numbering its custom fields from custom-1", () => {
    expect(
      livePageSlots([
        { name: "Account ID", value: "123456789012" },
        "username",
        { name: "Security number", kind: "hidden" },
        "password",
      ]),
    ).toEqual([
      {
        id: "custom-1",
        kind: "identifier",
        description: customFieldSlotDescriptions.identifier,
        fieldName: "Account ID",
        valueShape: valueShapeOf({ source: "text", value: "123456789012" }),
      },
      builtInLoginSlots.username,
      {
        id: "custom-2",
        kind: "hidden",
        description: customFieldSlotDescriptions.hidden,
        fieldName: "Security number",
      },
      builtInLoginSlots.password,
    ]);
  });
});

describe("Japanese page corpus", () => {
  it("names each page by its observed origin and path, with no query, its slot set and when it was observed", () => {
    expectSourced(japanese.cases as unknown as JapanesePageCase[], "japanese", ["ja", "mixed"]);
  });

  it("holds complete observations with valid ground truth", () => {
    expectCompleteWithValidTruth(japanesePageCorpus);
  });

  it("expects MyJCB's passkey sign-in button, observed as #passkeyLoginButtonAD", () => {
    const myjcb = japanesePageCorpus.find((entry) => entry.id === "ja-myjcb")!;
    const button = myjcb.observation.candidates.find(
      (candidate) => candidate.target.value === "passkeyLoginButtonAD",
    );
    expect(button).toBeDefined();
    expect(myjcb.expected).toMatchObject({ kind: "plan", passkeyButton: button!.id });
  });
});

describe("English page corpus", () => {
  it("names each page by its observed origin and path, with no query, its slot set and when it was observed", () => {
    expectSourced(web.cases as unknown as WebPageCase[], "web", ["en"]);
  });

  it("holds complete observations with valid ground truth, apart from the Japanese pages", () => {
    expectCompleteWithValidTruth(webPageCorpus);
    const japaneseIds = new Set(japanesePageCorpus.map((entry) => entry.id));
    expect(webPageCorpus.filter((entry) => japaneseIds.has(entry.id))).toEqual([]);
  });
});
