import { expect, it } from "vitest";
import { completionInstructions } from "../../src/completion";
import type { CompletionFixtures } from "../../src/completion.test";
import type { Candidate, Judge } from "./context";

type CodeContext = {
  signedIn: CompletionFixtures["signedIn"];
  request: CompletionFixtures["request"];
  judgeReturning: CompletionFixtures["judgeReturning"];
  field: (extra?: Candidate) => Candidate;
  submit: (extra?: Candidate) => Candidate;
  judged: (candidates: Candidate[], result: Candidate) => ReturnType<Judge>;
  answer: (code?: Candidate) => { decision: string; code: Candidate };
  kept: Candidate;
  hasTotp: (outcome: Awaited<ReturnType<Judge>>) => boolean;
  hcp: Candidate;
  boxes: (count: number, extra?: Candidate) => Candidate[];
  first: Candidate;
  noSubmit: (code?: Candidate) => Candidate;
  epic: Candidate[];
  key: Candidate;
};

export function registerCodeFieldCases({
  signedIn,
  request,
  judgeReturning,
  field,
  submit,
  judged,
  answer,
  kept,
  hasTotp,
}: Pick<
  CodeContext,
  | "signedIn"
  | "request"
  | "judgeReturning"
  | "field"
  | "submit"
  | "judged"
  | "answer"
  | "kept"
  | "hasTotp"
>) {
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
    expect(sent).toEqual([
      { task: "judge-sign-in", loginPaths: ["/login"], slots: [], stepElements: [], observation },
    ]);
  });
}

export function registerUnboundedCodeCases({
  field,
  submit,
  judged,
  answer,
  kept,
  hcp,
}: Pick<CodeContext, "field" | "submit" | "judged" | "answer" | "kept" | "hcp">) {
  it("keeps the code in it when the judge names it", async () => {
    expect(await judged([hcp, submit()], answer())).toMatchObject({
      status: "ok",
      value: { decision: "challenge", totp: kept },
    });
    expect(await judged([field({ maxLength: undefined }), submit()], answer())).toMatchObject({
      value: { totp: kept },
    });
  });

  it.each([
    [
      "a tel input",
      field({ role: "tel", inputMode: undefined, maxLength: undefined }),
      "not-code-field",
    ],
    [
      "a text input with inputmode tel",
      field({ inputMode: "tel", maxLength: undefined }),
      "not-code-field",
    ],
    [
      "a text input with inputmode none",
      field({ inputMode: "none", maxLength: undefined }),
      "not-code-field",
    ],
    [
      "an email input",
      field({ role: "email", inputMode: undefined, maxLength: undefined }),
      "not-code-field",
    ],
    [
      "a text input marked as a username",
      field({ inputMode: undefined, maxLength: undefined, autocomplete: "username" }),
      "not-code-field",
    ],
  ])("drops %s without a maxlength", async (_label, candidate, why) => {
    expect(await judged([candidate, submit()], answer())).toMatchObject({
      value: { totpDropped: why },
    });
  });

  it("keeps the code in a text input without inputmode when the judge names it", async () => {
    // Supabase's /dashboard/sign-in-mfa (2026-11-08 03:28 UTC, issue #1409): one text
    // input `#code`, `autocomplete="off"`, placeholder "XXXXXX", no `inputmode` or
    // `maxlength`, under "Enter the authentication code from your two-factor
    // authentication app" (ADR 0027 amendment of 2026-11-08).
    const supabase = field({
      inputMode: undefined,
      maxLength: undefined,
      autocomplete: "off",
      placeholder: "XXXXXX",
    });
    expect(await judged([supabase, submit()], answer())).toMatchObject({
      status: "ok",
      value: { decision: "challenge", totp: kept },
    });
    expect(
      await judged([field({ inputMode: "text", maxLength: undefined }), submit()], answer()),
    ).toMatchObject({ value: { totp: kept } });
  });

  it("drops a text input without inputmode beside another text input of its form", async () => {
    const code = field({ inputMode: undefined, maxLength: undefined });
    const other = field({
      id: "other",
      target: { by: "id", value: "name" },
      inputMode: undefined,
      maxLength: undefined,
    });
    expect(await judged([code, other, submit()], answer())).toMatchObject({
      value: { totpDropped: "several-code-fields" },
    });
  });

  it("drops a code input outside any form beside a plain text input outside any form", async () => {
    // Inputs outside any form count as one form (ADR 0027 amendment of 2026-11-08).
    const code = field({ maxLength: undefined, group: undefined });
    const search = field({
      id: "q",
      target: { by: "id", value: "q" },
      inputMode: undefined,
      maxLength: undefined,
      group: undefined,
    });
    expect(await judged([code, search, submit({ group: undefined })], answer())).toMatchObject({
      value: { totpDropped: "several-code-fields" },
    });
  });

  it("drops it beside another such input of its form", async () => {
    const other = field({
      id: "other",
      target: { by: "id", value: "pin" },
      maxLength: undefined,
    });
    expect(await judged([hcp, other, submit()], answer())).toMatchObject({
      value: { totpDropped: "several-code-fields" },
    });
  });

  it("still keeps a marked code field beside one", async () => {
    // Only a field taken as the judge named it counts such inputs as code inputs.
    const other = field({
      id: "other",
      target: { by: "id", value: "pin" },
      maxLength: undefined,
    });
    expect(await judged([field(), other, submit()], answer())).toMatchObject({
      value: { totp: kept },
    });
  });
}

