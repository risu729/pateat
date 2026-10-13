import { describe, expect, it } from "vitest";
import {
  completionInstructions,
  completionStopInstructions,
  createCompletionJudge,
} from "./completion";
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
    // A text marker's text is stored in the recipe and must match every later sign-in;
    // a marker located by id stores no text.
    expect(completionInstructions).toMatch(
      /The marker must show on every signed-in visit of every account\. A marker whose target is by text is stored with that text, .* never the person's name/u,
    );
    expect(completionInstructions).toMatch(
      /passkeyButton is a button that continues with a security key or passkey, never one that registers, creates, adds or sets up one/u,
    );
    // Oracle Cloud's FIDO page starts its WebAuthn call from a button labelled only
    // "Verify" (2026-10-13).
    expect(completionInstructions).toMatch(
      /On a page that asks only to verify with a security key, passkey or FIDO authenticator, even with a link to other methods, the button that starts that check is passkeyButton whatever its label says\./u,
    );
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

describe("TOTP code on a challenge page (ADR 0027)", () => {
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

  it("keeps a code whose source the page does not say, as one from an authenticator app", async () => {
    // Owner decision, 2026-10-13: on Resend's and ニコニコ's code pages nothing near the
    // code field says where the code comes from.
    expect(await answer({ source: "unknown" }).judge(page([codeField, verify]))).toEqual(
      expect.objectContaining({ status: "ok", value: { decision: "challenge", totp } }),
    );
  });

  it.each(["sms", "email", "other"])("adds no handler for a code from %s", async (source) => {
    expect(await answer({ source }).judge(page([codeField, verify]))).toMatchObject({
      status: "ok",
      value: { decision: "challenge" },
    });
    const outcome = await answer({ source }).judge(page([codeField, verify]));
    expect(outcome.status === "ok" && "totp" in outcome.value).toBe(false);
    // Why is kept for the log.
    expect(outcome).toMatchObject({ value: { totpDropped: `source-${source}` } });
  });

  it.each([
    [
      "a field that is not a code field",
      [{ ...codeField, autocomplete: undefined, inputMode: undefined }, verify],
      "not-code-field",
    ],
    [
      "a field shorter than six characters",
      [{ ...codeField, maxLength: 1 }, verify],
      "code-too-short",
    ],
    [
      "one of several code fields in its form",
      [codeField, { ...codeField, id: "code-2", target: { by: "id", value: "digit-2" } }, verify],
      "several-code-fields",
    ],
    [
      "a submit element that is a link",
      [codeField, { ...verify, role: "link" }],
      "submit-not-button",
    ],
    [
      "a submit button in another form",
      [codeField, { ...verify, group: "form-2" }],
      "submit-other-form",
    ],
    [
      "a field that is a button",
      [
        { ...verify, id: "code" },
        { ...verify, target: { by: "id", value: "go" } },
      ],
      "not-input",
    ],
    ["a field that is not on the page", [verify], "unknown-field"],
    ["a submit button that is not on the page", [codeField], "unknown-submit"],
  ])("drops the code for %s, saying why", async (_label, candidates, why) => {
    // A code whose source the page does not say passes the same checks.
    for (const source of ["authenticator-app", "unknown"]) {
      // oxlint-disable-next-line no-await-in-loop -- Each source is judged on its own.
      const outcome = await answer({ source }).judge(page(candidates));
      expect(outcome).toMatchObject({
        status: "ok",
        value: { decision: "challenge", totpDropped: why },
      });
      expect(outcome.status === "ok" && "totp" in outcome.value).toBe(false);
    }
  });

  it("keeps a code field without a length limit and with the hint only", async () => {
    const { maxLength: _length, inputMode: _mode, ...hinted } = codeField;
    expect(
      await answer({ source: "authenticator-app" }).judge(page([hinted, verify])),
    ).toMatchObject({ status: "ok", value: { decision: "challenge", totp } });
  });

  it("tells the model to say where the code comes from", () => {
    // A bare challenge on a code page left no handler and no reason (Resend, 2026-10-12).
    expect(completionInstructions).toMatch(
      /A challenge that asks for a code always fills code: its field, submit and source\./u,
    );
    // A page that says neither answers unknown, which keeps the code (owner, 2026-10-13).
    expect(completionInstructions).toMatch(
      /code\.source is sms or email when the page says the code was sent to the person or names where it went \(a phone, call, message or address\), authenticator-app when it names an authenticator app, other when it names another source such as a recovery code, card or hardware token, and unknown only when it says nothing about where the code comes from\./u,
    );
  });
});

