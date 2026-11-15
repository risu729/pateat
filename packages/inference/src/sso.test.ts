import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { MAX_SSO_REQUEST_LABELS, type LoginObservation } from "@pateat/contracts";
import { createSsoGenerator, ssoPlanSchema, validateSsoPlan, type SsoPlan } from "./sso";
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
  entries: [{ labelIndex: 0, candidate: "provider" }],
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
    [{ ...plan, entries: [{ labelIndex: 1, candidate: "provider" }] }, "unknown-label"],
    [{ ...plan, entries: [{ labelIndex: 0, candidate: "invented" }] }, "unknown-candidate"],
    [{ ...plan, entries: [{ labelIndex: 0, candidate: "password" }] }, "incompatible-role"],
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
        { labelIndex: 0, candidate: "provider" },
        { labelIndex: 1, candidate: "provider" },
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
    { title: "Example wants to access your account" },
    { headings: ["Share account data"] },
    { headings: ["Create your account"] },
    { title: "Sign up" },
    { title: "新規アカウント作成" },
    { headings: ["会員登録"] },
    { headings: ["アクセスを許可しますか？"] },
  ])(
    "abstains locally on a page that only grants access or creates an account %s",
    async (extra) => {
      const { model, generate } = setup(plan);
      expect(
        await generate({ observation: { ...page, ...extra }, labels: ["Example"] }),
      ).toMatchObject({ status: "abstained", reason: "no-login-form", calls: 0 });
      expect(model.doGenerateCalls).toHaveLength(0);
    },
  );

  // Headings of real sign-in pages: they offer signing up beside signing in, show a cookie
  // banner's heading first, or ask for a detail beside the provider buttons. The role's own
  // classification decides those.
  it.each([
    { title: "Log in or sign up" },
    { title: "Create your account or sign in" },
    { title: "ログイン・新規登録" },
    { headings: ["ログインまたは会員登録"] },
    { headings: ["We value your privacy", "Sign in"] },
    { headings: ["Cookie consent", "Sign in"] },
    { headings: ["Cookieの同意", "ログイン"] },
    { headings: ["新規のお客様・ログイン"] },
    { nearButtons: ["Create your account"] },
    {
      candidates: [
        ...page.candidates,
        {
          id: "tel",
          role: "text" as const,
          autocomplete: "tel",
          target: { by: "id" as const, value: "tel" },
        },
        {
          id: "name",
          role: "text" as const,
          autocomplete: "given-name",
          target: { by: "id" as const, value: "name" },
        },
      ],
    },
  ])("asks the role on a sign-in page that shows %s", async (extra) => {
    const { model, generate } = setup(plan);
    expect(
      await generate({ observation: { ...page, ...extra }, labels: ["Example"] }),
    ).toMatchObject({ status: "ok", calls: 1 });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("bounds the largest answer by the output tokens the role allows", () => {
    // ASCII only, so a token covers at least one character.
    const largest = JSON.stringify({
      result: {
        decision: "plan",
        page: "account-creation",
        entries: Array.from({ length: MAX_SSO_REQUEST_LABELS }, (_, index) => ({
          labelIndex: index,
          candidate: "c".repeat(64),
        })),
      },
    });
    expect(v.is(ssoPlanSchema, JSON.parse(largest))).toBe(true);
    expect(/^[\x20-\x7e]*$/u.test(largest)).toBe(true);
    expect(largest.length).toBeLessThanOrEqual(1_024);
    const larger = JSON.parse(largest);
    larger.result.entries.push({ labelIndex: 0, candidate: "c" });
    expect(v.is(ssoPlanSchema, larger)).toBe(false);
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
      entries: [{ labelIndex: 7, candidate: "private-invented" }],
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
    expect(await generate({ observation: page, labels: ["Example", "[Example]"] })).toMatchObject({
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
