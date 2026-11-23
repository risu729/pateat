import {
  builtInLoginSlots,
  type LoginObservation,
  type ObservedCandidate,
} from "@pateat/contracts";
import { toJsonSchema } from "@valibot/to-json-schema";
import { describe, expect, it } from "vitest";
import { createRecipeGenerator, generatedPlanSchema, generationInstructions } from "./generation";
import {
  passwordChangeForm,
  readsAsPasswordChange,
  signInPlanRejection,
  verificationPlanRejection,
} from "./password-change";
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
    // Three password inputs, one naming the current password and none a new one.
    expect(
      passwordChangeForm(
        page([
          field("p1", "password", "Current password"),
          field("p2", "password", "Password"),
          field("p3", "password", "Password again"),
        ]),
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

  it("reads a label above a placeholder that mentions the current password", () => {
    for (const [current, fresh, hint, again] of [
      [
        "Current password",
        "New password",
        "Must differ from your current password",
        "Confirm new password",
      ],
      [
        "現在のパスワード",
        "新しいパスワード",
        "現在のパスワードと異なるもの",
        "新しいパスワード（確認）",
      ],
    ]) {
      const form = page([
        field("p1", "password", current),
        field("p2", "password", fresh, { placeholder: hint! }),
        field("p3", "password", again),
        field("save", "button", "Save"),
      ]);
      expect(passwordChangeForm(form, "f1")).toEqual({ current: "p1" });
      expect(verify(form, [["password", "p2"]])).toBe("password-change-field");
      // Two inputs are such a form too, as the new one names a new password.
      const two = page([
        field("p1", "password", current),
        field("p2", "password", fresh, { placeholder: hint! }),
      ]);
      expect(passwordChangeForm(two, "f1")).toEqual({ current: "p1" });
      // A placeholder alone that sets the password apart from the current one reads new.
      const hinted = page([
        field("p1", "password", undefined, { placeholder: current! }),
        field("p2", "password", undefined, { placeholder: hint! }),
        field("p3", "password", undefined, { placeholder: again! }),
      ]);
      expect(passwordChangeForm(hinted, "f1")).toEqual({ current: "p1" });
      // Also with two inputs, where only the hint tells the new one apart.
      const hintOnly = page([
        field("p1", "password", current),
        field("p2", "password", undefined, { placeholder: hint! }),
      ]);
      expect(passwordChangeForm(hintOnly, "f1")).toEqual({ current: "p1" });
    }
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

  it("finds no current password labelled only Password after the new ones", () => {
    // A known gap: such a form is refused rather than guessed (ADR 0035).
    const last = page([
      field("p1", "password", "New password"),
      field("p2", "password", "Confirm new password"),
      field("p3", "password", "Password"),
      field("save", "button", "Save"),
    ]);
    expect(passwordChangeForm(last, "f1")).toEqual({ current: undefined });
    expect(verify(last, [["password", "p3"]])).toBe("password-change-field");
  });

  it("leaves three password inputs without new or current words alone", () => {
    for (const labels of [
      ["ログインパスワード", "暗証番号", "第2暗証番号"],
      ["Password", "PIN", "Security code"],
      [undefined, undefined, undefined],
    ]) {
      const transfer = page([
        ...labels.map((label, index) => field(`p${index + 1}`, "password", label)),
        field("go", "button", "Transfer"),
      ]);
      expect(passwordChangeForm(transfer, "f1")).toBe(undefined);
      expect(verify(transfer, [["password", "p2"]], "go")).toBe(undefined);
    }
  });

  it("does not read 更新 as a new password", () => {
    expect(
      passwordChangeForm(
        page([field("p1", "password", "パスワード"), field("p2", "password", "更新パスワード")]),
        "f1",
      ),
    ).toBe(undefined);
    expect(
      passwordChangeForm(
        page([field("p1", "password", "パスワード"), field("p2", "password", "新パスワード")]),
        "f1",
      ),
    ).toEqual({ current: "p1" });
  });

  it("fills no identifier into a new email beside the current password", () => {
    for (const label of ["New email", "新しいメールアドレス", "新メールアドレス"]) {
      const email = page([
        field("mail", "email", label),
        field("pw", "password", "Current password"),
        field("go", "button", "Change email"),
      ]);
      expect(verify(email, [["password", "pw"]], "go")).toBe(undefined);
      expect(
        verify(
          email,
          [
            ["username", "mail"],
            ["password", "pw"],
          ],
          "go",
        ),
      ).toBe("password-change-field");
    }
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

  it("refuses a sign-in plan on a form that reads as changing the password", async () => {
    // Its button would save the account's changes, and a sign-in presses it.
    expect(await generate("sign-in", [["password", "current"]])).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail: "password-change-form",
    });
    // Marks alone are not words: an unlabelled form marked current and new.
    const marked = page([
      field("p1", "password", undefined, { autocomplete: "current-password" }),
      field("p2", "password", undefined, { autocomplete: "new-password" }),
      field("save", "button", "Save"),
    ]);
    expect(signInPlanRejection(marked, set([["password", "p1"]]))).toBe(undefined);
    expect(readsAsPasswordChange(account, "f1")).toBe(true);
  });

  it("keeps a sign-in plan on one page-wide form with a sign-in and a registration", () => {
    const both = page([
      field("login-user", "text", "Username", { autocomplete: "username" }),
      field("login-pass", "password", "Password", { autocomplete: "current-password" }),
      field("login", "button", "Sign in"),
      field("reg-email", "email", "Email"),
      field("reg-pass", "password", "Password", { autocomplete: "new-password" }),
      field("reg-again", "password", "Confirm password", { autocomplete: "new-password" }),
      field("register", "button", "Create account"),
    ]);
    const plan = validateGeneratedPage(
      both,
      slots,
      set(
        [
          ["username", "login-user"],
          ["password", "login-pass"],
        ],
        "login",
      ),
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(readsAsPasswordChange(both, "f1")).toBe(false);
    expect(signInPlanRejection(both, plan.plan)).toBe(undefined);
  });
});

describe("a custom field in a page's password input (ADR 0035, 2026-11-22 and 2026-11-23)", () => {
  // A synthetic verification whose heading names a club and whose only input says
  // "Password:", with a hidden custom field named after the club beside the password.
  const pin = {
    id: "custom-1",
    kind: "hidden",
    description: "concealed value of the user's vault field named in fieldName, such as a PIN",
    fieldName: "Club password",
  } as const;
  const requested = [builtInLoginSlots.username, builtInLoginSlots.password, pin];
  const verification = (label: string, extra: ObservedCandidate[] = []) => ({
    ...page([field("secret", "password", label), ...extra, field("go", "button", "Continue")]),
    headings: ["Enter your Example Club password"],
  });
  const generate = (
    pageKind: string,
    observation: LoginObservation,
    fields: [string, string][],
    startPage = true,
    passwordFilled?: boolean,
  ) =>
    createRecipeGenerator({
      model: textModel(async () =>
        textResult(
          JSON.stringify({
            result: { decision: "plan", pageKind, irreversible: "no", ...set(fields, "go") },
          }),
        ),
      ),
      limits: { timeoutMs: 1_000, maxInputBytes: 16_384 },
      maxOutputTokens: 512,
    })({
      observation,
      slots: requested,
      startPage,
      ...(passwordFilled === undefined ? {} : { passwordFilled }),
    });
  const filled = async (outcome: ReturnType<typeof generate>) => {
    const result = await outcome;
    if (result.status !== "ok" || !("fields" in result.value)) throw new Error(result.status);
    return result.value.fields.map((entry) => [entry.slot, entry.candidate]);
  };

  it("fills the account's password where the input does not name the field", async () => {
    const kinds = ["sign-in", "confirm", "unclear"];
    const plans = await Promise.all(
      kinds.map((pageKind) =>
        filled(generate(pageKind, verification("Password:"), [["custom-1", "secret"]])),
      ),
    );
    expect(plans).toEqual(kinds.map(() => [["password", "secret"]]));
  });

  it.each(["sign-in", "confirm"])(
    "reads Japanese labels as Bitwarden would on a %s page, never the heading",
    async (pageKind) => {
      // A synthetic page shaped as ANA's of 2026-11-22: the heading names the club's
      // password, the input says only パスワード, and the custom field is named after the club.
      const club = {
        ...page([field("pass", "password", "パスワード：", { maxLength: 20 })]),
        headings: ["クラブのパスワードを入力してください。"],
      };
      const named = { ...pin, fieldName: "クラブパスワード" };
      const outcome = await createRecipeGenerator({
        model: textModel(async () =>
          textResult(
            JSON.stringify({
              result: {
                decision: "plan",
                pageKind,
                irreversible: "no",
                fields: [{ slot: "custom-1", candidate: "pass" }],
                action: { candidate: "pass", purpose: "submit" },
              },
            }),
          ),
        ),
        limits: { timeoutMs: 1_000, maxInputBytes: 16_384 },
        maxOutputTokens: 512,
      })({ observation: club, slots: [builtInLoginSlots.password, named] });
      expect(outcome).toMatchObject({
        status: "ok",
        value: { fields: [{ slot: "password", candidate: "pass" }] },
      });
    },
  );

  it("keeps the field in an input shaped for a PIN or described by its name", async () => {
    const shaped = (extra: Partial<ObservedCandidate>) => ({
      ...verification("Password:"),
      candidates: [
        field("secret", "password", "Password:", extra),
        field("go", "button", "Continue"),
      ],
    });
    const plans = await Promise.all(
      [
        { maxLength: 4 },
        { inputMode: "numeric" as const },
        { description: "Your club password" },
      ].map((extra) => filled(generate("confirm", shaped(extra), [["custom-1", "secret"]]))),
    );
    expect(plans).toEqual(plans.map(() => [["custom-1", "secret"]]));
  });

  it("keeps a continuation page's slots after a page that fills the password", async () => {
    expect(
      await filled(
        generate("sign-in", verification("Password:"), [["custom-1", "secret"]], false, true),
      ),
    ).toEqual([["custom-1", "secret"]]);
  });

  it("fills the password on a continuation page when no earlier page does, or none is known", async () => {
    for (const passwordFilled of [false, undefined])
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Each case is generated on its own.
        await filled(
          generate(
            "sign-in",
            verification("Password:"),
            [["custom-1", "secret"]],
            false,
            passwordFilled,
          ),
        ),
      ).toEqual([["password", "secret"]]);
  });

  it("keeps the field in a sign-in input that does not read as a password", async () => {
    // A PIN input the page checks only by script, as 「暗証番号」 beside a field named
    // 「キャッシュカード暗証番号」; a verification still fills the password there.
    const pinInput = { ...verification("暗証番号"), headings: [] };
    expect(await filled(generate("sign-in", pinInput, [["custom-1", "secret"]]))).toEqual([
      ["custom-1", "secret"],
    ]);
    // A password the input qualifies as another secret, even marked as the current one.
    for (const label of ["取引パスワード", "第2パスワード", "Transaction password"])
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Each label is generated on its own.
        await filled(
          generate(
            "sign-in",
            {
              ...page([
                field("secret", "password", label, { autocomplete: "current-password" }),
                field("go", "button", "Continue"),
              ]),
            },
            [["custom-1", "secret"]],
          ),
        ),
      ).toEqual([["custom-1", "secret"]]);
    expect(await filled(generate("confirm", pinInput, [["custom-1", "secret"]]))).toEqual([
      ["password", "secret"],
    ]);
  });

  it("keeps the field where the input's own text names it", async () => {
    expect(
      await filled(
        generate("confirm", verification("Club password (4 digits)"), [["custom-1", "secret"]]),
      ),
    ).toEqual([["custom-1", "secret"]]);
  });

  it("drops a set the rule turns into another set's slots and keeps the rest", async () => {
    // A synthetic page with a personal and a business form, each with a username and an
    // input labelled only "Password"; the model filled the business one with the field.
    const forms = page([
      field("user", "text", "Username"),
      field("pass", "password", "Password"),
      field("go", "button", "Sign in"),
      field("user2", "text", "Business ID", { group: "f2" }),
      field("pass2", "password", "Password", { group: "f2" }),
      field("go2", "button", "Sign in", { group: "f2" }),
    ]);
    const personal = set(
      [
        ["username", "user"],
        ["password", "pass"],
      ],
      "go",
    );
    const business = set(
      [
        ["username", "user2"],
        ["custom-1", "pass2"],
      ],
      "go2",
    );
    const answer = (sets: (typeof personal)[]) =>
      createRecipeGenerator({
        model: textModel(async () =>
          textResult(
            JSON.stringify({
              result: {
                decision: "plan",
                pageKind: "sign-in",
                irreversible: "no",
                ...sets[0],
                alternatives: sets.slice(1),
              },
            }),
          ),
        ),
        limits: { timeoutMs: 1_000, maxInputBytes: 16_384 },
        maxOutputTokens: 512,
      })({ observation: forms, slots: requested });
    for (const sets of [
      [personal, business],
      [business, personal],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Each order is generated on its own.
      const outcome = await answer(sets);
      expect(outcome).toMatchObject({ status: "ok", value: personal });
      if (outcome.status === "ok" && "alternatives" in outcome.value)
        expect(outcome.value.alternatives ?? []).toEqual([]);
    }
  });

  it("keeps a set that already fills the password", async () => {
    const both = verification("Password:", [field("code", "password", "Code")]);
    expect(
      await filled(
        generate("confirm", both, [
          ["password", "secret"],
          ["custom-1", "code"],
        ]),
      ),
    ).toEqual([
      ["password", "secret"],
      ["custom-1", "code"],
    ]);
  });
});
