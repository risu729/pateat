import { loginObservationSchema, semanticSlotsSchema } from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { validateGeneratedPage } from "../plan";
import { evaluationCorpus, expectedAlternatives, expectedFields } from "./cases";

describe("synthetic corpus", () => {
  it("parses, covers both languages and has consistent ground truth", () => {
    expect(new Set(evaluationCorpus.map((entry) => entry.id)).size).toBe(evaluationCorpus.length);
    const pages = evaluationCorpus.map(
      (entry) => `${entry.observation.origin}${entry.observation.path}`,
    );
    expect(new Set(pages).size).toBe(pages.length);
    expect(new Set(evaluationCorpus.map((entry) => entry.locale))).toEqual(
      new Set(["ja", "en", "mixed"]),
    );
    expect(
      evaluationCorpus.filter((entry) => entry.expected.kind === "abstain").length,
    ).toBeGreaterThan(1);
    for (const entry of evaluationCorpus) {
      const observation = v.parse(loginObservationSchema, entry.observation);
      const slots = v.parse(semanticSlotsSchema, entry.slots);
      if (entry.expected.kind === "abstain") continue;
      const result = validateGeneratedPage(observation, slots, {
        fields: expectedFields(entry.expected),
        action: { candidate: entry.expected.action, purpose: entry.expected.purpose },
        alternatives: expectedAlternatives(entry.expected),
      });
      expect(result.ok, entry.id).toBe(true);
      // Without alternatives, the purpose read from the page matches the ground truth
      // whatever the model answers (#834).
      if (!expectedAlternatives(entry.expected)?.length)
        for (const answered of ["advance", "submit"] as const) {
          const read = validateGeneratedPage(observation, slots, {
            fields: expectedFields(entry.expected),
            action: { candidate: entry.expected.action, purpose: answered },
          });
          expect(read.ok && read.plan.action.purpose, entry.id).toBe(entry.expected.purpose);
        }
      expect(result.ok && (result.plan.alternatives ?? []).length, entry.id).toBe(
        entry.expected.alternatives?.length ?? 0,
      );
    }
  });

  it("has a page with two identifier sets for one sign-in (ADR 0027)", () => {
    expect(
      evaluationCorpus
        .filter((entry) => entry.expected.kind === "plan" && entry.expected.alternatives?.length)
        .map((entry) => entry.id),
    ).toEqual(["ja-bank-two-identifier-sets"]);
  });
});
