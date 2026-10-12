import { builtInLoginSlots, type ObservedCandidate } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { runHeuristicBenchmark } from "./bench";
import { evaluationCorpus } from "./corpus/cases";
import { realPageCorpus } from "./corpus/real";
import { heuristicPlan } from "./heuristic";

const byId = (id: string) => evaluationCorpus.find((entry) => entry.id === id)!;
const slots = [builtInLoginSlots.username, builtInLoginSlots.password];
const field = (
  id: string,
  role: ObservedCandidate["role"],
  extra: Partial<ObservedCandidate> = {},
): ObservedCandidate => ({ id, role, target: { by: "id", value: id }, ...extra });
const observe = (candidates: ObservedCandidate[], complete = true) => ({
  ...byId("en-basic").observation,
  complete,
  candidates,
});

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

  it("fails an incomplete observation before mapping, as generation does", () => {
    const observation = observe([field("u", "text"), field("p", "password"), field("b", "button")]);
    expect(heuristicPlan({ ...observation, complete: false }, slots)).toMatchObject({
      status: "failed",
      error: "incomplete-observation",
      calls: 0,
    });
  });

  it("abstains on two sign-in forms and on a form without a button", () => {
    const form = (group: string) => [
      field(`${group}-u`, "text", { group }),
      field(`${group}-p`, "password", { group }),
      field(`${group}-b`, "button", { group }),
    ];
    expect(heuristicPlan(observe([...form("a"), ...form("b")]), slots)).toMatchObject({
      status: "abstained",
      reason: "ambiguous",
    });
    expect(
      heuristicPlan(observe([field("u", "text"), field("p", "password")]), slots),
    ).toMatchObject({ status: "abstained", reason: "no-action" });
  });

  it("skips a code field for the identifier and falls back to the form's first button", () => {
    const outcome = heuristicPlan(
      observe([
        field("b", "button"),
        field("u", "text"),
        field("code", "text", { autocomplete: "one-time-code" }),
        field("p", "password"),
      ]),
      slots,
    );
    expect(outcome.status === "ok" && outcome.value.fields).toEqual([
      { slot: "username", candidate: "u" },
      { slot: "password", candidate: "p" },
    ]);
    expect(outcome.status === "ok" && outcome.value.action.candidate).toBe("b");
  });

  it("advances only a form whose one fill field is the marked identifier", () => {
    const email = field("e", "email", { autocomplete: "email" });
    expect(
      heuristicPlan(observe([field("name", "text"), email, field("b", "button")]), slots),
    ).toMatchObject({ status: "abstained", reason: "no-login-form" });
    expect(heuristicPlan(observe([email, field("b", "button")]), slots)).toMatchObject({
      status: "ok",
      value: { action: { candidate: "b", purpose: "advance" } },
    });
  });

  it("reports each case's plan in candidate IDs", async () => {
    const cases = realPageCorpus.slice(0, 5);
    const report = await runHeuristicBenchmark(cases);
    expect(report.total).toBe(5);
    expect(report.calls).toBe(0);
    expect(report.cases.map((result) => result.verdict)).toContain("correct");
    for (const result of report.cases) {
      expect(result.plan === undefined).toBe(result.status !== "ok");
      const expected = cases.find((entry) => entry.id === result.id)!.expected;
      if (result.verdict === "correct" && expected.kind === "plan")
        expect(result.plan).toEqual({
          fields: expected.fields,
          action: expected.action,
          purpose: expected.purpose,
        });
    }
  });
});
