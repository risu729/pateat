import { describe, expect, it } from "vitest";
import type { LoginObservation } from "@pateat/contracts";
import { createSsoGenerator, validateSsoPlan, type SsoPlan } from "./sso";
import { generationRequest, textModel, textResult } from "./testing/fake-models";

const page: LoginObservation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/login",
  language: "en",
  complete: true,
  title: "Sign in",
  headings: ["Existing account"],
  candidates: [
    {
      id: "provider",
      role: "button",
      label: "Continue with Example",
      target: { by: "id", value: "provider" },
    },
    {
      id: "other",
      role: "link",
      label: "Continue with Other",
      target: { by: "text", value: "Continue with Other" },
    },
    {
      id: "password",
      role: "password",
      label: "Password",
      target: { by: "id", value: "password" },
    },
  ],
};
const plan: SsoPlan = {
  decision: "plan",
  page: "sign-in",
  entries: [{ label: "Example", candidate: "provider" }],
};
const setup = (answer: unknown, finish?: Parameters<typeof textResult>[1]) => {
  const model = textModel(async () => textResult(JSON.stringify({ result: answer }), finish));
  return {
    model,
    generate: createSsoGenerator({
      model,
      limits: { timeoutMs: 1000, maxInputBytes: 16384 },
      maxOutputTokens: 512,
    }),
  };
};

describe("SSO entry inference", () => {
  it("sends only selected labels and value-free buttons; returns only observed targets", async () => {
    const { model, generate } = setup(plan);
    const result = await generate({
      observation: { ...page, accounts: ["[email]"] },
      labels: ["Example"],
    });
    expect(result).toMatchObject({
      status: "ok",
      calls: 1,
      value: [{ label: "Example", candidate: "provider", target: page.candidates[0]!.target }],
    });
    expect(generationRequest(model.doGenerateCalls[0]!)).toEqual({
      task: "sso",
      labels: ["Example"],
      observation: {
        version: 1,
        origin: page.origin,
        path: page.path,
        language: "en",
        complete: true,
        title: "Sign in",
        headings: ["Existing account"],
        candidates: page.candidates.slice(0, 2),
      },
    });
    expect(model.doGenerateCalls[0]!.responseFormat).toMatchObject({
      type: "json",
      name: "sso_entries",
    });
  });

  it.each([
    [{ ...plan, entries: [{ label: "Other", candidate: "provider" }] }, "unknown-label"],
    [{ ...plan, entries: [{ label: "Example", candidate: "invented" }] }, "unknown-candidate"],
    [{ ...plan, entries: [{ label: "Example", candidate: "password" }] }, "incompatible-role"],
    [{ ...plan, entries: [] }, "incomplete"],
  ] as const)(
    "rejects model-selected references beyond the request: %s",
    async (answer, reason) => {
      expect(
        validateSsoPlan(page, ["Example"], { ...answer, entries: [...answer.entries] }),
      ).toEqual({ ok: false, reason });
      const { generate } = setup(answer);
      expect(await generate({ observation: page, labels: ["Example"] })).toMatchObject({
        status: "failed",
        error: "invalid-output",
      });
    },
  );

  it("rejects missing and reused entries instead of substituting another method", () => {
    expect(validateSsoPlan(page, ["Example", "Other"], plan)).toEqual({
      ok: false,
      reason: "incomplete",
    });
    const repeated = {
      ...plan,
      entries: [
        { label: "Example", candidate: "provider" },
        { label: "Other", candidate: "provider" },
      ],
    };
    expect(validateSsoPlan(page, ["Example", "Other"], repeated)).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(
      validateSsoPlan(page, ["Example", "Other"], {
        ...repeated,
        entries: [repeated.entries[0]!, repeated.entries[0]!],
      }),
    ).toEqual({ ok: false, reason: "duplicate" });
  });

  it.each(["consent", "sharing", "account-creation", "unclear"] as const)(
    "refuses a %s classification even with a matching provider",
    async (kind) => {
      const { generate } = setup({ ...plan, page: kind });
      expect(await generate({ observation: page, labels: ["Example"] })).toMatchObject({
        status: "failed",
        error: "invalid-output",
      });
    },
  );

  it.each([
    { title: "Authorize access" },
    { headings: ["Share account data"] },
    { nearButtons: ["Create your account"] },
    { title: "新規アカウント作成" },
    {
      candidates: [
        ...page.candidates,
        {
          id: "name",
          role: "text" as const,
          autocomplete: "given-name",
          target: { by: "id" as const, value: "name" },
        },
      ],
    },
  ])("abstains locally on generic unsafe evidence %s", async (extra) => {
    const { model, generate } = setup(plan);
    expect(
      await generate({ observation: { ...page, ...extra }, labels: ["Example"] }),
    ).toMatchObject({ status: "abstained", reason: "no-login-form", calls: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("rejects a registration button on an otherwise sign-in page", async () => {
    const { generate } = setup(plan);
    expect(
      await generate({
        observation: {
          ...page,
          candidates: [{ ...page.candidates[0]!, label: "Sign up with Example" }],
        },
        labels: ["Example"],
      }),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });

  it("redacts invented output from the retained answer", async () => {
    const { generate } = setup({
      ...plan,
      entries: [{ label: "private-invented", candidate: "private-invented" }],
    });
    const result = await generate({ observation: page, labels: ["Example"] });
    expect(result).toMatchObject({
      status: "failed",
      output: { entries: [{ label: "?", candidate: "?" }] },
    });
    expect(JSON.stringify(result)).not.toContain("private-invented");
  });

  it("makes no call for incomplete or invalid requests", async () => {
    const { generate, model } = setup(plan);
    expect(
      await generate({ observation: { ...page, complete: false }, labels: ["Example"] }),
    ).toMatchObject({ status: "failed", error: "incomplete-observation", calls: 0 });
    expect(await generate({ observation: page, labels: ["Example", "example"] })).toMatchObject({
      status: "failed",
      error: "invalid-request",
      calls: 0,
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("preserves abstention, refusal and invalid-output outcomes without a fallback", async () => {
    const abstained = setup({ decision: "abstain", reason: "ambiguous" });
    expect(await abstained.generate({ observation: page, labels: ["Example"] })).toMatchObject({
      status: "abstained",
      reason: "ambiguous",
      calls: 1,
    });
    const refused = setup(plan, { finish: "content-filter" });
    expect(await refused.generate({ observation: page, labels: ["Example"] })).toMatchObject({
      status: "failed",
      error: "refused",
      calls: 1,
    });
    const invalid = setup({ ...plan, origin: "https://invented.example.test" });
    expect(await invalid.generate({ observation: page, labels: ["Example"] })).toMatchObject({
      status: "failed",
      error: "invalid-output",
      calls: 1,
    });
    expect(invalid.model.doGenerateCalls).toHaveLength(1);
  });
});
