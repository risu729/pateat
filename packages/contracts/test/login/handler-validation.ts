import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  DETAIL_HANDLER_SLOT,
  detailFieldFormat,
  detailFieldInputs,
  detailLength,
  detailPartsFit,
  detailSlot,
  isDetailSlot,
  handlerFact,
  manualDetails,
  handlerSteps,
  handlerTargets,
  loginChooserRecipeSchema,
  loginEntryRecipeSchema,
  loginRecipeSchema,
  loginTargetSchema,
  parseLoginOperation,
  parseLoginRecipe,
  type DetailField,
  type LoginTarget,
} from "../../src/login";
import type { LoginTestContext } from "./context";

export function registerPasskeyHandlers({
  securityKey,
  passkeyHandler,
  withHandlers,
}: Pick<LoginTestContext, "securityKey" | "passkeyHandler" | "withHandlers">): void {
  it("accepts passkey handlers, one per kind and path", () => {
    const handlers = [passkeyHandler(), passkeyHandler("/password", { by: "id", value: "key" })];
    expect(parseLoginRecipe(withHandlers(handlers)).handlers).toEqual(handlers);
    // The path is not excluded: a code form that stays on a route path may get a handler.
    expect(parseLoginRecipe(withHandlers([passkeyHandler("/password")])).handlers).toHaveLength(1);
  });

  it("refuses duplicate, empty, unknown and too many handlers", () => {
    expect(() =>
      parseLoginRecipe(
        withHandlers([passkeyHandler(), passkeyHandler("/webauthn", { by: "id", value: "other" })]),
      ),
    ).toThrow();
    expect(() => parseLoginRecipe(withHandlers([]))).toThrow();
    expect(() =>
      parseLoginRecipe(withHandlers([{ kind: "totp", path: "/webauthn", target: securityKey }])),
    ).toThrow();
    expect(() => parseLoginRecipe(withHandlers([{ ...passkeyHandler(), steps: [] }]))).toThrow();
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => passkeyHandler(`/factor-${index}`));
    expect(parseLoginRecipe(withHandlers(many(16))).handlers).toHaveLength(16);
    expect(() => parseLoginRecipe(withHandlers(many(17)))).toThrow();
  });

  it("refuses an account switch or completion marker that is a handler's button", () => {
    expect(() =>
      parseLoginRecipe({
        ...withHandlers([passkeyHandler()]),
        accountSwitch: securityKey,
      }),
    ).toThrow();
    const marker = { by: "id", value: "authenticated" } as const;
    // A marker proves a sign-in on any path, so no handler's element is one on any path.
    for (const path of ["/authenticated", "/webauthn"])
      expect(() => parseLoginRecipe(withHandlers([passkeyHandler(path, marker)]))).toThrow();
  });

  it("derives a passkey handler's steps from its kind", () => {
    expect(handlerSteps(passkeyHandler())).toEqual([
      { kind: "click", path: "/webauthn", target: securityKey, purpose: "submit" },
    ]);
  });
}

