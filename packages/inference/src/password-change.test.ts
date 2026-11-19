import {
  builtInLoginSlots,
  type LoginObservation,
  type ObservedCandidate,
} from "@pateat/contracts";
import { toJsonSchema } from "@valibot/to-json-schema";
import { describe, expect, it } from "vitest";
import { createRecipeGenerator, generatedPlanSchema, generationInstructions } from "./generation";
import { passwordChangeForm, verificationPlanRejection } from "./password-change";
import { validateGeneratedPage } from "./plan";
import { textModel, textResult } from "./testing/fake-models";

// Synthetic pages only (ADR 0033): a signed-in account form that saves its changes with
// the current password beside new and confirmation password fields, as the owner decided
// on 2026-11-19 (ADR 0035), and forms that set a new password without the current one.

const field = (
  id: string,
  role: ObservedCandidate["role"],
  label?: string,
  extra: Partial<ObservedCandidate> = {},
): ObservedCandidate => ({
  id,
  role,
  target: { by: "id", value: id },
  ...(label === undefined ? {} : { label }),
  group: "f1",
  ...extra,
});
const page = (candidates: ObservedCandidate[]): LoginObservation => ({
  version: 1,
  origin: "https://account.example.test",
  path: "/account",
  language: "en",
  complete: true,
  candidates,
});
/** Account details with three password inputs, labelled as many account forms are. */
const account = page([
  field("email", "email", "Email", { autocomplete: "email" }),
  field("current", "password", "Current Password (required)"),
  field("new", "password", "New Password"),
  field("again", "password", "Confirm New Password"),
  field("first", "text", "First Name", { autocomplete: "given-name" }),
  field("save", "button", "Update My Account"),
]);
const slots = [builtInLoginSlots.username, builtInLoginSlots.password];
const set = (fields: [string, string][], action = "save") => ({
  fields: fields.map(([slot, candidate]) => ({ slot, candidate })),
  action: { candidate: action, purpose: "submit" as const },
});
const verify = (observation: LoginObservation, fields: [string, string][], action = "save") => {
  const validated = validateGeneratedPage(observation, slots, set(fields, action));
  if (!validated.ok) throw new Error(validated.reason);
  return verificationPlanRejection(observation, slots, validated.plan);
};

describe("forms that also set a new password (ADR 0035, 2026-11-19)", () => {
  it("finds the current password input by its mark, its words or its place", () => {
    expect(passwordChangeForm(account, "f1")).toEqual({ current: "current" });
    // Marks win over words and places: the input marked `current-password` is current,
    // also when it comes last.
    expect(
      passwordChangeForm(
        page([
          field("a", "password", "New password", { autocomplete: "new-password" }),
          field("b", "password", "Repeat", { autocomplete: "new-password" }),
          field("c", "password", "Password", { autocomplete: "current-password" }),
        ]),
        "f1",
      ),
    ).toEqual({ current: "c" });
    // Locators read as words, so unlabelled inputs named CurrentPassword and NewPassword count.
    expect(
      passwordChangeForm(
        page([
          field("NewPassword", "password"),
          field("ConfirmNewPassword", "password"),
          field("CurrentPassword", "password"),
        ]),
        "f1",
      ),
    ).toEqual({ current: "CurrentPassword" });
    // Japanese labels.
    expect(
      passwordChangeForm(
        page([
          field("p1", "password", "現在のパスワード"),
          field("p2", "password", "新しいパスワード"),
          field("p3", "password", "新しいパスワード（確認用）"),
        ]),
        "f1",
      ),
    ).toEqual({ current: "p1" });
    // Three password inputs without words: the first is the current one.
    expect(
      passwordChangeForm(
        page([field("p1", "password"), field("p2", "password"), field("p3", "password")]),
        "f1",
      ),
    ).toEqual({ current: "p1" });
    // Two inputs, the second naming a new password: the first is the current one.
    expect(
      passwordChangeForm(
        page([field("p1", "password", "Password"), field("p2", "password", "New password")]),
        "f1",
      ),
    ).toEqual({ current: "p1" });
  });

  it("finds no current password on a reset form", () => {
    // A new password and its confirmation, marked or only labelled so.
    for (const extra of [{ autocomplete: "new-password" as const }, {}])
      expect(
        passwordChangeForm(
          page([
            field("p1", "password", "New password", extra),
            field("p2", "password", "Confirm new password", extra),
            field("go", "button", "Reset password"),
          ]),
          "f1",
        ),
      ).toEqual({ current: undefined });
    // Two inputs read as current: no one of them is.
    expect(
      passwordChangeForm(
        page([
          field("p1", "password", "Current password"),
          field("p2", "password", "Old password"),
          field("p3", "password", "New password"),
        ]),
        "f1",
      ),
    ).toEqual({ current: undefined });
  });

  it("leaves other forms alone", () => {
    // One password input, labelled as a confirmation or not.
    expect(passwordChangeForm(page([field("p", "password", "Confirm password")]), "f1")).toBe(
      undefined,
    );
    // Two password inputs without new-password words or marks, as a sign-in password beside
    // a confirmation code, or a sign-up's password and its confirmation.
    expect(
      passwordChangeForm(
        page([
          field("p1", "password", "Login password"),
          field("p2", "password", "確認用パスワード"),
        ]),
        "f1",
      ),
    ).toBe(undefined);
    // Another form's inputs do not count.
    expect(passwordChangeForm(account, "f2")).toBe(undefined);
    expect(passwordChangeForm(account, undefined)).toBe(undefined);
  });

  it("lets a verification fill only the current password", () => {
    expect(verify(account, [["password", "current"]])).toBe(undefined);
    for (const fields of [
      [["password", "new"]],
      [["password", "again"]],
      [
        ["username", "email"],
        ["password", "current"],
      ],
    ] as [string, string][][])
      expect(verify(account, fields)).toBe("password-change-field");
    // A reset form has no current password, so no password goes in.
    const reset = page([
      field("p1", "password", "New password"),
      field("p2", "password", "Confirm new password"),
      field("go", "button", "Reset password"),
    ]);
    expect(verify(reset, [["password", "p1"]], "go")).toBe("password-change-field");
  });

  it("leaves verifications on other forms to the usual checks", () => {
    const transfer = page([
      field("p1", "password", "Login password"),
      field("p2", "password", "Transaction password"),
      field("go", "button", "Transfer"),
    ]);
    expect(verify(transfer, [["password", "p2"]], "go")).toBe(undefined);
    const again = page([field("p", "password", "Password"), field("go", "button", "Continue")]);
    expect(verify(again, [["password", "p"]], "go")).toBe(undefined);
  });
});

