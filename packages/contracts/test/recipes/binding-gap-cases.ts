import { expect, it } from "vitest";
import { bindingGaps, fillLoginBinding } from "../../src/recipes";
import type { BindingGapContext } from "./context";

export function registerBindingGaps({ binding, fields, resolve }: BindingGapContext) {
  const saved = binding({ slots: [{ slot: "username", field: "username" }] });
  const branch = [{ slot: "branch", field: { custom: "Branch number" } }];

  it("lists the slots a binding holds no entry for", () => {
    expect(bindingGaps(saved, ["username", "password", "branch"])).toEqual(["password", "branch"]);
    expect(bindingGaps(saved, ["username"])).toEqual([]);
  });

  it("uses a binding that covers the slots as it is", () => {
    expect(fillLoginBinding(saved, ["username"], [branch], fields)).toEqual({
      ok: true,
      binding: saved,
      widened: false,
    });
  });

  it("fills built-in gaps from the item's built-in fields and keeps the saved entries", () => {
    const manual = binding({
      slots: [{ slot: "username", field: { custom: "PIN", position: 2, count: 2 } }],
    });
    const filled = fillLoginBinding(manual, ["password", "username", "totp"], [], fields);
    expect(filled).toEqual({
      ok: true,
      widened: true,
      binding: {
        ...manual,
        slots: [
          ...manual.slots,
          { slot: "password", field: "password" },
          { slot: "totp", field: "totp" },
        ],
      },
    });
    // Filled entries resolve like any.
    expect(filled.ok && resolve(filled.binding)).toMatchObject({ ok: true });
    // A built-in field the item lacks is a missing field.
    const withoutPassword = fields.filter((field) => field.id !== "login.password");
    expect(fillLoginBinding(saved, ["username", "password"], [], withoutPassword)).toEqual({
      ok: false,
      slot: "password",
      reason: "field-missing",
    });
  });

  it("fills custom gaps from the first template that resolves, as without a saved binding", () => {
    const missing = [{ slot: "branch", field: { custom: "Region" } }];
    const ambiguous = [{ slot: "branch", field: { custom: "PIN" } }];
    const filled = fillLoginBinding(
      saved,
      ["username", "branch", "password"],
      [[], missing, ambiguous, branch],
      fields,
    );
    expect(filled).toEqual({
      ok: true,
      widened: true,
      binding: {
        ...saved,
        slots: [
          { slot: "username", field: "username" },
          { slot: "branch", field: { custom: "Branch number" } },
          { slot: "password", field: "password" },
        ],
      },
    });
    // The first refusal when no template resolves.
    expect(fillLoginBinding(saved, ["username", "branch"], [missing, ambiguous], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
    });
    expect(fillLoginBinding(saved, ["username", "branch"], [ambiguous], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-ambiguous",
    });
    // No template names the slot: the gap stays, as before.
    expect(fillLoginBinding(saved, ["username", "branch", "password"], [], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });

  it("never fills a gap with a built-in field the binding already reads under another slot", () => {
    const elsewhere = binding({
      slots: [
        { slot: "username", field: "username" },
        { slot: "Web password", field: "password" },
      ],
    });
    expect(fillLoginBinding(elsewhere, ["username", "password"], [], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
    // Another built-in field still fills.
    expect(
      fillLoginBinding(elsewhere, ["username", "Web password", "totp"], [], fields),
    ).toMatchObject({ ok: true, widened: true });
  });

  it("refuses a binding that would grow past the schema's 20 slots", () => {
    const full = binding({
      slots: Array.from({ length: 20 }, (_, index) => ({
        slot: `slot ${index}`,
        field: { custom: "Branch number" },
      })),
    });
    expect(fillLoginBinding(full, ["password"], [], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });
}