export function registerPasswordHandler({
  recipe,
  passkeyHandler,
  withHandlers,
}: Pick<LoginTestContext, "recipe" | "passkeyHandler" | "withHandlers">): void {
  describe("the password handler (ADR 0048)", () => {
    const choice = { by: "text", value: "Password" } as const;
    const password = (path = "/identity", target: LoginTarget = choice) => ({
      kind: "password" as const,
      path,
      target,
    });

    it("accepts a button beside other handlers on its path, and clicks it as an advance", () => {
      const handlers = [password(), passkeyHandler("/identity")];
      expect(parseLoginRecipe(withHandlers(handlers)).handlers).toEqual(handlers);
      expect(handlerSteps(password())).toEqual([
        { kind: "click", path: "/identity", target: choice, purpose: "advance" },
      ]);
      expect(handlerTargets(password())).toEqual([choice]);
    });

    it("refuses a route step's element on its path, and a second one per path", () => {
      const next = { by: "id", value: "next" } as const;
      expect(() => parseLoginRecipe(withHandlers([password("/identity", next)]))).toThrow();
      // On another path the locator names another element.
      expect(parseLoginRecipe(withHandlers([password("/choose", next)])).handlers).toHaveLength(1);
      expect(() =>
        parseLoginRecipe(
          withHandlers([password(), password("/identity", { by: "id", value: "other" })]),
        ),
      ).toThrow();
      expect(() =>
        parseLoginRecipe(withHandlers([{ ...password(), field: { by: "id", value: "x" } }])),
      ).toThrow();
    });

    describe("named by its accessible name (ADR 0048 amendment of 2026-10-19)", () => {
      const named = { by: "accessible-name", value: "Select Password." } as const;
      const parses = (value: unknown) => v.safeParse(loginRecipeSchema, value).success;

      it("names a password handler's button and clicks it as an advance", () => {
        const handlers = [password("/identity", named)];
        expect(parseLoginRecipe(withHandlers(handlers)).handlers).toEqual(handlers);
        expect(handlerSteps(password("/identity", named))).toEqual([
          { kind: "click", path: "/identity", target: named, purpose: "advance" },
        ]);
        // Its value takes the text locator's form: collapsed, at most 120 characters.
        for (const value of ["", " Select", "Select  Password", "x".repeat(121)])
          expect(v.safeParse(loginTargetSchema, { by: "accessible-name", value }).success).toBe(
            false,
          );
      });

      it("names a route step's click (ADR 0048 amendment of 2026-10-23)", () => {
        const base = recipe();
        const next = { by: "accessible-name", value: "次に進む" } as const;
        const steps = base.steps.map((step, index) =>
          index === 1 ? { ...step, target: next } : step,
        );
        expect(parseLoginRecipe({ ...base, steps }).steps[1]).toEqual({
          kind: "click",
          path: "/identity",
          target: next,
          purpose: "advance",
        });
      });

      it("names no other element of a recipe", () => {
        const base = recipe();
        const withPasskey = {
          ...base,
          passkey: { path: "/identity", target: named },
        };
        for (const value of [
          withPasskey,
          { ...base, completion: [{ target: named }] },
          { ...base, completion: [{ target: { by: "id", value: "out" } }, { target: named }] },
          {
            ...base,
            completion: [{ target: { by: "id", value: "out" }, absent: [named] }],
          },
          { ...base, rejection: named },
          { ...base, accountSwitch: named },
          withHandlers([passkeyHandler("/webauthn", named)]),
          withHandlers([
            {
              kind: "totp",
              path: "/two-factor",
              field: { by: "id", value: "otp" },
              target: named,
            },
          ]),
        ])
          expect(parses(value)).toBe(false);
        // A wait or assert step never names one either.
        expect(
          parses({
            ...base,
            steps: [
              { kind: "assert", path: "/identity", target: named, present: true },
              ...base.steps,
            ],
          }),
        ).toBe(false);
        // A fill never takes it, as a field is never named so.
        expect(
          parses({
            ...base,
            steps: [
              {
                kind: "fill",
                path: "/identity",
                fields: [{ slot: "branch", target: named }],
              },
              ...base.steps.slice(1),
            ],
          }),
        ).toBe(false);
      });

      it("is never an entry's or a list control's locator", () => {
        expect(
          v.safeParse(loginEntryRecipeSchema, {
            version: 1,
            id: "entry",
            revision: 1,
            origin: "https://bank.example",
            entry: { path: "/", target: named },
          }).success,
        ).toBe(false);
        expect(
          v.safeParse(loginChooserRecipeSchema, {
            version: 1,
            id: "chooser",
            revision: 1,
            origin: "https://bank.example",
            chooser: { path: "/", other: named },
          }).success,
        ).toBe(false);
      });
    });
  });
}