export function registerCodeGroupingCases({
  field,
  submit,
  judged,
  answer,
  kept,
  hasTotp,
}: Pick<CodeContext, "field" | "submit" | "judged" | "answer" | "kept" | "hasTotp">) {
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
}

export function registerSplitCodeCases({
  field,
  submit,
  judged,
  answer,
  hasTotp,
  boxes,
  first,
}: Pick<CodeContext, "field" | "submit" | "judged" | "answer" | "hasTotp" | "boxes" | "first">) {
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
}

export function registerSubmitlessCodeCases({
  field,
  submit,
  judged,
  hasTotp,
  boxes,
  noSubmit,
}: Pick<CodeContext, "field" | "submit" | "judged" | "hasTotp" | "boxes" | "noSubmit">) {
  it("keeps the code's first input without a button outside any form", async () => {
    const loose = boxes(6, { group: undefined });
    // Exactly: the handler has no button.
    expect(await judged(loose, noSubmit({ field: "d3" }))).toEqual(
      expect.objectContaining({
        status: "ok",
        value: { decision: "challenge", totp: { field: { by: "id", value: "otp-1" } } },
      }),
    );
  });

  it("keeps one code input of a form that shows no button", async () => {
    expect(await judged([field()], noSubmit())).toMatchObject({
      value: { totp: { field: { by: "id", value: "otp" } } },
    });
  });

  it("drops a code without a button in a form that shows one", async () => {
    const outcome = await judged([...boxes(6), submit()], noSubmit({ field: "d1" }));
    expect(hasTotp(outcome)).toBe(false);
    expect(outcome).toMatchObject({ value: { totpDropped: "submit-unnamed" } });
    // A button outside the form does not keep the form's code from submitting itself.
    expect(
      await judged([...boxes(6), submit({ group: undefined })], noSubmit({ field: "d1" })),
    ).toMatchObject({ value: { totp: { field: { by: "id", value: "otp-1" } } } });
  });

  it("still drops a code sent to the person", async () => {
    const outcome = await judged(boxes(6, { group: undefined }), noSubmit({ source: "sms" }));
    expect(hasTotp(outcome)).toBe(false);
  });

  it("tells the model when to leave submit out", () => {
    expect(completionInstructions).toContain("left out only when no button on the page submits");
  });
}

export function registerUnboundedSplitCodeCases({
  field,
  submit,
  judged,
  answer,
  hasTotp,
  first,
  epic,
}: Pick<CodeContext, "field" | "submit" | "judged" | "answer" | "hasTotp" | "first" | "epic">) {
  it.each(["d1", "d4"])("keeps the first of six such inputs when %s is named", async (named) => {
    expect(await judged([...epic, submit()], answer({ field: named }))).toMatchObject({
      status: "ok",
      value: { decision: "challenge", totp: first },
    });
  });

  it("keeps them when only the first is marked, as on Notion's page", async () => {
    const notion = epic.map((box, index) => (index === 0 ? box : { ...box, autocomplete: "off" }));
    expect(await judged([...notion, submit()], answer({ field: "d3" }))).toMatchObject({
      value: { totp: first },
    });
  });

  it.each([
    [
      "the first is not marked as a one-time code",
      epic.map((box, index) => (index === 0 ? { ...box, autocomplete: undefined } : box)),
    ],
    [
      "the first declares a maxlength of 6",
      epic.map((box, index) => (index === 0 ? { ...box, maxLength: 6 } : box)),
    ],
    [
      "one is an input without a numeric keyboard",
      epic.map((box, index) =>
        index === 3 ? { ...box, inputMode: undefined, autocomplete: undefined } : box,
      ),
    ],
    [
      "an email input sits in their form",
      [...epic, field({ id: "mail", role: "email", target: { by: "id", value: "mail" } })],
    ],
    ["there are five", epic.slice(0, 5)],
  ])("drops them when %s", async (_label, candidates) => {
    expect(hasTotp(await judged([...candidates, submit()], answer({ field: "d1" })))).toBe(false);
  });
}

export function registerSplitCodeFormCases({
  submit,
  judged,
  answer,
  hasTotp,
  boxes,
}: Pick<CodeContext, "submit" | "judged" | "answer" | "hasTotp" | "boxes">) {
  it("drops a split code whose button is in another form", async () => {
    expect(
      hasTotp(await judged([...boxes(6), submit({ group: "form-2" })], answer({ field: "d1" }))),
    ).toBe(false);
  });
}

export function registerCodeAnswerValidationCases({
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
}: Pick<
  CodeContext,
  | "signedIn"
  | "request"
  | "judgeReturning"
  | "field"
  | "submit"
  | "key"
  | "judged"
  | "answer"
  | "kept"
  | "hasTotp"
>) {
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
}
