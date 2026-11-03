import { describe, expect, it } from "vitest";
import { clefCanAnswer, clefLimits, runClefBenchmark } from "./bench-clef";
import { evaluationCorpus } from "./corpus/cases";
import { logPageCorpus } from "./corpus/log";
import { fakeClef } from "./testing/fake-clef";

const accountId = "0123456789abcdef0123456789abcdef";
const run = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  runClefBenchmark({
    accountId,
    apiToken: "synthetic-cloudflare-token",
    modelId: "clef-flash",
    maxCostUsd: 1,
    fetch,
    ...extra,
  });

describe("Clef benchmark runner", () => {
  it("scores the corpus, keeps every answer and estimates spend from usage", async () => {
    const clef = fakeClef();
    const result = await run(clef.fetch);
    expect(result.report.total).toBe(evaluationCorpus.length);
    expect(result.report.falseSubmits).toBe(0);
    expect(result.servedModels).toEqual(["clef-flash"]);
    const asked = Object.keys(result.answers);
    expect(asked).toHaveLength(clef.sent.length);
    const first = result.answers[asked[0]!]!;
    // Answers stay under the role's own question IDs, with every probability.
    expect(Object.keys(first)).toContain("action");
    expect(first["action"]).toMatchObject({ type: "choice" });
    expect(result.estimatedCostUsd).toBeCloseTo((clef.sent.length * 1_000 * 0.038) / 1_000_000);
  });

  it("stops before a call that could exceed the cap", async () => {
    const worst = (clefLimits("clef-flash").maxInputBytes * 0.038) / 1_000_000;
    const result = await run(fakeClef().fetch, { maxCostUsd: worst * 1.5 });
    expect(result.report.stoppedBefore).toBeDefined();
    expect(result.report.total).toBeGreaterThan(0);
  });

  it("reverses each question's options when asked", async () => {
    const clef = fakeClef();
    await run(clef.fetch, { reverseOptions: true, cases: evaluationCorpus.slice(0, 1) });
    const criteria = Object.keys(clef.sent[0]!.body["questions"]["action"].criteria);
    expect(criteria[0]).toBe("none");
  });

  it("keeps the input below each model's context", () => {
    expect(clefLimits("clef-flash").maxInputBytes).toBeLessThan(24_576);
    expect(clefLimits("clef").maxInputBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("marks lists, entries, passkey-only pages and requests without slots as beyond Clef's questions", () => {
    for (const testCase of logPageCorpus) {
      const { kind } = testCase.expected;
      const beyond =
        kind === "account-list" ||
        kind === "entry" ||
        testCase.slots.length === 0 ||
        testCase.request?.entry === true ||
        testCase.request?.passkeyOnly === true;
      expect(clefCanAnswer(testCase)).toBe(!beyond);
    }
  });
});
