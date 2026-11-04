import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "./corpus/cases";
import { slots } from "./corpus/slots";
import { buildFieldQuestions, createFieldMappingDecider } from "./decision";
import { evaluateRole } from "./evaluate";
import type { LoginObservation, ObservedCandidate } from "@pateat/contracts";
import { decisionModel, distribution, oracleDecider } from "./testing/fake-models";

const page = evaluationCorpus[0]!;
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const request = { observation: page.observation, slots: page.slots };
type Answers = Awaited<ReturnType<Parameters<typeof decisionModel>[0]>>["answers"];

/** Sure yes/no answers of a sign-in page that needs no generation. */
const signIn: Record<string, number> = {
  signin: 0.95,
  confirm: 0.05,
  irreversible: 0.05,
  otherSets: 0.05,
};

/**
 * Answers each choice with the given option (or none) and a complete distribution, and
 * each yes/no question with `yes` or the sign-in defaults.
 */
const answering = (
  choices: Record<string, string>,
  confidence = 0.9,
  extra: Partial<Answers> = {},
  yes: Record<string, number> = {},
) =>
  decisionModel(async (options) => {
    const answers: Answers = {};
    for (const [id, question] of Object.entries(options.questions)) {
      if (question.type === "boolean") {
        answers[id] = { type: "boolean", probability: yes[id] ?? signIn[id] ?? 0.05 };
        continue;
      }
      if (question.type !== "choice") throw new Error("unexpected");
      const choice = choices[id] ?? "none";
      answers[id] = {
        type: "choice",
        choice,
        probabilities: distribution(Object.keys(question.criteria), choice, confidence),
      };
    }
    const asked = Object.fromEntries(
      Object.entries(extra).filter(([id]) => Object.hasOwn(options.questions, id)),
    );
    return {
      answers: { ...answers, ...asked } as Answers,
      usage: { inputTokens: 200 },
      warnings: [],
    };
  });
const decider = (model: ReturnType<typeof decisionModel>, minProbability = 0.7) =>
  createFieldMappingDecider({ model, limits, minProbability });
const correct = {
  "el:email": "s:email",
  "el:password": "s:password",
  "slot:email": "c:email",
  "slot:password": "c:password",
  action: "c:sign-in",
};
const button = (id: string, label: string): ObservedCandidate => ({
  id,
  role: "button",
  target: { by: "id", value: id },
  label,
});
type Built = NonNullable<ReturnType<typeof buildFieldQuestions>>;
type Choice = Extract<Built["form"][string], { type: "choice" }>;
/** The questions of a page that has a form, with every question read as a choice. */
const questionsOf = (observation: LoginObservation, pageSlots = page.slots) => {
  const built = buildFieldQuestions(observation, pageSlots);
  if (built === undefined) throw new Error("expected questions");
  return built as Built & { form: Record<string, Choice>; page: Record<string, Choice> };
};

