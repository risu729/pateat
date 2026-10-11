import { describe, expect, it } from "vitest";
import { runHeuristicBenchmark } from "./bench";
import { evaluationCorpus } from "./corpus/cases";
import { realPageCorpus } from "./corpus/real";
import { heuristicPlan } from "./heuristic";

const byId = (id: string) => evaluationCorpus.find((entry) => entry.id === id)!;

describe("heuristic comparator", () => {
  it("maps a plain login form without a model call", () => {
    const entry = byId("en-basic");
    const outcome = heuristicPlan(entry.observation, entry.slots);
    expect(outcome).toMatchObject({ status: "ok", calls: 0 });
    expect(outcome.status === "ok" && outcome.value.action).toEqual({
      candidate: "sign-in",
      purpose: "submit",
    });
  });

  it("advances an identifier marked username and abstains without a sign-in form", () => {
    const first = byId("en-identifier-first");
    expect(heuristicPlan(first.observation, first.slots)).toMatchObject({
      status: "ok",
      value: { action: { candidate: "next", purpose: "advance" } },
    });
    const newsletter = byId("en-newsletter-only");
    expect(heuristicPlan(newsletter.observation, newsletter.slots)).toMatchObject({
      status: "abstained",
      reason: "no-login-form",
    });
  });

  it("reports each case's plan in candidate IDs", async () => {
    const report = await runHeuristicBenchmark(realPageCorpus.slice(0, 5));
    expect(report.total).toBe(5);
    expect(report.calls).toBe(0);
    for (const result of report.cases)
      expect(result.plan === undefined).toBe(result.status !== "ok");
  });
});