export function registerTotpHandler({
  securityKey,
  passkeyHandler,
  withHandlers,
}: Pick<LoginTestContext, "securityKey" | "passkeyHandler" | "withHandlers">): void {
  describe("the totp handler", () => {
    const code = (change: Record<string, unknown> = {}) => ({
      kind: "totp" as const,
      path: "/two-factor",
      field: { by: "id" as const, value: "otp" },
      target: { by: "text" as const, value: "Verify" },
      ...change,
    });

    it("accepts a code field and its button beside a passkey handler on one path", () => {
      const handlers = [code(), passkeyHandler("/two-factor")];
      expect(parseLoginRecipe(withHandlers(handlers)).handlers).toEqual(handlers);
      // The code field may be named by its visible name (ADR 0037), never by text.
      const named = code({ field: { by: "label", value: "確認コード" } });
      expect(parseLoginRecipe(withHandlers([named])).handlers).toEqual([named]);
      expect(() =>
        parseLoginRecipe(withHandlers([code({ field: { by: "text", value: "確認コード" } })])),
      ).toThrow();
      // On a route path, its button may be the route's own submit button.
      expect(
        parseLoginRecipe(
          withHandlers([code({ path: "/password", target: { by: "id", value: "login" } })]),
        ).handlers,
      ).toHaveLength(1);
    });

    it("refuses a text-located field, a field that is its button and a second one per path", () => {
      for (const handler of [
        code({ field: { by: "text", value: "Code" } }),
        code({ field: { by: "id", value: "verify" }, target: { by: "id", value: "verify" } }),
        { kind: "totp", path: "/two-factor", target: { by: "id", value: "verify" } },
      ])
        expect(() => parseLoginRecipe(withHandlers([handler]))).toThrow();
      expect(() =>
        parseLoginRecipe(withHandlers([code(), code({ field: { by: "id", value: "other" } })])),
      ).toThrow();
      // Nor a field a route step uses on its path; on another path it is another element.
      const login = { by: "id", value: "login" } as const;
      expect(() =>
        parseLoginRecipe(
          withHandlers([
            code({ path: "/password", field: { by: "id", value: "password" }, target: login }),
          ]),
        ),
      ).toThrow();
      expect(
        parseLoginRecipe(
          withHandlers([code({ path: "/two-factor", field: { by: "id", value: "password" } })]),
        ).handlers,
      ).toHaveLength(1);
    });

    it("fills the code into its field, then clicks its button", () => {
      expect(handlerTargets(code())).toEqual([code().field, code().target]);
      expect(handlerTargets(passkeyHandler())).toEqual([securityKey]);
      expect(handlerSteps(code())).toEqual([
        {
          kind: "fill",
          path: "/two-factor",
          fields: [{ slot: "totp", target: { by: "id", value: "otp" } }],
          effect: "prepare",
        },
        { kind: "click", path: "/two-factor", target: code().target, purpose: "submit" },
      ]);
      // Both are valid recipe steps.
      for (const step of handlerSteps(code()))
        expect(
          parseLoginOperation({
            version: 1,
            attemptId: "attempt-one",
            operationId: "operation-one",
            policyRevision: 4,
            document: {
              origin: "https://bank.example",
              tabId: 11,
              frameId: 0,
              documentId: "document-one",
            },
            stepIndex: 2,
            step,
            expiresAt: 15_000,
          }).step,
        ).toEqual(step);
    });

    it("types the code as its submission when the page shows no button (#916)", () => {
      const { target: _, ...buttonless } = code();
      const parsed = parseLoginRecipe(withHandlers([buttonless])).handlers![0]!;
      expect(parsed).toEqual({
        kind: "totp",
        path: "/two-factor",
        field: { by: "id", value: "otp" },
      });
      expect(handlerTargets(parsed)).toEqual([{ by: "id", value: "otp" }]);
      expect(handlerSteps(parsed)).toEqual([
        {
          kind: "fill",
          path: "/two-factor",
          fields: [{ slot: "totp", target: { by: "id", value: "otp" } }],
          effect: "submit",
          event: "input",
        },
      ]);
    });
  });
}

