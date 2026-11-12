import { expect, it } from "vitest";
import { completionInstructions, createCompletionJudge } from "../../src/completion";
import { textModel, textResult } from "../../src/testing/fake-models";
import type { CompletionFixtures } from "../../src/completion.test";

export function registerSignInCases({
  signedIn,
  request,
  judgeReturning,
}: Pick<CompletionFixtures, "signedIn" | "request" | "judgeReturning">) {
  it("resolves a signed-in marker to the page's path and locator", async () => {
    const { judge, sent } = judgeReturning({ decision: "signed-in", marker: "logout" });
    expect(await judge(request)).toMatchObject({
      status: "ok",
      calls: 1,
      value: { decision: "signed-in", target: { by: "id", value: "logout" } },
    });
    expect(sent).toEqual([
      {
        task: "judge-sign-in",
        loginPaths: ["/login"],
        slots: [],
        stepElements: [],
        observation: signedIn,
      },
    ]);
  });

  it("names the candidates the recipe's own steps use, which are never a marker", async () => {
    const { judge, sent } = judgeReturning({ decision: "signed-in", marker: "help" });
    expect(
      await judge({
        ...request,
        // The sign-in button's id, which the signed-in page's Sign out shares, and an
        // element the page does not show.
        recipeElements: [
          { by: "id", value: "logout" },
          { by: "id", value: "email" },
        ],
      }),
    ).toMatchObject({ status: "ok", value: { target: { by: "id", value: "help" } } });
    expect(sent).toEqual([
      {
        task: "judge-sign-in",
        loginPaths: ["/login"],
        slots: [],
        stepElements: ["logout"],
        observation: signedIn,
      },
    ]);
    expect(completionInstructions).toContain("stepElements");
    // A malformed list is refused before any call.
    expect(
      await judgeReturning({ decision: "unclear" }).judge({
        ...request,
        recipeElements: [{ by: "css", value: "#x" }],
      }),
    ).toMatchObject({ status: "failed", error: "invalid-request", calls: 0 });
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

  it("accepts a link located by its path as the marker (ADR 0029)", async () => {
    const account = {
      ...signedIn,
      candidates: [{ id: "my", role: "link", target: { by: "href", value: "/my" }, label: "Nick" }],
    };
    expect(
      await judgeReturning({ decision: "signed-in", marker: "my" }).judge({
        ...request,
        observation: account,
      }),
    ).toMatchObject({ status: "ok", value: { target: { by: "href", value: "/my" } } });
  });

  // Owner, 2026-10-18: the request log keeps the model's own answer beside the result.
  it("keeps every decision as the answer, with IDs the page lacks as ?", async () => {
    const answerOf = async (result: unknown) =>
      (await judgeReturning(result).judge(request)).answer;
    expect(await answerOf({ decision: "unclear" })).toEqual({ decision: "unclear" });
    expect(await answerOf({ decision: "rejected" })).toEqual({ decision: "rejected" });
    expect(await answerOf({ decision: "signed-in", marker: "logout" })).toEqual({
      decision: "signed-in",
      marker: "logout",
    });
    // A marker the page lacks fails closed, and its answer keeps no page text.
    const refused = await judgeReturning({ decision: "signed-in", marker: "Sign out" }).judge(
      request,
    );
    expect(refused).toMatchObject({
      status: "failed",
      error: "invalid-output",
      answer: { decision: "signed-in", marker: "?" },
    });
    // A challenge whose named elements fail the checks keeps them as named.
    expect(
      await answerOf({
        decision: "challenge",
        passkeyButton: "help",
        passwordButton: "Use your password",
        code: { field: "search", submit: "Verify", source: "email" },
      }),
    ).toEqual({
      decision: "challenge",
      passkeyButton: "help",
      passwordButton: "?",
      code: { field: "search", submit: "?", source: "email" },
    });
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
}