describe("finite-choice decision role", () => {
  it("scores the oracle fake as fully correct on the corpus and leaves other sets to generation", async () => {
    const decide = decider(oracleDecider());
    const sets = (entry: (typeof evaluationCorpus)[number]) =>
      entry.expected.kind === "plan" && entry.expected.alternatives !== undefined;
    // Pages with custom-field slots too, which are named from the page (ADR 0027).
    const report = await evaluateRole({
      cases: evaluationCorpus.filter((entry) => !sets(entry)),
      run: (entry) => decide({ observation: entry.observation, slots: entry.slots }),
    });
    expect(report.semanticAccuracy).toBe(1);
    expect(report.falseSubmits).toBe(0);
    const withSets = evaluationCorpus.filter(sets);
    expect(withSets.length).toBeGreaterThan(0);
    const outcomes = await Promise.all(
      withSets.map((entry) => decide({ observation: entry.observation, slots: entry.slots })),
    );
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ status: "abstained", reason: "ambiguous" });
  });

  it("asks each element and each slot with role-compatible options, and always offers none", () => {
    const { form, page: pageQuestions } = questionsOf(page.observation);
    expect(Object.keys(form)).toEqual([
      "el:email",
      "el:password",
      "slot:email",
      "slot:password",
      "action",
      "signin",
    ]);
    expect(Object.keys(form["el:email"]!.criteria)).toEqual(["s:email", "none"]);
    expect(Object.keys(form["slot:password"]!.criteria)).toEqual(["c:password", "none"]);
    // Links stay context for the action: the executor clicks buttons only.
    expect(Object.keys(form["action"]!.criteria)).toEqual(["c:sign-in", "enter", "none"]);
    expect((form["signin"] as { type: string }).type).toBe("boolean");
    // No button names a passkey; the account switch may be a link.
    expect(Object.keys(pageQuestions)).toEqual(["switch", "confirm", "irreversible", "otherSets"]);
    expect(Object.keys(pageQuestions["switch"]!.criteria)).toEqual([
      "c:sign-in",
      "c:forgot",
      "c:register",
      "none",
    ]);
  });

  it("offers a passkey question only among buttons that sign in with a passkey", () => {
    const withPasskey: LoginObservation = {
      ...page.observation,
      candidates: [
        ...page.observation.candidates,
        button("passkey", "Sign in with a passkey"),
        button("add-passkey", "Create a passkey"),
      ],
    };
    expect(Object.keys(questionsOf(withPasskey).page["passkey"]!.criteria)).toEqual([
      "c:passkey",
      "none",
    ]);
  });

  it("offers a sign-in form's lone new-password field for the password (ADR 0018)", () => {
    const lone: LoginObservation = {
      ...page.observation,
      candidates: page.observation.candidates.map((candidate) =>
        candidate.role === "password" ? { ...candidate, autocomplete: "new-password" } : candidate,
      ),
    };
    expect(Object.keys(questionsOf(lone).form["slot:password"]!.criteria)).toEqual([
      "c:password",
      "none",
    ]);
  });

  it("offers field names, value shapes and input constraints but never values", async () => {
    const bank = evaluationCorpus.find((item) => item.id === "ja-bank-unlabeled-lengths")!;
    const { form, state } = questionsOf(bank.observation, bank.slots);
    expect(form["slot:custom-1"]!.criteria["c:field-b"]).toEqual({
      role: "tel",
      maxLength: 3,
      inputMode: "numeric",
    });
    expect(state.elements).toContainEqual({
      id: "field-b",
      role: "tel",
      maxLength: 3,
      inputMode: "numeric",
    });
    const model = oracleDecider();
    const outcome = await decider(model)({ observation: bank.observation, slots: bank.slots });
    // The custom-field slots are named from the page, never by the model (ADR 0027).
    expect(outcome.status).toBe("ok");
    const sent = JSON.stringify(model.calls);
    expect(sent).toContain("支店番号");
    expect(sent).toContain('"valueShape":{"length":3,"classes":["ascii-digit"],"email":false}');
    expect(sent).toContain("its value has 3 characters of ascii-digit and is not an email address");
    for (const value of Object.values(bank.values!)) expect(sent).not.toContain(value);
    // Locators never leave the device.
    expect(sent).not.toContain('"target"');
  });

  it("returns a checked generated page and derives the submit purpose locally", async () => {
    const model = answering(correct);
    const outcome = await decider(model)(request);
    expect(outcome).toMatchObject({
      status: "ok",
      calls: 2,
      usage: { inputTokens: 400, outputTokens: null },
      value: {
        action: { candidate: "sign-in", purpose: "submit" },
        pageKind: "sign-in",
        irreversible: "no",
      },
      answer: {
        "el:email": { choice: "s:email", probability: 0.9 },
        signin: { probability: 0.95 },
      },
    });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]!.state).toEqual(model.calls[1]!.state);
    expect(model.calls[0]!.state).toMatchObject([
      {
        type: "json",
        value: {
          page: {
            origin: page.observation.origin,
            path: "/login",
            language: "en",
            title: "Sign in",
          },
          slots: page.slots,
        },
      },
    ]);
  });

  it("submits by pressing Enter in the last field when no listed button does", async () => {
    // Only a field inside a form submits it (ADR 0064).
    const grouped = page.observation.candidates.map((candidate) => ({ ...candidate, group: "f1" }));
    const outcome = await decider(answering({ ...correct, action: "enter" }))({
      ...request,
      observation: { ...page.observation, candidates: grouped },
    });
    expect(outcome).toMatchObject({
      status: "ok",
      value: { action: { candidate: "password", purpose: "submit" } },
    });
  });

  it("keeps a sure passkey button and account switch and leaves out unsure ones", async () => {
    const withPasskey: LoginObservation = {
      ...page.observation,
      candidates: [
        ...page.observation.candidates,
        button("passkey", "Sign in with a passkey"),
        button("other", "Use another account"),
      ],
    };
    const both = { ...correct, passkey: "c:passkey", switch: "c:other" };
    const sure = await decider(answering(both))({ ...request, observation: withPasskey });
    expect(sure).toMatchObject({
      status: "ok",
      value: { passkeyButton: "passkey", accountSwitch: "other" },
    });
    const unsure = await decider(
      answering(correct, 0.9, {
        passkey: {
          type: "choice",
          choice: "c:passkey",
          probabilities: { "c:passkey": 0.6, none: 0.4 },
        },
      }),
    )({ ...request, observation: withPasskey });
    expect(unsure.status).toBe("ok");
    if (unsure.status === "ok") expect(unsure.value.passkeyButton).toBeUndefined();
    // A later page keeps no passkey button (ADR 0027).
    const later = await decider(answering(both))({
      ...request,
      observation: withPasskey,
      startPage: false,
    });
    expect(later.status).toBe("ok");
    if (later.status === "ok") expect(later.value.passkeyButton).toBeUndefined();
  });

  it("answers whether submitting cannot be undone from the yes probability", async () => {
    const cases = [
      [0.9, "yes"],
      [0.5, "unclear"],
      [0.1, "no"],
    ] as const;
    const outcomes = await Promise.all(
      cases.map(([probability]) =>
        decider(answering(correct, 0.9, {}, { irreversible: probability }))(request),
      ),
    );
    outcomes.forEach((outcome, index) =>
      expect(outcome).toMatchObject({ status: "ok", value: { irreversible: cases[index]![1] } }),
    );
  });

  it("submits after an identifier alone when its form leaves a password input empty (#834)", async () => {
    const emailOnly = { "el:email": "s:email", "slot:email": "c:email", action: "c:sign-in" };
    const outcome = await decider(answering(emailOnly))(request);
    expect(outcome).toMatchObject({
      status: "ok",
      value: { action: { candidate: "sign-in", purpose: "submit" } },
    });
    const withoutPassword = {
      ...request,
      observation: {
        ...page.observation,
        candidates: page.observation.candidates.filter(
          (candidate) => candidate.role !== "password",
        ),
      },
    };
    expect(await decider(answering(emailOnly))(withoutPassword)).toMatchObject({
      status: "ok",
      value: { action: { candidate: "sign-in", purpose: "advance" } },
    });
  });

  it.each([
    ["an unknown option", { ...correct, action: "c:delete" }],
    ["a raw candidate ID without the option prefix", { ...correct, action: "sign-in" }],
  ])("rejects %s through the SDK contract", async (_name, choices) => {
    const model = decisionModel(async (options) => {
      const answers: Answers = {};
      for (const [id, question] of Object.entries(options.questions))
        answers[id] =
          question.type === "boolean"
            ? { type: "boolean", probability: signIn[id] ?? 0.05 }
            : { type: "choice", choice: choices[id as keyof typeof choices] ?? "none" };
      return { answers, warnings: [] };
    });
    expect(await decider(model)(request)).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });

  it.each([
    ["probabilities that do not sum to one", { "c:email": 0.9, none: 0.3 }],
    ["a probability outside [0, 1]", { "c:email": 1.2, none: -0.2 }],
    ["an incomplete distribution", { "c:email": 1 }],
    ["a choice that is not the most probable option", { "c:email": 0.2, none: 0.8 }],
  ])("rejects %s", async (_name, probabilities) => {
    const model = answering(correct, 0.9, {
      "slot:email": { type: "choice", choice: "c:email", probabilities },
    });
    expect(await decider(model)(request)).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });

  it("abstains on missing distributions, low confidence and absent actions", async () => {
    const missing = answering(correct, 0.9, {
      "slot:email": { type: "choice", choice: "c:email" },
    });
    expect(await decider(missing)(request)).toMatchObject({
      status: "abstained",
      reason: "missing-probabilities",
    });
    expect(await decider(answering(correct, 0.6))(request)).toMatchObject({
      status: "abstained",
      reason: "low-confidence",
    });
    expect(await decider(answering({ ...correct, action: "none" }))(request)).toMatchObject({
      status: "abstained",
      reason: "no-action",
    });
    expect(await decider(answering({ action: "c:sign-in" }))(request)).toMatchObject({
      status: "abstained",
      reason: "no-login-form",
    });
  });

  it.each([
    ["no sign-in form", { signin: 0.6 }, "no-login-form"],
    ["a signed-in user asked to confirm", { confirm: 0.3 }, "no-login-form"],
    ["other identifier sets", { otherSets: 0.5 }, "ambiguous"],
  ])("leaves %s to generation", async (_name, yes, reason) => {
    expect(await decider(answering(correct, 0.9, {}, yes))(request)).toMatchObject({
      status: "abstained",
      reason,
    });
  });

  it("abstains when the element and slot views disagree", async () => {
    const disagreeing = answering({ ...correct, "el:email": "none" });
    expect(await decider(disagreeing)(request)).toMatchObject({
      status: "abstained",
      reason: "inconsistent-mapping",
    });
  });

  it("abstains when two slots choose the same element", async () => {
    const both = {
      observation: page.observation,
      slots: [slots.username, slots.email, slots.password],
    };
    const model = answering({
      "el:email": "s:email",
      "el:password": "s:password",
      "slot:username": "c:email",
      "slot:email": "c:email",
      "slot:password": "c:password",
      action: "c:sign-in",
    });
    const outcome = await decider(model)(both);
    expect(outcome).toMatchObject({ status: "abstained", reason: "inconsistent-mapping" });
  });

  it("hides registration passwords and abstains on cross-form mappings", async () => {
    const signup = evaluationCorpus.find((entry) => entry.id === "ja-signup-adjacent")!;
    const { form } = questionsOf(signup.observation, signup.slots);
    expect(Object.keys(form["slot:password"]!.criteria)).toEqual(["c:login-pass", "none"]);
    const crossForm = answering({
      "el:reg-email": "s:email",
      "el:login-pass": "s:password",
      "slot:email": "c:reg-email",
      "slot:password": "c:login-pass",
      action: "c:login-submit",
    });
    expect(
      await decider(crossForm)({ observation: signup.observation, slots: signup.slots }),
    ).toMatchObject({ status: "abstained", reason: "inconsistent-mapping" });
  });

  it("maps refusal, rate limits and timeouts to explicit failures", async () => {
    const refusing = answering(correct, 0.9, { action: { type: "refusal" } as never });
    expect(await decider(refusing)(request)).toMatchObject({ status: "failed", error: "refused" });
    const limited = decisionModel(async () => {
      throw new APICallError({
        message: "rate limited",
        url: "https://fake.invalid",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
    });
    expect(await decider(limited)(request)).toMatchObject({
      status: "failed",
      error: "rate-limited",
      calls: 2,
    });
    const silent = decisionModel(() => new Promise(() => {}));
    const slow = createFieldMappingDecider({
      model: silent,
      limits: { ...limits, timeoutMs: 100 },
      minProbability: 0.7,
    });
    expect(await slow(request)).toMatchObject({ status: "failed", error: "timeout", calls: 2 });
  });

  it("leaves a page the device saw signed in to generation (ADR 0035)", async () => {
    const model = answering(correct);
    expect(await decider(model)({ ...request, signedIn: true })).toMatchObject({
      status: "abstained",
      calls: 0,
    });
    expect(model.calls).toHaveLength(0);
    expect(await decider(model)({ ...request, signedIn: false })).toMatchObject({ status: "ok" });
  });

  it("stops the other call when one fails and counts it once it settles", async () => {
    let pageAborted = false;
    const model = decisionModel(
      (options) =>
        new Promise((resolve, reject) => {
          if ("action" in options.questions)
            reject(
              new APICallError({
                message: "rate limited",
                url: "https://fake.invalid",
                requestBodyValues: {},
                statusCode: 429,
                isRetryable: true,
              }),
            );
          options.abortSignal?.addEventListener("abort", () => {
            pageAborted = true;
            reject(new Error("aborted"));
          });
          void resolve;
        }),
    );
    expect(await decider(model)(request)).toMatchObject({
      status: "failed",
      error: "rate-limited",
      calls: 2,
      usage: { inputTokens: null },
    });
    expect(pageAborted).toBe(true);
  });

  it("rejects incomplete, oversized, formless and account-list pages before any call", async () => {
    const model = answering(correct);
    const decide = decider(model);
    expect(
      await decide({ ...request, observation: { ...page.observation, complete: false } }),
    ).toMatchObject({ status: "failed", error: "incomplete-observation" });
    const small = createFieldMappingDecider({
      model,
      limits: { ...limits, maxInputBytes: 512 },
      minProbability: 0.7,
    });
    expect(await small(request)).toMatchObject({ status: "failed", error: "input-too-large" });
    const formless: LoginObservation = {
      ...page.observation,
      candidates: page.observation.candidates.filter(
        (candidate) => candidate.role === "button" || candidate.role === "link",
      ),
    };
    expect(await decide({ ...request, observation: formless })).toMatchObject({
      status: "abstained",
      reason: "no-login-form",
      calls: 0,
    });
    const list = { ...page.observation, accounts: ["Taro [email]"] };
    expect(await decide({ ...request, observation: list })).toMatchObject({
      status: "abstained",
      calls: 0,
    });
    expect(model.calls).toHaveLength(0);
    expect(() => createFieldMappingDecider({ model, limits, minProbability: 0.3 })).toThrow();
  });
});