export function registerDetailHandler({
  recipe,
  passkeyHandler,
  withHandlers,
}: Pick<LoginTestContext, "recipe" | "passkeyHandler" | "withHandlers">): void {
  describe("the detail handler (ADR 0061)", () => {
    // A synthetic page that asks for a birth year and month or a phone's last four digits.
    const birth = { detail: "birth-date" as const, format: "yyyymm" as const, target: id("birth") };
    const phone = { detail: "phone-last-4" as const, target: id("phone") };
    const confirm = id("confirm");
    function id(value: string) {
      return { by: "id" as const, value };
    }
    const detail = (change: Record<string, unknown> = {}) => ({
      kind: "detail" as const,
      path: "/verify",
      fields: [birth, phone],
      target: confirm,
      ...change,
    });
    const parses = (handlers: unknown[]) =>
      v.safeParse(loginRecipeSchema, withHandlers(handlers)).success;

    it("accepts one to three inputs and their button beside other handlers on one path", () => {
      const handlers = [detail(), passkeyHandler("/verify")];
      expect(parseLoginRecipe(withHandlers(handlers)).handlers).toEqual(handlers);
      const card = { detail: "card-last-4" as const, target: id("card") };
      const code = { detail: "card-code" as const, target: { by: "label" as const, value: "CVC" } };
      for (const fields of [[phone], [birth, phone, card], [code]])
        expect(parses([detail({ fields })])).toBe(true);
      for (const format of ["yyyymmdd", "yyyymm", "yyyy-mm-dd", "yyyy/mm/dd", "mmdd"])
        expect(parses([detail({ fields: [{ ...birth, format }] })])).toBe(true);
      // A totp handler on the same path is a handler of another kind.
      expect(
        parses([
          detail(),
          { kind: "totp", path: "/verify", field: id("otp"), target: id("verify") },
        ]),
      ).toBe(true);
    });

    it("refuses a birth date without a format and another detail with one", () => {
      const { format: _format, ...unformatted } = birth;
      expect(parses([detail({ fields: [unformatted] })])).toBe(false);
      expect(parses([detail({ fields: [{ ...phone, format: "yyyymm" }] })])).toBe(false);
      expect(parses([detail({ fields: [{ ...birth, format: "ddmmyyyy" }] })])).toBe(false);
      // A password is never a detail.
      expect(parses([detail({ fields: [{ ...phone, detail: "password" }] })])).toBe(false);
    });

    it("takes a card's number, expiry date and a PIN, each format only on its own detail", () => {
      const number = { detail: "card-number" as const, target: id("number") };
      const expiry = {
        detail: "card-expiry" as const,
        format: "mm/yy" as const,
        target: id("exp"),
      };
      const pin = { detail: "pin" as const, target: id("pin") };
      expect(parses([detail({ fields: [number, expiry, pin] })])).toBe(true);
      for (const format of ["mmyy", "mm/yy", "mmyyyy", "mm/yyyy"])
        expect(parses([detail({ fields: [{ ...expiry, format }] })])).toBe(true);
      // An expiry date needs a format of its own, never a birth date's, and the other way
      // round; a separate month or year is no format.
      const { format: _format, ...unformatted } = expiry;
      for (const fields of [
        [unformatted],
        [{ ...expiry, format: "yyyymm" }],
        [{ ...expiry, format: "mm" }],
        [{ ...expiry, format: "yy" }],
        [{ ...birth, format: "mmyy" }],
        [{ ...number, format: "mmyy" }],
        [{ ...pin, format: "mmyy" }],
      ])
        expect(parses([detail({ fields })]), JSON.stringify(fields)).toBe(false);
    });

    it("refuses no input, four inputs, a duplicate input and an input that is its button", () => {
      const card = { detail: "card-last-4" as const, target: id("card") };
      const code = { detail: "card-code" as const, target: id("code") };
      expect(parses([detail({ fields: [] })])).toBe(false);
      expect(parses([detail({ fields: [birth, phone, card, code] })])).toBe(false);
      // The same input twice, even for two details.
      expect(parses([detail({ fields: [phone, { ...card, target: id("phone") }] })])).toBe(false);
      expect(parses([detail({ fields: [birth, { ...phone, target: confirm }] })])).toBe(false);
      // A text locator names no input, and a second detail handler per path is refused.
      expect(
        parses([detail({ fields: [{ ...phone, target: { by: "text", value: "Phone" } }] })]),
      ).toBe(false);
      expect(parses([detail(), detail({ fields: [phone], target: id("other") })])).toBe(false);
      // An input or button named by its accessible name, or a handler without a button.
      expect(
        parses([detail({ target: { by: "accessible-name", value: "Confirm the details." } })]),
      ).toBe(false);
      const { target: _target, ...buttonless } = detail();
      expect(parses([buttonless])).toBe(false);
    });

    it("refuses an input or button that a route step uses on its path, not elsewhere", () => {
      // The route fills branch and account and clicks next on /identity, and types the
      // password and clicks login on /password.
      for (const handler of [
        detail({ path: "/identity", fields: [{ ...phone, target: id("account") }] }),
        detail({ path: "/identity", target: id("next") }),
        detail({ path: "/password", fields: [birth, { ...phone, target: id("password") }] }),
        detail({ path: "/password", target: id("login") }),
      ])
        expect(() => parseLoginRecipe(withHandlers([handler]))).toThrow(
          "The code field or a detail handler's element is a route step target",
        );
      // On a route path, inputs and a button of its own are allowed.
      expect(parses([detail({ path: "/identity" })])).toBe(true);
      // On another path the same locators name other elements.
      expect(
        parses([detail({ fields: [{ ...phone, target: id("account") }], target: id("login") })]),
      ).toBe(true);
    });

    it("refuses a route step that fills a slot named as a detail handler's", () => {
      const base = recipe();
      const named = {
        ...base,
        slots: ["branch", "detail", "password"],
        steps: base.steps.map((step) =>
          step.kind === "fill" && step.path === "/identity"
            ? {
                ...step,
                fields: step.fields.map((field) =>
                  field.slot === "account" ? { ...field, slot: "detail" } : field,
                ),
              }
            : step,
        ),
      };
      expect(() => parseLoginRecipe(named)).toThrow("a route slot is named as a detail handler's");
    });

    it("lists its inputs, then its button, and fills the input at field before the click", () => {
      expect(handlerTargets(detail())).toEqual([birth.target, phone.target, confirm]);
      const fill = (target: unknown) => ({
        kind: "fill",
        path: "/verify",
        fields: [{ slot: DETAIL_HANDLER_SLOT, target }],
        effect: "prepare",
      });
      const click = { kind: "click", path: "/verify", target: confirm, purpose: "submit" };
      expect(DETAIL_HANDLER_SLOT).toBe("detail");
      expect(handlerSteps(detail())).toEqual([fill(birth.target), click]);
      expect(handlerSteps(detail(), 0)).toEqual([fill(birth.target), click]);
      expect(handlerSteps(detail(), 1)).toEqual([fill(phone.target), click]);
      // A field past the inputs falls back to the first.
      expect(handlerSteps(detail(), 5)).toEqual([fill(birth.target), click]);
      // Both are valid recipe steps.
      for (const step of handlerSteps(detail(), 1))
        expect(
          parseLoginOperation({
            version: 1,
            attemptId: "attempt-one",
            operationId: "operation-one",
            policyRevision: 4,
            document: {
              origin: "https://bank.example",
              tabId: 11,
              frameId: 0,
              documentId: "document-one",
            },
            stepIndex: 2,
            step,
            expiresAt: 15_000,
          }).step,
        ).toEqual(step);
    });

    it("requires no item fact, fills no detail by hand yet, and sizes each detail's value", () => {
      expect(handlerFact.detail).toBeUndefined();
      expect(manualDetails).toEqual([]);
      expect(detailLength({ detail: "phone-last-4" })).toBe(4);
      expect(detailLength({ detail: "card-last-4" })).toBe(4);
      expect(detailLength({ detail: "card-code" })).toBe(3);
      expect(detailLength({ detail: "birth-date" })).toBe(8);
      for (const [format, length] of [
        ["yyyymmdd", 8],
        ["yyyymm", 6],
        ["yyyy-mm-dd", 10],
        ["yyyy/mm/dd", 10],
        ["mmdd", 4],
      ] as const)
        expect(detailLength({ detail: "birth-date", format })).toBe(length);
      // A card number has 12 digits or more, a PIN 4 or more.
      expect(detailLength({ detail: "card-number" })).toBe(12);
      expect(detailLength({ detail: "pin" })).toBe(4);
      for (const [format, length] of [
        ["mmyy", 4],
        ["mm/yy", 5],
        ["mmyyyy", 6],
        ["mm/yyyy", 7],
      ] as const)
        expect(detailLength({ detail: "card-expiry", format })).toBe(length);
    });

    describe("a value split over several inputs (owner, 2026-10-23 12:26 UTC)", () => {
      const date = (parts: { part: string; format?: string; length?: number }[]) => ({
        detail: "birth-date",
        parts: parts.map((part) => ({ ...part, target: id(`birth-${part.part}`) })),
      });
      const year = { part: "year", format: "yyyy" };
      const month = { part: "month", format: "mm" };
      const day = { part: "day", format: "d" };
      const groups = (asked: string, lengths: number[]) => ({
        detail: asked,
        parts: lengths.map((length, at) => ({ part: at + 1, length, target: id(`g${at + 1}`) })),
      });
      const expiry = (parts: { part: string; format: string }[]) => ({
        detail: "card-expiry",
        parts: parts.map((part) => ({ ...part, target: id(`exp-${part.part}`) })),
      });

      it("takes a birth date's year, month and day, its year and month, or its month and day", () => {
        for (const parts of [
          [year, month, day],
          [day, month, year],
          [year, month],
          [month, { part: "day", format: "dd" }],
          [year, { part: "month", format: "m" }, day],
        ])
          expect(parses([detail({ fields: [date(parts), phone] })]), JSON.stringify(parts)).toBe(
            true,
          );
        // The split field keeps its shape; a one-input field beside it is unchanged.
        const handler = detail({ fields: [date([year, month, day]), phone] });
        expect(parseLoginRecipe(withHandlers([handler])).handlers).toEqual([handler]);
      });

      it("takes a card expiry date's month and year, and a card number's or PIN's groups", () => {
        for (const field of [
          expiry([
            { part: "month", format: "mm" },
            { part: "year", format: "yy" },
          ]),
          expiry([
            { part: "month", format: "m" },
            { part: "year", format: "yyyy" },
          ]),
          groups("card-number", [4, 4, 4, 4]),
          groups("card-number", [4, 6, 5]),
          groups("card-number", [4, 4, 4, 4, 3]),
          groups("card-number", [6, 6]),
          groups("pin", [1, 1, 1, 1]),
          groups("pin", [2, 2]),
        ])
          expect(parses([detail({ fields: [field] })]), JSON.stringify(field)).toBe(true);
      });

      it.each([
        ["a birth date with only its year", date([year])],
        ["a birth date with its year and day", date([year, day])],
        ["a birth date with its month twice", date([year, month, { ...month, format: "m" }])],
        ["a two-digit birth year", date([{ ...year, format: "yy" }, month, day])],
        ["a birth date's part without a format", date([{ part: "year" }, month, day])],
        ["a birth date's part with a length", date([{ ...year, length: 4 }, month, day])],
        ["a birth date's month in a day's format", date([year, { part: "month", format: "dd" }])],
        ["a birth date with a numbered group", date([year, month, { part: 3 } as never])],
        ["a card expiry date without its year", expiry([{ part: "month", format: "mm" }])],
        [
          "a card expiry date with a day",
          expiry([
            { part: "month", format: "mm" },
            { part: "year", format: "yy" },
            { part: "day", format: "dd" },
          ]),
        ],
        ["a card number of 11 digits", groups("card-number", [4, 4, 3])],
        ["a card number of 20 digits", groups("card-number", [4, 4, 4, 4, 4])],
        ["a PIN of 13 digits", groups("pin", [7, 6])],
        ["one group alone", groups("card-number", [16])],
        [
          "groups numbered out of order",
          {
            ...groups("card-number", [4, 4, 4, 4]),
            parts: groups("card-number", [4, 4, 4, 4]).parts.reverse(),
          },
        ],
        [
          "a group without a length",
          {
            detail: "card-number",
            parts: [
              { part: 1, length: 8, target: id("g1") },
              { part: 2, target: id("g2") },
            ],
          },
        ],
        [
          "a group with a format",
          {
            detail: "pin",
            parts: [
              { part: 1, length: 2, format: "mm", target: id("g1") },
              { part: 2, length: 2, target: id("g2") },
            ],
          },
        ],
        ["seven groups", groups("card-number", [2, 2, 2, 2, 2, 2, 2])],
        ["a phone's last four digits split", groups("phone-last-4", [2, 2])],
        ["a security code split", groups("card-code", [1, 1, 1])],
        [
          "a part with the format of a whole value",
          date([{ part: "year", format: "yyyymm" }, month]),
        ],
        [
          "a split field with a target of its own",
          { ...date([year, month, day]), target: id("birth") },
        ],
      ])("refuses %s", (_label, field) => {
        expect(parses([detail({ fields: [field] })])).toBe(false);
      });

      it("refuses an input used twice across its parts and fields, or a part that is its button", () => {
        const twice = date([year, month, day]);
        twice.parts[1]!.target = id("birth-year");
        expect(parses([detail({ fields: [twice] })])).toBe(false);
        expect(
          parses([
            detail({ fields: [date([year, month]), { ...phone, target: id("birth-year") }] }),
          ]),
        ).toBe(false);
        expect(parses([detail({ fields: [date([year, month])], target: id("birth-month") })])).toBe(
          false,
        );
      });

      it("lists every part, and fills all of the chosen field's inputs in one step", () => {
        const card = groups("card-number", [4, 4, 4, 4]);
        const handler = parseLoginRecipe(withHandlers([detail({ fields: [phone, card] })]))
          .handlers![0]!;
        expect(handlerTargets(handler)).toEqual([
          phone.target,
          ...card.parts.map((part) => part.target),
          confirm,
        ]);
        const steps = handlerSteps(handler, 1);
        expect(steps).toEqual([
          {
            kind: "fill",
            path: "/verify",
            fields: card.parts.map((part, at) => ({ slot: detailSlot(at), target: part.target })),
            effect: "prepare",
          },
          { kind: "click", path: "/verify", target: confirm, purpose: "submit" },
        ]);
        expect(card.parts.map((_part, at) => detailSlot(at))).toEqual([
          "detail",
          "detail 2",
          "detail 3",
          "detail 4",
        ]);
        expect(["detail", "detail 2", "detail 6"].every(isDetailSlot)).toBe(true);
        expect(["details", "detail 7", "detail 10", "my detail"].some(isDetailSlot)).toBe(false);
        expect(detailFieldInputs(card as DetailField)).toEqual(
          card.parts.map((part) => ({ detail: "card-number", ...part })),
        );
      });

      it("refuses a route step that fills a split value's slot", () => {
        const base = recipe();
        const named = {
          ...base,
          slots: ["branch", "detail 2", "password"],
          steps: base.steps.map((step) =>
            step.kind === "fill" && step.path === "/identity"
              ? {
                  ...step,
                  fields: step.fields.map((field) =>
                    field.slot === "account" ? { ...field, slot: "detail 2" } : field,
                  ),
                }
              : step,
          ),
        };
        expect(() => parseLoginRecipe(named)).toThrow(
          "a route slot is named as a detail handler's",
        );
      });

      it("reads a split birth date as the one-input format the popup names", () => {
        expect(detailFieldFormat(date([year, month]) as DetailField)).toBe("yyyymm");
        expect(detailFieldFormat(date([month, day]) as DetailField)).toBe("mmdd");
        expect(detailFieldFormat(date([year, month, day]) as DetailField)).toBeUndefined();
        expect(detailFieldFormat(birth)).toBe("yyyymm");
        expect(detailFieldFormat(groups("pin", [2, 2]) as DetailField)).toBeUndefined();
      });

      it("fits parts only to the details that split", () => {
        expect(detailPartsFit("birth-date", [{ part: "year", format: "yyyy" }])).toBe(false);
        expect(
          detailPartsFit("card-number", [
            { part: 1, length: 6 },
            { part: 2, length: 6 },
          ]),
        ).toBe(true);
        for (const other of [
          "phone-last-4",
          "card-last-4",
          "card-code",
          "secret-answer",
          "member-id",
        ] as const)
          expect(
            detailPartsFit(other, [
              { part: 1, length: 2 },
              { part: 2, length: 2 },
            ]),
          ).toBe(false);
      });
    });
  });
}

export function registerHandlerOperations({
  passkeyHandler,
}: Pick<LoginTestContext, "passkeyHandler">): void {
  it("allows handler steps beyond the route's step indices in an operation", () => {
    const operation = {
      version: 1,
      attemptId: "attempt-one",
      operationId: "operation-one",
      policyRevision: 4,
      document: {
        origin: "https://bank.example",
        tabId: 11,
        frameId: 0,
        documentId: "document-one",
      },
      stepIndex: 39,
      step: handlerSteps(passkeyHandler())[0],
      expiresAt: 15_000,
    };
    expect(parseLoginOperation(operation).stepIndex).toBe(39);
    expect(() => parseLoginOperation({ ...operation, stepIndex: 40 })).toThrow();
  });
}
