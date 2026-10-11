import { loginObservationSchema, semanticSlotsSchema } from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { validatePagePlan } from "../plan";
import { evaluationCorpus } from "./cases";

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
      const result = validatePagePlan(observation, slots, {
        fields: Object.entries(entry.expected.fields).map(([slot, candidate]) => ({
          slot,
          candidate,
        })),
        action: { candidate: entry.expected.action, purpose: entry.expected.purpose },
      });
      expect(result.ok, entry.id).toBe(true);
    }
  });
});
