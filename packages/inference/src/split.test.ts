import {
  builtInLoginSlots,
  loginObservationSchema,
  type LoginObservation,
  type ObservedCandidate,
} from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { buildFieldQuestions, createFieldMappingDecider } from "./decision";
import { generationInstructions } from "./generation";
import { slotAcceptsOn, validateGeneratedPage, validatePagePlan } from "./plan";
import { decisionModel, distribution } from "./testing/fake-models";
import { checkPlanValues } from "./values";

// An identifier split over several inputs (ADR 0089): a synthetic page shaped like a bank's
// first login page that asks for a customer number in three boxes, and synthetic values.
const part = (at: number, maxLength: number): ObservedCandidate => ({
  id: `c${at}`,
  role: "text",
  target: { by: "name", value: `customerNumber${at}` },
  ...(at === 1 ? { label: "以下の欄に、お客さま番号を入力してください。" } : {}),
  placeholder: `半角数字${maxLength}桁`,
  maxLength,
  group: "f1",
  split: { group: "s1", part: at, of: 3 },
});
const observation: LoginObservation = v.parse(loginObservationSchema, {
  version: 1,
  origin: "https://bank.example.test",
  path: "/login",
  language: "ja",
  complete: true,
  candidates: [
    part(1, 4),
    part(2, 4),
    part(3, 5),
    {
      id: "c4",
      role: "checkbox",
      target: { by: "name", value: "save" },
      label: "お客さま番号を保存する",
      group: "f1",
    },
    {
      id: "c5",
      role: "button",
      target: { by: "name", value: "next" },
      label: "ログインパスワードを入力してログイン",
      group: "f1",
    },
    {
      id: "c6",
      role: "button",
      target: { by: "name", value: "app" },
      label: "アプリでログイン",
      group: "f1",
    },
  ],
});
const slots = [
  {
    ...builtInLoginSlots.username,
    valueShape: {
      length: 15,
      classes: ["ascii-digit" as const, "ascii-symbol" as const],
      email: false,
    },
  },
];
const plan = (candidate: string, action = "c5") => ({
  fields: [{ slot: "username", candidate }],
  action: { candidate: action, purpose: "advance" as const },
});

describe("a split identifier's plan", () => {
  it("fills the first input with the parts' lengths and advances", () => {
    const validated = validatePagePlan(observation, slots, plan("c1"));
    expect(validated.ok && validated.plan.steps).toEqual([
      {
        kind: "fill",
        path: "/login",
        effect: "prepare",
        fields: [
          {
            slot: "username",
            target: { by: "name", value: "customerNumber1" },
            split: [4, 4, 5],
          },
        ],
      },
      { kind: "click", path: "/login", target: { by: "name", value: "next" }, purpose: "advance" },
    ]);
  });

  it("refuses an identifier in any other part, and any other slot in the group", () => {
    for (const candidate of ["c2", "c3"])
      expect(validatePagePlan(observation, slots, plan(candidate))).toEqual({
        ok: false,
        reason: "incompatible-role",
      });
    const hidden = { id: "pin", kind: "hidden", description: "PIN" } as const;
    expect(slotAcceptsOn(observation, "identifier", observation.candidates[0]!)).toBe(true);
    expect(slotAcceptsOn(observation, "identifier", observation.candidates[1]!)).toBe(false);
    expect(
      validatePagePlan(observation, [hidden], {
        fields: [{ slot: "pin", candidate: "c1" }],
        action: { candidate: "c5", purpose: "advance" },
      }),
    ).toEqual({ ok: false, reason: "incompatible-role" });
  });

  it("presses Enter in the last part when the form shows no button to press", () => {
    const buttonless: LoginObservation = {
      ...observation,
      candidates: observation.candidates.slice(0, 3),
    };
    for (const action of ["c1", "c3"]) {
      const validated = validateGeneratedPage(buttonless, slots, plan("c1", action));
      expect(validated.ok && validated.plan.steps[1]).toEqual({
        kind: "click",
        path: "/login",
        target: { by: "name", value: "customerNumber3" },
        purpose: "advance",
        press: "enter",
      });
    }
    expect(validatePagePlan(buttonless, slots, plan("c1", "c2")).ok).toBe(false);
  });

  it("checks the value against the parts together", () => {
    const values = (username: string) => new Map([["username", username]]);
    const fields = plan("c1").fields;
    expect(checkPlanValues(observation, { fields }, values("1234-5678-12345"))).toEqual({
      ok: true,
    });
    expect(checkPlanValues(observation, { fields }, values("1234567812"))).toEqual({ ok: true });
    expect(checkPlanValues(observation, { fields }, values("1234-5678-123456"))).toEqual({
      ok: false,
      slot: "username",
      reason: "too-long",
    });
    expect(checkPlanValues(observation, { fields }, values("1234-5678"))).toEqual({
      ok: false,
      slot: "username",
      reason: "too-short",
    });
  });

  it("asks Claude to map the slot to the first part", () => {
    expect(generationInstructions).toContain("map its slot to part 1 alone");
  });
});

describe("a split identifier's finite-choice questions", () => {
  it("shows the first input with the parts' total length and asks nothing of the others", () => {
    const built = buildFieldQuestions(observation, slots)!;
    expect(Object.keys(built.form).filter((id) => id.startsWith("el:"))).toEqual(["el:c1"]);
    const element = (built.form["el:c1"]!.instructions as { element: Record<string, unknown> })
      .element;
    expect(element).toMatchObject({ id: "c1", maxLength: 13 });
    expect(element["split"]).toContain("first of 3 inputs");
    expect(element).not.toHaveProperty("minLength");
    const question = built.form["slot:username"] as { criteria: object };
    expect(Object.keys(question.criteria)).toEqual(["c:c1", "none"]);
    expect(built.state.elements.find((entry) => entry.id === "c2")).toMatchObject({
      maxLength: 4,
      split: "part 2 of 3 of one value",
    });
  });

  it("answers the first input's plan when the model maps the number there", async () => {
    const model = decisionModel(async (options) => {
      const choices: Record<string, string> = {
        "el:c1": "s:username",
        "slot:username": "c:c1",
        action: "c:c5",
      };
      const answers = Object.fromEntries(
        Object.entries(options.questions).map(([id, question]) => [
          id,
          question.type === "boolean"
            ? { type: "boolean" as const, probability: id === "signin" ? 0.95 : 0.05 }
            : {
                type: "choice" as const,
                choice: choices[id] ?? "none",
                probabilities: distribution(
                  Object.keys((question as { criteria: object }).criteria),
                  choices[id] ?? "none",
                  0.9,
                ),
              },
        ]),
      );
      return { answers, usage: { inputTokens: 200 }, warnings: [] };
    });
    const decide = createFieldMappingDecider({
      model,
      limits: { timeoutMs: 1_000, maxInputBytes: 16_384 },
      minProbability: 0.7,
    });
    const outcome = await decide({ observation, slots });
    expect(outcome.status).toBe("ok");
    expect(outcome.status === "ok" && outcome.value.steps[0]).toMatchObject({
      fields: [{ slot: "username", split: [4, 4, 5] }],
    });
  });
});
