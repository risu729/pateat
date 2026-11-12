import { describe, expect, it } from "vitest";
import { registerSignInCases } from "../test/completion/sign-in";
import {
  registerCodeFieldCases,
  registerUnboundedCodeCases,
  registerCodeGroupingCases,
  registerSplitCodeCases,
  registerSubmitlessCodeCases,
  registerUnboundedSplitCodeCases,
  registerSplitCodeFormCases,
  registerCodeAnswerValidationCases,
} from "../test/completion/code-answers";
import {
  registerPersonalDetailCases,
  registerSplitPersonalDetailCases,
} from "../test/completion/personal-details";
import { registerAccountSlotCases } from "../test/completion/account-slots";
import {
  completionBesideInstructions,
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

export type CompletionFixtures = {
  signedIn: typeof signedIn;
  request: typeof request;
  judgeReturning: typeof judgeReturning;
};

describe("sign-in judge", () => {
  registerSignInCases({ signedIn, request, judgeReturning });
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

describe("password button on a page that asks how to verify (ADR 0048)", () => {
  // A synthetic page after the identifier: no inputs, a choice of how to confirm the
  // sign-in, and links to cancel or read more.
  const choice = {
    ...signedIn,
    path: "/",
    title: "Sign in",
    headings: ["Let's confirm it's you"],
    candidates: [
      {
        id: "password",
        role: "button",
        target: { by: "id", value: "choose-password" },
        label: "Password",
      },
      { id: "mobile", role: "button", target: { by: "text", value: "Mobile" }, label: "Mobile" },
      { id: "cancel", role: "link", target: { by: "id", value: "cancel" }, label: "Cancel" },
    ],
  };
  const challenge = { ...request, observation: choice };

  it("names the page's button that goes on to the password", async () => {
    expect(
      await judgeReturning({ decision: "challenge", passwordButton: "password" }).judge(challenge),
    ).toEqual(
      expect.objectContaining({
        status: "ok",
        value: { decision: "challenge", password: { by: "id", value: "choose-password" } },
      }),
    );
  });

  it.each(["cancel", "missing"])(
    "keeps a plain challenge when the named element %s is not a button",
    async (passwordButton) => {
      const outcome = await judgeReturning({ decision: "challenge", passwordButton }).judge(
        challenge,
      );
      expect(outcome).toMatchObject({ status: "ok", value: { decision: "challenge" } });
      expect(outcome.status === "ok" && "password" in outcome.value).toBe(false);
    },
  );

  it("fails closed on a password button outside a challenge", async () => {
    expect(
      await judgeReturning({ decision: "unclear", passwordButton: "password" }).judge(challenge),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });

  it("tells the model what counts as such a page and which buttons never count", () => {
    expect(completionInstructions).toMatch(
      /A page that asks how to confirm the sign-in, such as with the password or a phone, is a challenge\./u,
    );
    expect(completionInstructions).toMatch(
      /passwordButton is the button on such a page that goes on to typing the account's existing password, .*never one that uses a phone, mobile, push notification, SMS, email, an app, a passkey or security key, sends or enters a code, creates, resets or changes a password, says Forgot password, tries another way or cancels, and never a link\./u,
    );
    expect(completionInstructions).toMatch(
      /Nor is it a button that uses the device's biometrics or platform sign-in, such as Touch ID, Face ID, a fingerprint or Windows Hello, even one whose label also names the password\./u,
    );
    // A button that shows only "Select" is told apart by its accessible name (ADR 0048
    // amendment of 2026-10-19).
    expect(completionInstructions).toMatch(
      /A button by accessible-name may show only neutral text, such as Select; judge it by that name\./u,
    );
  });

  describe("named by its accessible name (ADR 0048 amendment of 2026-10-19)", () => {
    // Two buttons that both show "Select", told apart by their accessible names; the one
    // with a phone number was never offered.
    const select = {
      id: "select",
      role: "button",
      target: { by: "accessible-name", value: "Select Password." },
      label: "Select Password.",
      group: "f1",
    };
    const named = {
      ...request,
      observation: {
        ...choice,
        nearButtons: ["Password", "Mobile"],
        candidates: [select, choice.candidates[2]],
      },
    };

    it("keeps it as the password button", async () => {
      expect(
        await judgeReturning({ decision: "challenge", passwordButton: "select" }).judge(named),
      ).toEqual(
        expect.objectContaining({
          status: "ok",
          value: { decision: "challenge", password: select.target },
        }),
      );
    });

    it("drops it as a passkey button or a code's submit button", async () => {
      const passkey = await judgeReturning({
        decision: "challenge",
        passkeyButton: "select",
      }).judge(named);
      expect(passkey).toMatchObject({ status: "ok", value: { decision: "challenge" } });
      expect(passkey.status === "ok" && "passkey" in passkey.value).toBe(false);
      const code = {
        id: "code",
        role: "text",
        target: { by: "id", value: "otp" },
        autocomplete: "one-time-code",
        group: "f1",
      };
      const withCode = {
        ...named,
        observation: {
          ...named.observation,
          nearButtons: undefined,
          candidates: [code, select],
        },
      };
      expect(
        await judgeReturning({
          decision: "challenge",
          code: { field: "code", submit: "select", source: "authenticator-app" },
        }).judge(withCode),
      ).toEqual(
        expect.objectContaining({
          status: "ok",
          value: { decision: "challenge", totpDropped: "name-locator" },
        }),
      );
    });
  });
});

describe("optional page after the sign-in (ADR 0065)", () => {
  // A synthetic page shown after the sign-in that asks to check two-factor settings and can
  // be put off.
  const checkup = {
    ...signedIn,
    path: "/checkup",
    title: "Verify your two-factor settings",
    headings: ["Verify your two-factor authentication settings"],
    candidates: [
      { id: "verify", role: "button", target: { by: "id", value: "verify" }, label: "Verify now" },
      {
        id: "later",
        role: "button",
        target: { by: "id", value: "later" },
        label: "Remind me later",
      },
    ],
  };
  const optional = { ...request, observation: checkup };
  const withField = (field: Record<string, unknown>) => ({
    ...optional,
    observation: {
      ...checkup,
      candidates: [...checkup.candidates, { target: { by: "id", value: "f" }, ...field }],
    },
  });

  it("passes an optional page through, logged without any element", async () => {
    const outcome = await judgeReturning({ decision: "optional" }).judge(optional);
    expect(outcome).toMatchObject({ status: "ok", value: { decision: "optional" } });
    expect(outcome.answer).toEqual({ decision: "optional" });
  });

  it.each([
    ["a password field", { id: "pw", role: "password", label: "Password" }],
    ["a username field", { id: "user", role: "email", autocomplete: "username" }],
    ["a one-time-code field", { id: "otp", role: "text", autocomplete: "one-time-code" }],
    ["a numeric code field", { id: "otp", role: "text", inputMode: "numeric", maxLength: 6 }],
    ["a plain email field", { id: "mail", role: "email", label: "Recovery email" }],
    ["a phone field", { id: "phone", role: "tel", label: "Phone number" }],
    ["a text field", { id: "answer", role: "text", label: "Your answer" }],
  ])("reads an optional answer on a page with %s as a challenge", async (_name, field) => {
    const outcome = await judgeReturning({ decision: "optional" }).judge(withField(field));
    expect(outcome).toMatchObject({ status: "ok", value: { decision: "challenge" } });
    // The log keeps the model's own answer.
    expect(outcome.answer).toEqual({ decision: "optional" });
  });

  it.each([
    ["by its label", { label: "Search" }],
    ["by its placeholder", { placeholder: "サイト内検索" }],
    ["by its input mode", { inputMode: "search" }],
  ])("keeps an optional page with a search box %s optional", async (_name, extra) => {
    const field = { id: "q", role: "text", ...extra };
    expect(await judgeReturning({ decision: "optional" }).judge(withField(field))).toMatchObject({
      status: "ok",
      value: { decision: "optional" },
    });
  });

  it("tells the model what such a page is and what stays a challenge", () => {
    expect(completionInstructions).toMatch(
      /A page shown after the sign-in whose content is only an offer or reminder the person may put off, .* is optional, not a challenge and not signed-in, but only when the person is already signed in and could reach the account without acting on the page\./u,
    );
    expect(completionInstructions).toMatch(
      /A page that asks for a choice of how to sign in, a password, a code, a CAPTCHA, an approval on another device, a confirmation of the sign-in or another step before the account opens is a challenge, never optional, and so is a security notice about this sign-in, .* even one with Dismiss\./u,
    );
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
      /A challenge that asks for a code always fills code: its field, source and submit, which is left out only when no button on the page submits the code/u,
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

  registerCodeFieldCases({
    signedIn,
    request,
    judgeReturning,
    field,
    submit,
    judged,
    answer,
    kept,
    hasTotp,
  });

  describe("a text input without a maxlength (ADR 0027 amendments of 2026-11-07 and 2026-11-08)", () => {
    // HCP Cloud's /u/mfa-otp-challenge (2026-11-07 16:29 UTC): one text input `#code`,
    // `inputmode="numeric"`, `autocomplete="off"`, no `maxlength`, "Enter your one-time code".
    const hcp = field({ maxLength: undefined, autocomplete: "off" });

    registerUnboundedCodeCases({ field, submit, judged, answer, kept, hcp });
  });

  registerCodeGroupingCases({ field, submit, judged, answer, kept, hasTotp });

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

    registerSplitCodeCases({ field, submit, judged, answer, hasTotp, boxes, first });

    // Slack's two-factor page (#916): six one-digit inputs and no button; the page submits
    // the code once its last digit is in.
    describe("a page that shows no button for the code (ADR 0027 amendment of 2026-10-23)", () => {
      const noSubmit = (code: Record<string, unknown> = {}) => {
        const { submit: _, ...rest } = answer(code).code;
        return { decision: "challenge", code: rest };
      };

      registerSubmitlessCodeCases({ field, submit, judged, hasTotp, boxes, noSubmit });
    });

    describe("inputs that declare no maxlength (ADR 0027 amendment of 2026-11-07)", () => {
      // Epic Games' /id/login/mfa (2026-11-07 16:26 UTC): six text inputs code-input-0 to
      // code-input-5, each `inputmode="numeric"` and `autocomplete="one-time-code"`, none
      // with a `maxlength`.
      const epic = boxes(6, { maxLength: undefined, autocomplete: "one-time-code" });

      registerUnboundedSplitCodeCases({ field, submit, judged, answer, hasTotp, first, epic });
    });

    registerSplitCodeFormCases({ submit, judged, answer, hasTotp, boxes });
  });

  registerCodeAnswerValidationCases({
    signedIn,
    request,
    judgeReturning,
    field,
    submit,
    key,
    judged,
    answer,
    kept,
    hasTotp,
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

// ADR 0061: a page that still shows the sign-in form Pateat filled, beside another form
// that asks for a detail, as a lightbox over the sign-in sidebar. Synthetic page.
describe("sign-in judge beside the sign-in form", () => {
  const besidePage = {
    version: 1,
    origin: "https://card.example",
    path: "/members/",
    language: "en",
    complete: true,
    candidates: [
      { id: "c1", role: "text", target: { by: "id", value: "user" }, label: "ID", group: "g1" },
      {
        id: "c2",
        role: "password",
        target: { by: "id", value: "pw" },
        label: "Password",
        group: "g1",
      },
      {
        id: "c3",
        role: "button",
        target: { by: "id", value: "login" },
        label: "Log in",
        group: "g1",
      },
      {
        id: "c4",
        role: "text",
        target: { by: "name", value: "birth" },
        label: "Birth year and month",
        group: "g2",
        maxLength: 6,
      },
      {
        id: "c5",
        role: "text",
        target: { by: "name", value: "phone" },
        label: "Last 4 digits of your phone",
        group: "g2",
        maxLength: 4,
      },
      {
        id: "c6",
        role: "button",
        target: { by: "id", value: "submit" },
        label: "Log in",
        group: "g2",
      },
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

  it("sends the beside instructions and keeps the other form's details", async () => {
    const { model, judge } = judgeAt({
      decision: "challenge",
      details: [
        { field: "c4", value: "birth-date", format: "yyyymm" },
        { field: "c5", value: "phone-last-4" },
      ],
      detailSubmit: "c6",
    });
    expect(
      await judge({ observation: besidePage, loginPaths: ["/members/"], beside: true }),
    ).toMatchObject({
      status: "ok",
      value: {
        decision: "challenge",
        detail: {
          fields: [
            { detail: "birth-date", format: "yyyymm", target: { by: "name", value: "birth" } },
            { detail: "phone-last-4", target: { by: "name", value: "phone" } },
          ],
          target: { by: "id", value: "submit" },
        },
      },
    });
    expect(system(model)).toEqual([completionBesideInstructions]);
    expect(completionBesideInstructions.startsWith(completionInstructions)).toBe(true);
    expect(completionBesideInstructions).toMatch(/details and detailSubmit when that other form/u);
    expect(completionBesideInstructions).not.toBe(completionStopInstructions);
  });

  it("still fails closed on a signed-in answer while the password field shows", async () => {
    const { judge } = judgeAt({ decision: "signed-in", marker: "c6" });
    expect(
      await judge({ observation: besidePage, loginPaths: ["/members/"], beside: true }),
    ).toMatchObject({ status: "failed", error: "invalid-output" });
  });

  it("never judges a page as both a stop's and beside the sign-in form", async () => {
    const { model, judge } = judgeAt({ decision: "unclear" });
    expect(
      await judge({ observation: besidePage, loginPaths: ["/members/"], beside: true, stop: true }),
    ).toMatchObject({ status: "failed", error: "invalid-request", calls: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe("personal-detail inputs on a challenge page (ADR 0061)", () => {
  // A synthetic bank page after the password that asks for the birth year and month or the
  // last four digits of the registered phone. No real site or account data.
  const birth = {
    id: "birth",
    role: "text",
    target: { by: "id", value: "birth_ym" },
    label: "Year and month of birth",
    inputMode: "numeric",
    maxLength: 6,
    group: "form-1",
  };
  const phone = {
    id: "phone",
    role: "tel",
    target: { by: "name", value: "tel_last4" },
    label: "Last 4 digits of your phone",
    maxLength: 4,
    group: "form-1",
  };
  const next = {
    id: "next",
    role: "button",
    target: { by: "id", value: "next" },
    label: "Next",
    group: "form-1",
  };
  const judged = (candidates: Record<string, unknown>[], result: Record<string, unknown>) =>
    judgeReturning(result).judge({
      ...request,
      observation: {
        ...signedIn,
        path: "/login/confirm",
        title: "Confirm it's you",
        headings: ["Enter one of the following"],
        candidates,
      },
    });
  const both = [
    { field: "birth", value: "birth-date", format: "yyyymm" },
    { field: "phone", value: "phone-last-4" },
  ];
  const answer = (details: unknown[] = both, detailSubmit = "next") => ({
    decision: "challenge",
    details,
    detailSubmit,
  });
  const kept = {
    detail: "birth-date",
    format: "yyyymm",
    target: { by: "id", value: "birth_ym" },
  };
  const keptPhone = { detail: "phone-last-4", target: { by: "name", value: "tel_last4" } };
  const hasDetail = (outcome: Awaited<ReturnType<typeof judged>>) =>
    outcome.status === "ok" && "detail" in outcome.value;

  registerPersonalDetailCases({
    birth,
    phone,
    next,
    judged,
    both,
    answer,
    kept,
    keptPhone,
    hasDetail,
  });

  describe("a value split over several inputs (owner, 2026-10-23 12:26 UTC)", () => {
    // Synthetic pages: a birth date in three selects, and a card number in four boxes.
    const select = (id: string, label?: string) => ({
      id,
      role: "select",
      target: { by: "name", value: id },
      ...(label ? { label } : {}),
      group: "form-1",
    });
    const box = (id: string, maxLength?: number) => ({
      id,
      role: "tel",
      target: { by: "name", value: id },
      ...(maxLength === undefined ? {} : { maxLength }),
      group: "form-1",
    });
    const dateSelects = [select("year", "Date of birth"), select("month"), select("day")];
    const datePage = [...dateSelects, phone, next];
    const dateAnswer = [
      { field: "year", value: "birth-date", part: "year", format: "yyyy" },
      { field: "month", value: "birth-date", part: "month", format: "m" },
      { field: "day", value: "birth-date", part: "day", format: "dd" },
    ];
    const boxes = [box("c1", 4), box("c2", 4), box("c3", 4), box("c4", 4)];
    const cardAnswer = boxes.map((entry, at) => ({
      field: entry.id,
      value: "card-number",
      part: String(at + 1),
    }));
    const name = (value: string) => ({ by: "name", value });

    registerSplitPersonalDetailCases({
      birth,
      phone,
      next,
      judged,
      both,
      answer,
      keptPhone,
      hasDetail,
      select,
      box,
      dateSelects,
      datePage,
      dateAnswer,
      boxes,
      cardAnswer,
      name,
    });
  });
});

describe("the account's slots for the judge (owner 2026-10-23)", () => {
  // A synthetic page that asks the answer to a secret question beside a member number. The
  // login item's custom fields are named otherwise. No real site or account data.
  const answerInput = {
    id: "answer",
    role: "text",
    target: { by: "name", value: "answer" },
    description: "母親の旧姓は？",
    group: "form-1",
  };
  const memberInput = {
    id: "member",
    role: "text",
    target: { by: "name", value: "member" },
    label: "Member number",
    group: "form-1",
  };
  const next = {
    id: "next",
    role: "button",
    target: { by: "id", value: "next" },
    label: "Next",
    group: "form-1",
  };
  const page = {
    ...signedIn,
    path: "/login/question",
    title: "Security question",
    headings: ["Answer your security question"],
    candidates: [answerInput, memberInput, next],
  };
  const slots = [
    {
      id: "username",
      kind: "identifier",
      description: "account username, email address or login ID",
      valueShape: { length: 8, classes: ["ascii-letter"], email: false },
    },
    { id: "password", kind: "secret", description: "account password" },
    {
      id: "custom-1",
      kind: "identifier",
      description: "value of the user's vault field named in fieldName",
      fieldName: "会員番号",
      valueShape: { length: 10, classes: ["ascii-digit"], email: false },
    },
    {
      id: "custom-2",
      kind: "hidden",
      description: "concealed value of the user's vault field named in fieldName, such as a PIN",
      fieldName: "お母さんの旧姓",
    },
  ];
  const answered = (details: unknown[]) => ({
    decision: "challenge",
    details,
    detailSubmit: "next",
  });
  const judgedWith = (result: unknown, sentSlots: unknown = slots) => {
    const { judge, sent } = judgeReturning(result);
    return {
      sent,
      outcome: judge({ observation: page, loginPaths: ["/login"], slots: sentSlots }),
    };
  };
  const answerTarget = { by: "name", value: "answer" };

  registerAccountSlotCases({ page, slots, answered, judgedWith, answerTarget });
});
