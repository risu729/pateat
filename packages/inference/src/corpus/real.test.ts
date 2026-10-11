import { loginObservationSchema, semanticSlotsSchema } from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { validatePagePlan } from "../plan";
import formasaurus from "./formasaurus.json";
import { realPageCorpus } from "./real";

describe("real-page corpus", () => {
  it("records its source and holds complete observations with valid ground truth", () => {
    expect(formasaurus.source.repository).toBe("https://github.com/scrapinghub/Formasaurus");
    expect(formasaurus.source.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(new Set(realPageCorpus.map((entry) => entry.id)).size).toBe(realPageCorpus.length);
    expect(realPageCorpus.some((entry) => entry.expected.kind === "abstain")).toBe(true);
    for (const entry of realPageCorpus) {
      // Inference rejects an incomplete observation before any call, so none is scored.
      const observation = v.parse(loginObservationSchema, entry.observation);
      expect(observation.complete, entry.id).toBe(true);
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