describe("finite-choice usage and telemetry", () => {
  it("counts a retried attempt without usage as unknown", async () => {
    let attempt = 0;
    const model = decisionModel(async (options) => {
      attempt += 1;
      if (attempt === 1)
        throw new APICallError({
          message: "unavailable",
          url: "https://fake.invalid",
          requestBodyValues: {},
          statusCode: 503,
          responseHeaders: { "retry-after-ms": "1" },
          isRetryable: true,
        });
      return answering(correct).doDecide(options);
    });
    const decide = createFieldMappingDecider({
      model,
      limits: { ...limits, maxRetries: 1 },
      minProbability: 0.7,
    });
    // Each call retried once: one attempt without usage makes the total unknown.
    expect(await decide(request)).toMatchObject({
      status: "ok",
      calls: 3,
      usage: { inputTokens: null, outputTokens: null },
    });
  });

  it("never reports state or answers to global telemetry integrations", async () => {
    const seen: unknown[] = [];
    const spy = new Proxy({}, { get: () => (event: unknown) => void seen.push(event) });
    const global = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown };
    global.AI_SDK_TELEMETRY_INTEGRATIONS = [spy];
    try {
      expect(await decider(answering(correct))(request)).toMatchObject({ status: "ok" });
    } finally {
      delete global.AI_SDK_TELEMETRY_INTEGRATIONS;
    }
    expect(seen).toEqual([]);
  });
});
