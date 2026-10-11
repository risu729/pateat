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

  it("names the page's passkey button as the challenge's next element", async () => {
    expect(
      await judgeReturning({ decision: "challenge", passkeyButton: "key" }).judge(challenge),
    ).toMatchObject({
      status: "ok",
      value: { decision: "challenge", next: { by: "text", value: "Use security key" } },
    });
  });

  it.each(["recovery", "code", "missing"])(
    "keeps a plain challenge when the named element %s is not a button",
    async (passkeyButton) => {
      const outcome = await judgeReturning({ decision: "challenge", passkeyButton }).judge(
        challenge,
      );
      expect(outcome).toMatchObject({ status: "ok", value: { decision: "challenge" } });
      expect(outcome.status === "ok" && "next" in outcome.value).toBe(false);
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
