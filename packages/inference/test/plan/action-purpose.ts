import type { LoginObservation } from "@pateat/contracts";
import { validateGeneratedPage, type PagePlan } from "../../src/plan";
import { expect, it } from "vitest";
import type { PlanTestFixtures } from "../../src/plan.test";

type EmailOnly = (
  page: LoginObservation,
  purpose: "advance" | "submit",
) => ReturnType<typeof validateGeneratedPage>;
type PurposeOf = (
  result: ReturnType<typeof validateGeneratedPage>,
) => (
  | PagePlan["action"]["purpose"]
  | Extract<ReturnType<typeof validateGeneratedPage>, { ok: true }>["plan"]["steps"][number]
  | undefined
)[];

export function registerActionPurpose({
  emailPage,
  emailOnly,
  purposeOf,
  branch,
  input,
  observation,
  slots,
}: {
  emailPage: LoginObservation;
  emailOnly: EmailOnly;
  purposeOf: PurposeOf;
  branch: PlanTestFixtures["branch"];
  input: PlanTestFixtures["input"];
  observation: PlanTestFixtures["observation"];
  slots: PlanTestFixtures["slots"];
}) {
  it("advances after an identifier alone, whatever the model answered", () => {
    for (const answered of ["submit", "advance"] as const)
      expect(purposeOf(emailOnly(emailPage, answered))).toEqual([
        "advance",
        {
          kind: "click",
          path: "/sign_in",
          target: { by: "id", value: "next" },
          purpose: "advance",
        },
      ]);
  });

  it("submits when the form also shows a password or code input the plan leaves empty", () => {
    for (const extra of [
      input("password", { role: "password" }),
      input("code", { role: "tel", maxLength: 6 }),
      input("otp", { autocomplete: "one-time-code" }),
    ]) {
      const page = { ...emailPage, candidates: [...emailPage.candidates, extra] };
      expect(purposeOf(emailOnly(page, "advance"))[0], extra.id).toBe("submit");
    }
  });

  it("advances when that input belongs to another form", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("email", { role: "email", group: "a" }),
        input("next", { role: "button", group: "a" }),
        input("password", { role: "password", group: "b" }),
      ],
    };
    expect(purposeOf(emailOnly(page, "submit"))[0]).toBe("advance");
  });

  it("counts inputs outside any form as one form, apart from a form's own", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("email", { role: "email" }),
        input("next", { role: "button" }),
        input("password", { role: "password", group: "b" }),
      ],
    };
    expect(purposeOf(emailOnly(page, "submit"))[0]).toBe("advance");
    const outside = {
      ...page,
      candidates: [...page.candidates, input("other", { role: "password" })],
    };
    expect(purposeOf(emailOnly(outside, "advance"))[0]).toBe("submit");
  });

  it("reads a later page's purpose from the set it keeps, once alternatives are dropped", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("email", { role: "email" }),
        input("phone", { role: "tel" }),
        input("next", { role: "button" }),
      ],
    };
    const result = validateGeneratedPage(
      page,
      [...slots, { ...branch, id: "custom-4", fieldName: "電話番号" }],
      {
        fields: [{ slot: "username", candidate: "email" }],
        action: { candidate: "next", purpose: "submit" },
        alternatives: [
          {
            fields: [{ slot: "custom-4", candidate: "phone" }],
            action: { candidate: "next", purpose: "submit" },
          },
        ],
      },
      false,
    );
    expect(purposeOf(result)).toEqual([
      "advance",
      { kind: "click", path: "/sign_in", target: { by: "id", value: "next" }, purpose: "advance" },
    ]);
  });

  it("advances after short numeric identifiers the plan fills itself", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("branch", { role: "tel", maxLength: 3 }),
        input("account", { role: "tel", maxLength: 7 }),
        input("next", { role: "button" }),
      ],
    };
    const result = validateGeneratedPage(page, slots, {
      fields: [
        { slot: "custom-1", candidate: "branch" },
        { slot: "custom-2", candidate: "account" },
      ],
      action: { candidate: "next", purpose: "submit" },
    });
    expect(purposeOf(result)[0]).toBe("advance");
  });

  it("submits after a password, a hidden value or a code, whatever the model answered", () => {
    const result = validateGeneratedPage(observation, slots, {
      fields: [
        { slot: "username", candidate: "user" },
        { slot: "password", candidate: "password" },
      ],
      action: { candidate: "login", purpose: "advance" },
    });
    expect(purposeOf(result)[0]).toBe("submit");
    const pinOnly = validateGeneratedPage(observation, slots, {
      fields: [{ slot: "custom-3", candidate: "pin" }],
      action: { candidate: "login", purpose: "advance" },
    });
    expect(purposeOf(pinOnly)[0]).toBe("submit");
  });

  it("keeps the model's purpose for a page with alternatives, where every set submits", () => {
    const result = validateGeneratedPage(observation, slots, {
      fields: [{ slot: "username", candidate: "user" }],
      action: { candidate: "login", purpose: "advance" },
      alternatives: [
        {
          fields: [
            { slot: "custom-1", candidate: "branch" },
            { slot: "custom-2", candidate: "account" },
          ],
          action: { candidate: "login", purpose: "submit" },
        },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "variant-advance" });
  });
}