describe("code answers checked locally, probed independently (ADR 0027)", () => {
  const field = (extra: Record<string, unknown> = {}) => ({
    id: "code",
    role: "text",
    target: { by: "id", value: "otp" },
    label: "Code",
    inputMode: "numeric",
    maxLength: 6,
    group: "form-1",
    ...extra,
  });
  const submit = (extra: Record<string, unknown> = {}) => ({
    id: "verify",
    role: "button",
    target: { by: "id", value: "verify" },
    label: "Verify",
    group: "form-1",
    ...extra,
  });
  const key = {
    id: "key",
    role: "button",
    target: { by: "text", value: "Use security key" },
    label: "Use security key",
    group: "form-2",
  };
  const judged = (candidates: Record<string, unknown>[], result: Record<string, unknown>) =>
    judgeReturning(result).judge({
      ...request,
      observation: {
        ...signedIn,
        path: "/two-factor",
        title: "Two-factor authentication",
        headings: ["Enter the code from your authenticator app"],
        candidates,
      },
    });
  const answer = (code: Record<string, unknown> = {}) => ({
    decision: "challenge",
    code: { field: "code", submit: "verify", source: "authenticator-app", ...code },
  });
  const kept = { field: { by: "id", value: "otp" }, target: { by: "id", value: "verify" } };
  const hasTotp = (outcome: Awaited<ReturnType<typeof judged>>) =>
    outcome.status === "ok" && "totp" in outcome.value;

  it.each([
    ["exactly six characters", { maxLength: 6 }],
    ["eight characters", { maxLength: 8 }],
    ["a tel input of ten", { role: "tel", inputMode: undefined, maxLength: 10 }],
    ["a name locator", { target: { by: "name", value: "otp" } }],
  ])("keeps an authenticator app code in a field of %s", async (_label, extra) => {
    const outcome = await judged([field(extra), submit()], answer());
    expect(outcome).toMatchObject({ status: "ok", value: { decision: "challenge" } });
    expect(hasTotp(outcome)).toBe(true);
  });

  it("sends the text near the code field with the page, as it is", async () => {
    const observation = {
      ...signedIn,
      path: "/auth/mfa",
      title: "Two-factor authentication",
      headings: [],
      nearCode: ["Enter the code from your authenticator app"],
      candidates: [field(), submit()],
    };
    const { judge, sent } = judgeReturning(answer());
    expect(await judge({ ...request, observation })).toMatchObject({
      value: { decision: "challenge", totp: kept },
    });
    expect(sent).toEqual([{ task: "judge-sign-in", loginPaths: ["/login"], observation }]);
  });

  it("drops a field limited to five characters", async () => {
    expect(hasTotp(await judged([field({ maxLength: 5 }), submit()], answer()))).toBe(false);
  });

  it("keeps the code when another code field sits in a different form", async () => {
    const other = field({ id: "other", target: { by: "id", value: "sms" }, group: "form-9" });
    expect(await judged([field(), submit(), other], answer())).toMatchObject({
      status: "ok",
      value: { decision: "challenge", totp: kept },
    });
  });

  it("treats elements outside any form as one form", async () => {
    const loose = [field({ group: undefined }), submit({ group: undefined })];
    expect(await judged(loose, answer())).toMatchObject({ value: { totp: kept } });
    // Two loose code fields are two code fields in one form.
    const split = [
      ...loose,
      field({ id: "d2", target: { by: "id", value: "d2" }, group: undefined }),
    ];
    expect(hasTotp(await judged(split, answer()))).toBe(false);
    // A loose button is not the button of a form.
    expect(hasTotp(await judged([field(), submit({ group: undefined })], answer()))).toBe(false);
  });

  it.each([
    ["an unknown field ID", { field: "missing" }],
    ["an unknown submit ID", { submit: "missing" }],
    ["a submit that is the field itself", { submit: "code" }],
  ])("drops %s", async (_label, code) => {
    const outcome = await judged([field(), submit()], answer(code));
    expect(outcome).toMatchObject({ status: "ok", value: { decision: "challenge" } });
    expect(hasTotp(outcome)).toBe(false);
  });

  describe("a code split into one input per digit (owner decision 2026-10-12)", () => {
    const boxes = (count: number, extra: Record<string, unknown> = {}) =>
      Array.from({ length: count }, (_, index) =>
        field({
          id: `d${index + 1}`,
          target: { by: "id", value: `otp-${index + 1}` },
          label: `Digit ${index + 1}`,
          maxLength: 1,
          ...extra,
        }),
      );
    const first = { field: { by: "id", value: "otp-1" }, target: { by: "id", value: "verify" } };

    it.each([
      [6, "d1"],
      [6, "d6"],
      [7, "d4"],
      [8, "d8"],
    ])("keeps the first of %i one-digit inputs when %s is named", async (count, named) => {
      expect(await judged([...boxes(count), submit()], answer({ field: named }))).toMatchObject({
        status: "ok",
        value: { decision: "challenge", totp: first },
      });
    });

    it("keeps the first input of a split code whose source the page does not say", async () => {
      // As on ニコニコ's split code page, where nothing near the code says its source.
      expect(
        await judged([...boxes(6), submit()], answer({ field: "d4", source: "unknown" })),
      ).toMatchObject({ status: "ok", value: { decision: "challenge", totp: first } });
    });

    it("keeps one-digit inputs marked only as one-time codes or as tel inputs", async () => {
      const hinted = boxes(6, { inputMode: undefined, autocomplete: "one-time-code" });
      expect(await judged([...hinted, submit()], answer({ field: "d1" }))).toMatchObject({
        value: { totp: first },
      });
      const tel = boxes(6, { inputMode: undefined, role: "tel" });
      expect(await judged([...tel, submit()], answer({ field: "d1" }))).toMatchObject({
        value: { totp: first },
      });
    });

    it.each([
      ["five inputs", boxes(5)],
      ["nine inputs", boxes(9)],
      [
        "an input taking two characters",
        [...boxes(5), field({ id: "d6", target: { by: "id", value: "otp-6" }, maxLength: 2 })],
      ],
      [
        "a six-character code input beside them",
        [...boxes(6), field({ id: "whole", target: { by: "id", value: "whole" } })],
      ],
      ["inputs that are no code fields", boxes(6, { inputMode: undefined })],
      [
        "inputs in two forms",
        [
          ...boxes(3),
          ...boxes(6)
            .slice(3)
            .map((box) => ({ ...box, group: "form-2" })),
        ],
      ],
    ])("drops a code split into %s", async (_label, candidates) => {
      expect(hasTotp(await judged([...candidates, submit()], answer({ field: "d1" })))).toBe(false);
    });

    it("keeps a split code outside any form with a button outside any form", async () => {
      const loose = boxes(6, { group: undefined });
      expect(
        await judged([...loose, submit({ group: undefined })], answer({ field: "d3" })),
      ).toMatchObject({ value: { totp: first } });
    });

    it("drops a split code whose button is in another form", async () => {
      expect(
        hasTotp(await judged([...boxes(6), submit({ group: "form-2" })], answer({ field: "d1" }))),
      ).toBe(false);
    });
  });

  it.each(["text", "checkbox"])("drops a submit that is a %s input", async (role) => {
    expect(hasTotp(await judged([field(), submit({ role })], answer()))).toBe(false);
  });

  it("never learns a code field located by its text: such a page is no valid request", async () => {
    // Observations locate inputs by attributes only, so the judge's own text check is a
    // second guard that a valid request never reaches.
    const { judge, sent } = judgeReturning(answer());
    expect(
      await judge({
        ...request,
        observation: {
          ...signedIn,
          path: "/two-factor",
          candidates: [field({ target: { by: "text", value: "Code" } }), submit()],
        },
      }),
    ).toMatchObject({ status: "failed", error: "invalid-request" });
    expect(sent).toEqual([]);
  });

  it("returns a passkey button and a code together", async () => {
    expect(
      await judged([field(), submit(), key], { ...answer(), passkeyButton: "key" }),
    ).toMatchObject({
      status: "ok",
      value: {
        decision: "challenge",
        passkey: { by: "text", value: "Use security key" },
        totp: kept,
      },
    });
    // Either survives the other's failing its checks.
    const sms = await judged([field(), submit(), key], {
      ...answer({ source: "sms" }),
      passkeyButton: "key",
    });
    expect(sms).toMatchObject({ value: { passkey: { by: "text", value: "Use security key" } } });
    expect(hasTotp(sms)).toBe(false);
    const noKey = await judged([field(), submit(), key], { ...answer(), passkeyButton: "code" });
    expect(noKey).toMatchObject({ value: { totp: kept } });
    expect(noKey.status === "ok" && "passkey" in noKey.value).toBe(false);
  });

  it("fails closed on an unknown source or a code beside another decision", async () => {
    expect(await judged([field(), submit()], answer({ source: "push" }))).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
    expect(
      await judged([field(), submit()], {
        decision: "rejected",
        code: { field: "code", submit: "verify", source: "authenticator-app" },
      }),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
    expect(
      await judged([field(), submit()], { decision: "challenge", code: { field: "code" } }),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });
});

// Owner, 2026-10-13 05:39 UTC: a login stopped before a password its item lacks has the
// page judged for a passkey button beside the password field (ADR 0036).
describe("sign-in judge at a stop before the password", () => {
  const passwordPage = {
    version: 1,
    origin: "https://bank.example",
    path: "/password",
    language: "en",
    complete: true,
    candidates: [
      { id: "pw", role: "password", target: { by: "id", value: "pw" }, label: "Password" },
      { id: "go", role: "button", target: { by: "id", value: "go" }, label: "Continue" },
      { id: "key", role: "button", target: { by: "id", value: "key" }, label: "Use a passkey" },
    ],
  };
  function judgeAt(result: unknown) {
    const model = textModel(async () => textResult(JSON.stringify({ result })));
    return { model, judge: createCompletionJudge({ model, limits, maxOutputTokens: 512 }) };
  }
  const system = (model: ReturnType<typeof judgeAt>["model"]) =>
    model.doGenerateCalls[0]!.prompt.filter((message) => message.role === "system").map(
      (message) => message.content,
    );

  it("sends the stop's instructions, which name no fact of the account", async () => {
    const { model, judge } = judgeAt({ decision: "challenge", passkeyButton: "key" });
    expect(
      await judge({ observation: passwordPage, loginPaths: ["/login"], stop: true }),
    ).toMatchObject({
      status: "ok",
      value: { decision: "challenge", passkey: { by: "id", value: "key" } },
    });
    expect(system(model)).toEqual([completionStopInstructions]);
    expect(completionStopInstructions.startsWith(completionInstructions)).toBe(true);
    expect(completionStopInstructions).toMatch(/passkeyButton when the page offers/u);
    expect(completionStopInstructions).not.toMatch(/no password|has a passkey|empty/iu);
    // Any other page keeps the usual instructions.
    const usual = judgeAt({ decision: "unclear" });
    await usual.judge({ observation: passwordPage, loginPaths: ["/login"] });
    expect(system(usual.model)).toEqual([completionInstructions]);
  });

  it("still fails closed on a signed-in answer while the password field shows", async () => {
    const { judge } = judgeAt({ decision: "signed-in", marker: "go" });
    expect(
      await judge({ observation: passwordPage, loginPaths: ["/login"], stop: true }),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });
});
