import { describe, expect, it } from "vitest";
import { completionInstructions, createCompletionJudge } from "./completion";
import { generationRequest, textModel, textResult } from "./testing/fake-models";

// A synthetic page shown after signing in. No real site or account data.
const signedIn = {
  version: 1,
  origin: "https://bank.example",
  path: "/home",
  language: "en",
  title: "Accounts",
  headings: ["Welcome back"],
  complete: true,
  candidates: [
    { id: "logout", role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
    { id: "help", role: "link", target: { by: "id", value: "help" }, label: "Help" },
    { id: "search", role: "text", target: { by: "name", value: "q" }, label: "Search" },
  ],
};
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const request = { observation: signedIn, loginPaths: ["/login"] };

function judgeReturning(result: unknown) {
  const sent: unknown[] = [];
  const model = textModel(async (options) => {
    sent.push(generationRequest(options));
    return textResult(JSON.stringify({ result }));
  });
  return { sent, judge: createCompletionJudge({ model, limits, maxOutputTokens: 512 }) };
}

describe("sign-in judge", () => {
  it("resolves a signed-in marker to the page's path and locator", async () => {
    const { judge, sent } = judgeReturning({ decision: "signed-in", marker: "logout" });
    expect(await judge(request)).toMatchObject({
      status: "ok",
      calls: 1,
      value: { decision: "signed-in", target: { by: "id", value: "logout" } },
    });
    expect(sent).toEqual([
      { task: "judge-sign-in", loginPaths: ["/login"], observation: signedIn },
    ]);
  });

  it("passes rejection and challenge through and abstains when unclear", async () => {
    expect(await judgeReturning({ decision: "rejected" }).judge(request)).toMatchObject({
      status: "ok",
      value: { decision: "rejected" },
    });
    expect(await judgeReturning({ decision: "challenge" }).judge(request)).toMatchObject({
      status: "ok",
      value: { decision: "challenge" },
    });
    expect(await judgeReturning({ decision: "unclear" }).judge(request)).toMatchObject({
      status: "abstained",
      reason: "insufficient-evidence",
    });
  });

  it("accepts a link or text-located marker", async () => {
    expect(
      await judgeReturning({ decision: "signed-in", marker: "help" }).judge(request),
    ).toMatchObject({ status: "ok", value: { target: { by: "id", value: "help" } } });
    const textMarker = {
      ...signedIn,
      candidates: [
        { id: "out", role: "button", target: { by: "text", value: "Sign out" }, label: "Sign out" },
      ],
    };
    expect(
      await judgeReturning({ decision: "signed-in", marker: "out" }).judge({
        ...request,
        observation: textMarker,
      }),
    ).toMatchObject({ status: "ok", value: { target: { by: "text", value: "Sign out" } } });
  });

  it("fails closed on an unknown or non-clickable marker", async () => {
    expect(
      await judgeReturning({ decision: "signed-in", marker: "missing" }).judge(request),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
    expect(
      await judgeReturning({ decision: "signed-in", marker: "search" }).judge(request),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });

  it.each([
    { role: "password" },
    { role: "text", autocomplete: "username" },
    { role: "text", autocomplete: "one-time-code" },
    { role: "text", autocomplete: "current-password" },
  ])("fails closed when the page still has a sign-in field: %o", async (field) => {
    const stillLogin = {
      ...signedIn,
      candidates: [
        ...signedIn.candidates,
        { id: "field", target: { by: "id", value: "f" }, ...field },
      ],
    };
    expect(
      await judgeReturning({ decision: "signed-in", marker: "logout" }).judge({
        ...request,
        observation: stillLogin,
      }),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });

  it("allows a registration password field on a signed-in page", async () => {
    const changePassword = {
      ...signedIn,
      candidates: [
        ...signedIn.candidates,
        {
          id: "new",
          role: "password",
          autocomplete: "new-password",
          target: { by: "id", value: "new" },
        },
      ],
    };
    expect(
      await judgeReturning({ decision: "signed-in", marker: "logout" }).judge({
        ...request,
        observation: changePassword,
      }),
    ).toMatchObject({ status: "ok", value: { decision: "signed-in" } });
  });

  it("rejects incomplete, invalid and oversized requests before any model call", async () => {
    const { judge, sent } = judgeReturning({ decision: "rejected" });
    expect(await judge({ ...request, observation: { ...signedIn, complete: false } })).toEqual({
      status: "failed",
      error: "incomplete-observation",
      calls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const invalid = await Promise.all(
      [[], ["login"], ["/a/../b"]].map((loginPaths) => judge({ ...request, loginPaths })),
    );
    for (const outcome of invalid)
      expect(outcome).toMatchObject({ status: "failed", error: "invalid-request" });
    const small = createCompletionJudge({
      model: textModel(async () => textResult("{}")),
      limits: { timeoutMs: 1_000, maxInputBytes: 256 },
      maxOutputTokens: 512,
    });
    expect(await small(request)).toMatchObject({ status: "failed", error: "input-too-large" });
    expect(sent).toEqual([]);
  });
});

describe("passkey button on a challenge page (ADR 0027)", () => {
  const webauthn = {
    ...signedIn,
    path: "/login/webauthn",
    title: "Two-factor authentication",
    headings: ["Use your security key"],
    candidates: [
      {
        id: "key",
        role: "button",
        target: { by: "text", value: "Use security key" },
        label: "Use security key",
      },
      { id: "recovery", role: "link", target: { by: "id", value: "recovery" }, label: "Recovery" },
      { id: "code", role: "text", target: { by: "id", value: "code" }, label: "Code" },
    ],
  };
  const challenge = { ...request, observation: webauthn };

  it("names the page's passkey button as the challenge's passkey element", async () => {
    expect(
      await judgeReturning({ decision: "challenge", passkeyButton: "key" }).judge(challenge),
    ).toMatchObject({
      status: "ok",
      value: { decision: "challenge", passkey: { by: "text", value: "Use security key" } },
    });
  });

  it.each(["recovery", "code", "missing"])(
    "keeps a plain challenge when the named element %s is not a button",
    async (passkeyButton) => {
      const outcome = await judgeReturning({ decision: "challenge", passkeyButton }).judge(
        challenge,
      );
      expect(outcome).toMatchObject({ status: "ok", value: { decision: "challenge" } });
      expect(outcome.status === "ok" && "passkey" in outcome.value).toBe(false);
    },
  );

  it("fails closed on a passkey button outside a challenge", async () => {
    expect(
      await judgeReturning({
        decision: "signed-in",
        marker: "logout",
        passkeyButton: "logout",
      }).judge(request),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });

  it("tells the model never to name a button that registers a passkey", () => {
    expect(completionInstructions).toMatch(/passkeyButton/u);
    expect(completionInstructions).toMatch(/Never name a button that registers, adds, creates/u);
  });

  it("accepts the route's and handlers' paths", async () => {
    const paths = Array.from({ length: 48 }, (_, index) => `/p${index}`);
    expect(
      await judgeReturning({ decision: "rejected" }).judge({ ...request, loginPaths: paths }),
    ).toMatchObject({ status: "ok" });
    expect(
      await judgeReturning({ decision: "rejected" }).judge({
        ...request,
        loginPaths: [...paths, "/p48"],
      }),
    ).toMatchObject({ status: "failed", error: "invalid-request" });
  });
});

describe("authenticator app code on a challenge page (ADR 0027)", () => {
  const codeField = {
    id: "code",
    role: "text",
    target: { by: "id", value: "app_totp" },
    label: "Authentication code",
    autocomplete: "one-time-code",
    inputMode: "numeric",
    maxLength: 6,
    group: "form-1",
  };
  const verify = {
    id: "verify",
    role: "button",
    target: { by: "text", value: "Verify" },
    label: "Verify",
    group: "form-1",
  };
  const page = (candidates: Record<string, unknown>[]) => ({
    ...request,
    observation: {
      ...signedIn,
      path: "/sessions/two-factor/app",
      title: "Two-factor authentication",
      headings: ["Open your authenticator app"],
      candidates,
    },
  });
  const answer = (code: Record<string, unknown>) =>
    judgeReturning({ decision: "challenge", code: { field: "code", submit: "verify", ...code } });
  const totp = { field: { by: "id", value: "app_totp" }, target: { by: "text", value: "Verify" } };

  it("names the code field and its submit button for an authenticator app", async () => {
    expect(await answer({ source: "authenticator-app" }).judge(page([codeField, verify]))).toEqual(
      expect.objectContaining({ status: "ok", value: { decision: "challenge", totp } }),
    );
  });

  it.each(["sms", "email", "unknown"])("adds no handler for a code from %s", async (source) => {
    expect(await answer({ source }).judge(page([codeField, verify]))).toMatchObject({
      status: "ok",
      value: { decision: "challenge" },
    });
    const outcome = await answer({ source }).judge(page([codeField, verify]));
    expect(outcome.status === "ok" && "totp" in outcome.value).toBe(false);
  });

  it.each([
    [
      "a field that is not a code field",
      [{ ...codeField, autocomplete: undefined, inputMode: undefined }, verify],
    ],
    ["a field shorter than six characters", [{ ...codeField, maxLength: 1 }, verify]],
    [
      "one of several code fields in its form",
      [codeField, { ...codeField, id: "code-2", target: { by: "id", value: "digit-2" } }, verify],
    ],
    ["a submit element that is a link", [codeField, { ...verify, role: "link" }]],
    ["a submit button in another form", [codeField, { ...verify, group: "form-2" }]],
    [
      "a field that is a button",
      [
        { ...verify, id: "code" },
        { ...verify, target: { by: "id", value: "go" } },
      ],
    ],
  ])("drops the code for %s", async (_label, candidates) => {
    const outcome = await answer({ source: "authenticator-app" }).judge(page(candidates));
    expect(outcome).toMatchObject({ status: "ok", value: { decision: "challenge" } });
    expect(outcome.status === "ok" && "totp" in outcome.value).toBe(false);
  });

  it("keeps a code field without a length limit and with the hint only", async () => {
    const { maxLength: _length, inputMode: _mode, ...hinted } = codeField;
    expect(
      await answer({ source: "authenticator-app" }).judge(page([hinted, verify])),
    ).toMatchObject({ status: "ok", value: { decision: "challenge", totp } });
  });

  it("tells the model to say where the code comes from", () => {
    expect(completionInstructions).toMatch(/code\.source/u);
    expect(completionInstructions).toMatch(/authenticator-app' only when the page says/u);
  });
});
