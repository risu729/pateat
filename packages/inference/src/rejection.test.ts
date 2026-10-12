import {
  builtInLoginSlots,
  customFieldSlotDescriptions,
  type LoginObservation,
  type SemanticSlot,
} from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { createRecipeGenerator } from "./generation";
import { outputRejection } from "./outcome";
import { textModel, textResult } from "./testing/fake-models";

// Why generated output was refused, on a synthetic page shaped like a securities sign-in:
// one form with an identifier, a password input marked `new-password` (some sites mark
// their sign-in password so to stop browser autofill), a software-keyboard button, the
// sign-in button, a help link and a phone-sign-in button.

const button = (id: string, label: string) =>
  ({ id, role: "button", target: { by: "id", value: id }, label, group: "f1" }) as const;
const observation: LoginObservation = {
  version: 1,
  origin: "https://broker.example.test",
  path: "/login",
  language: "ja",
  complete: true,
  candidates: [
    {
      id: "c1",
      role: "text",
      target: { by: "id", value: "user" },
      label: "ユーザーネーム",
      autocomplete: "username",
      group: "f1",
    },
    {
      id: "c2",
      role: "password",
      target: { by: "id", value: "pass" },
      label: "パスワード",
      autocomplete: "new-password",
      group: "f1",
    },
    button("c3", "ソフトウェアキーボード"),
    button("c4", "ログイン"),
    { id: "c5", role: "link", target: { by: "id", value: "help" }, label: "ヘルプ", group: "f1" },
    button("c6", "電話番号認証"),
  ],
};
const slots: SemanticSlot[] = [
  builtInLoginSlots.username,
  builtInLoginSlots.password,
  {
    id: "custom-1",
    kind: "hidden",
    description: customFieldSlotDescriptions.hidden,
    fieldName: "取引暗証番号",
  },
  {
    id: "custom-2",
    kind: "identifier",
    description: customFieldSlotDescriptions.identifier,
    fieldName: "Email",
  },
];

const generate = (text: string) =>
  createRecipeGenerator({
    model: textModel(async () => textResult(text)),
    limits: { timeoutMs: 1_000, maxInputBytes: 64 * 1024 },
    maxOutputTokens: 512,
  })({ observation, slots });
const answer = (result: Record<string, unknown>) =>
  generate(JSON.stringify({ result: { decision: "plan", ...result } }));
const field = (slot: string, candidate: string, name?: string) => ({
  slot,
  candidate,
  ...(name === undefined ? {} : { name }),
});
const signIn = { candidate: "c4", purpose: "submit" };