describe("generated plans on such a form", () => {
  it("tells the model to answer confirm with the current password and to abstain on a reset", () => {
    expect(generationInstructions).toContain(
      "only once the current password is entered is confirm: map the secret to the current " +
        "password field alone, never to a new or confirmation password field, and fill no " +
        "other field.",
    );
    expect(generationInstructions).toContain(
      "A form that sets a new password without asking for the current one, such as a " +
        "password reset, is no login form: abstain.",
    );
    const format = JSON.stringify(toJsonSchema(generatedPlanSchema));
    expect(format).toContain("one that sets a new password without asking for the current one");
    expect(format).toContain("the current password a form asks for before it saves changes");
    // A password-change form is no longer named as a whole as no login form.
    expect(format).not.toContain("sign-up or password-change form");
  });

  const generate = (pageKind: string, fields: [string, string][]) =>
    createRecipeGenerator({
      model: textModel(async () =>
        textResult(
          JSON.stringify({
            result: { decision: "plan", pageKind, irreversible: "yes", ...set(fields) },
          }),
        ),
      ),
      limits: { timeoutMs: 1_000, maxInputBytes: 16_384 },
      maxOutputTokens: 512,
    })({ observation: account, slots });

  it("keeps a confirm plan that fills the current password alone", async () => {
    for (const pageKind of ["confirm", "unclear"]) {
      // oxlint-disable-next-line no-await-in-loop -- Each kind is checked on its own.
      const outcome = await generate(pageKind, [["password", "current"]]);
      expect(outcome).toMatchObject({
        status: "ok",
        value: {
          pageKind,
          fields: [{ slot: "password", candidate: "current" }],
          steps: [
            {
              kind: "fill",
              fields: [{ slot: "password", target: { by: "id", value: "current" } }],
            },
            { kind: "click", target: { by: "id", value: "save" }, purpose: "submit" },
          ],
        },
      });
    }
  });

  it("refuses a confirm or unclear plan that fills a new password or another field", async () => {
    for (const pageKind of ["confirm", "unclear"])
      for (const fields of [
        [["password", "new"]],
        [["password", "again"]],
        [
          ["username", "email"],
          ["password", "current"],
        ],
      ] as [string, string][][]) {
        // oxlint-disable-next-line no-await-in-loop -- Each answer is checked on its own.
        const outcome = await generate(pageKind, fields);
        expect(outcome).toMatchObject({
          status: "failed",
          error: "invalid-output",
          detail: "password-change-field",
          // The request log keeps the refused answer's references.
          output: {
            result: { pageKind, fields: fields.map(([slot, candidate]) => ({ slot, candidate })) },
          },
        });
      }
  });

  it("leaves a sign-in plan to the sign-in checks", async () => {
    // Unchanged for sign-in pages: this check is the verification's own.
    expect(await generate("sign-in", [["password", "current"]])).toMatchObject({
      status: "ok",
      value: { pageKind: "sign-in" },
    });
  });
});
