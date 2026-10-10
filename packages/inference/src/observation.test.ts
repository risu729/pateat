import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "./corpus/cases";
import { loginObservationSchema, semanticSlotsSchema } from "./observation";
import { validatePagePlan } from "./plan";

const base = evaluationCorpus[0]!.observation;
const parse = (value: unknown) => v.safeParse(loginObservationSchema, value).success;

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

describe("observation contract", () => {
  it("rejects values, oversized or control-character text and unsafe structure", () => {
    expect(parse(base)).toBe(true);
    const candidate = base.candidates[0]!;
    expect(parse({ ...base, candidates: [{ ...candidate, value: "synthetic" }] })).toBe(false);
    expect(parse({ ...base, candidates: [{ ...candidate, label: "x".repeat(121) }] })).toBe(false);
    expect(parse({ ...base, candidates: [{ ...candidate, label: "a\u0000b" }] })).toBe(false);
    expect(
      parse({
        ...base,
        candidates: [candidate, { ...candidate, target: { by: "id", value: "other" } }],
      }),
    ).toBe(false);
    expect(parse({ ...base, candidates: [candidate, { ...candidate, id: "other" }] })).toBe(false);
    expect(parse({ ...base, path: "/login?next=/" })).toBe(false);
    expect(parse({ ...base, origin: "https://shop.example.test/login" })).toBe(false);
    expect(parse({ ...base, html: "<form></form>" })).toBe(false);
    expect(
      parse({
        ...base,
        candidates: Array.from({ length: 49 }, (_, index) => ({
          ...candidate,
          id: `c${index}`,
          target: { by: "id", value: `c${index}` },
        })),
      }),
    ).toBe(false);
  });

  it("rejects duplicate or unbounded slots", () => {
    const slot = { id: "password", kind: "secret", description: "account password" };
    expect(v.safeParse(semanticSlotsSchema, [slot]).success).toBe(true);
    expect(v.safeParse(semanticSlotsSchema, [slot, slot]).success).toBe(false);
    expect(v.safeParse(semanticSlotsSchema, []).success).toBe(false);
    expect(v.safeParse(semanticSlotsSchema, [{ ...slot, kind: "cookie" }]).success).toBe(false);
  });
});