describe("refused generated output", () => {
  it("says the plan check refused a password for a lone new-password input", async () => {
    // The sign-in form's lone new-password field takes a password beside the identifier
    // (ADR 0018, 2026-10-12), but not without one.
    const fields = [field("password", "c2")];
    const outcome = await answer({ fields, action: signIn });
    expect(outcome).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail: "lone-new-password",
      output: { result: { fields, action: signIn } },
    });
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outputRejection(outcome)).toEqual({ check: "plan", reason: "lone-new-password" });
    // A password in the identifier input is refused for its role.
    expect(await answer({ fields: [field("password", "c1")], action: signIn })).toMatchObject({
      detail: "incompatible-role",
    });
    // With an identifier, the password or a Hidden custom field passes.
    const others = await Promise.all(
      [
        [field("username", "c1"), field("password", "c2")],
        [field("username", "c1"), field("custom-1", "c2", "trading-pin")],
        [field("custom-2", "c1", "email-address"), field("password", "c2")],
      ].map((plan) => answer({ fields: plan, action: signIn })),
    );
    for (const other of others) expect(other).toMatchObject({ status: "ok" });
  });

  it("keeps only references the request holds in a refused plan", async () => {
    const outcome = await answer({
      fields: [field("username", "c1"), field("custom-1", "c3", "取引暗証番号")],
      action: { candidate: "ログイン", purpose: "submit" },
      accountSwitch: "c5",
      alternatives: [{ fields: [field("phone", "c6")], action: signIn }],
      passkeyButton: "電話番号認証",
    });
    expect(outcome).toMatchObject({ status: "failed", error: "invalid-output" });
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outcome.output).toEqual({
      result: {
        fields: [field("username", "c1"), field("custom-1", "c3", "name-1")],
        action: { candidate: "?", purpose: "submit" },
        accountSwitch: "c5",
        alternatives: [{ fields: [field("?", "c6")], action: signIn }],
        passkeyButton: "?",
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/取引|ログイン|電話|phone/u);
  });

  it("replaces each name the model gave by a placeholder, keeping equal names equal", async () => {
    // Two requested slots under one name, and a name repeated in an alternative.
    const outcome = await answer({
      fields: [
        field("custom-1", "c2", "trading-pin"),
        field("custom-2", "c1", "trading-pin"),
        field("username", "c1", "username"),
      ],
      action: signIn,
      alternatives: [
        {
          fields: [field("custom-2", "c1", "取引暗証番号"), field("custom-1", "c2", "trading-pin")],
          action: signIn,
        },
      ],
      passkeyButton: "c6",
    });
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outcome.output).toEqual({
      result: {
        fields: [
          field("custom-1", "c2", "name-1"),
          field("custom-2", "c1", "name-1"),
          // A request slot ID is a reference the request holds.
          field("username", "c1", "username"),
        ],
        action: signIn,
        alternatives: [
          {
            fields: [field("custom-2", "c1", "name-2"), field("custom-1", "c2", "name-1")],
            action: signIn,
          },
        ],
        // A candidate of the request stays, whatever it is.
        passkeyButton: "c6",
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/trading|取引/u);
  });

  it.each([
    ["text that is not JSON", "ログインしてください", { check: "json" }],
    [
      "too many alternatives",
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [field("username", "c1")],
          action: signIn,
          alternatives: Array.from({ length: 4 }, () => ({
            fields: [field("username", "c1")],
            action: signIn,
          })),
        },
      }),
      { check: "schema", issue: "max-length", path: "result.alternatives" },
    ],
    [
      "a key the format does not define",
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [{ ...field("username", "c1"), ユーザーネーム: "c1" }],
          action: signIn,
        },
      }),
      { check: "schema", issue: "unknown-key", path: "result.fields.0" },
    ],
    [
      "a key the format defines only elsewhere",
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [{ ...field("username", "c1"), purpose: "submit" }],
          action: signIn,
        },
      }),
      { check: "schema", issue: "unknown-key", path: "result.fields.0" },
    ],
    [
      "an alternative's field past the length limit",
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [field("username", "c1")],
          action: signIn,
          alternatives: [{ fields: [field("username", "ユーザー".repeat(20))], action: signIn }],
        },
      }),
      { check: "schema", issue: "max-length", path: "result.alternatives.0.fields.0.candidate" },
    ],
    [
      "an action purpose outside the list",
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [field("username", "c1")],
          action: { candidate: "c4", purpose: "ログイン" },
        },
      }),
      { check: "schema", issue: "picklist", path: "result.action.purpose" },
    ],
    [
      "an account switch past the length limit",
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [field("username", "c1")],
          action: signIn,
          accountSwitch: "別のアカウント".repeat(10),
        },
      }),
      { check: "schema", issue: "max-length", path: "result.account-switch" },
    ],
    ["a missing key", "{}", { check: "schema", issue: "strict-object", path: "result" }],
  ])("names the format check that refused %s", async (_name, text, rejection) => {
    const outcome = await generate(text);
    expect(outcome).toMatchObject({ status: "failed", error: "invalid-output" });
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outcome).not.toHaveProperty("detail");
    expect(outcome).not.toHaveProperty("output");
    expect(outputRejection(outcome)).toEqual(rejection);
    expect(JSON.stringify(outcome)).not.toMatch(/ログイン|ユーザー|アカウント/u);
  });

  it("names nothing for other failures", () => {
    expect(outputRejection({ error: "timeout" })).toBeUndefined();
    expect(outputRejection({ error: "invalid-output" })).toBeUndefined();
    expect(
      outputRejection({
        error: "invalid-output",
        schemaIssue: { check: "schema", issue: "Invalid key", path: "" },
      }),
    ).toBeUndefined();
  });
});
