import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  runsLogin,
  loginEntryRecipeSchema,
  loginTargetSchema,
  sameLoginTarget,
  parseLoginAccountBinding,
  parseLoginOperation,
  parseLoginRecipe,
  resolveLoginPlan,
  type LoginRecipe,
} from "../../src/login";
import { DUMMY_VAULT_CATALOG } from "../../src/settings";
import type { LoginTestContext } from "./context";

export function registerDeclarativeBoundaries({
  recipe,
  binding,
}: Pick<LoginTestContext, "recipe" | "binding">): void {
  describe("declarative login boundaries", () => {
    it("accepts separate multi-page field mappings without containing values", () => {
      expect(parseLoginRecipe(recipe())).toEqual(recipe());
      expect(parseLoginAccountBinding(binding())).toEqual(binding());
    });
    it("names a keypad only by an id, test ID, class or position, on a preparing fill (ADR 0067)", () => {
      const withKeypad = (keypad: unknown, extra: object = {}) => {
        const value = recipe();
        value.steps[2] = {
          kind: "fill",
          effect: "prepare",
          path: "/password",
          fields: [{ slot: "password", target: { by: "id", value: "password" }, keypad }],
          ...extra,
        } as LoginRecipe["steps"][number];
        return () => parseLoginRecipe(value);
      };
      expect(withKeypad({ by: "id", value: "soft-keys" })().steps[2]).toMatchObject({
        fields: [{ keypad: { by: "id", value: "soft-keys" } }],
      });
      for (const keypad of [
        { by: "test-id", value: "pad" },
        { by: "class", value: "soft-keyboard" },
        { by: "class", value: "_keys-2" },
        { by: "position", value: "1:0" },
        { by: "position", value: "3:1.0.12" },
        { by: "position", value: "20:99" },
      ])
        expect(withKeypad(keypad), JSON.stringify(keypad)).not.toThrow();
      for (const keypad of [
        { by: "name", value: "pad" },
        { by: "text", value: "1" },
        { by: "label", value: "Keys" },
        { by: "id", value: "two words" },
        // A class is one token, never a selector.
        { by: "class", value: "keys pad" },
        { by: "class", value: ".keys" },
        { by: "class", value: "2col" },
        { by: "class", value: "" },
        // A position goes up at least one and at most 20 parents, then down at most 12
        // children, each by an index below 100 written without leading zeros.
        { by: "position", value: "0:1" },
        { by: "position", value: "21:1" },
        { by: "position", value: "1:" },
        { by: "position", value: "1:01" },
        { by: "position", value: "1:100" },
        { by: "position", value: `1:${Array.from({ length: 13 }, () => "0").join(".")}` },
        { by: "position", value: "div > .keys" },
      ])
        expect(withKeypad(keypad), JSON.stringify(keypad)).toThrow();
      // An effectful fill's one event never goes through a keypad.
      expect(
        withKeypad({ by: "id", value: "soft-keys" }, { effect: "submit", event: "input" }),
      ).toThrow();
    });
    it("bounds the elements a completion requires to be absent", () => {
      const base = recipe();
      const absent = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ by: "id" as const, value: `f${index}` }));
      const withAbsent = (targets: unknown[]) => ({
        ...base,
        completion: [{ ...base.completion![0], absent: targets }],
      });
      expect(parseLoginRecipe(withAbsent(absent(4))).completion?.[0]?.absent).toHaveLength(4);
      expect(() => parseLoginRecipe(withAbsent([]))).toThrow();
      expect(() => parseLoginRecipe(withAbsent(absent(5)))).toThrow();
      expect(() => parseLoginRecipe(withAbsent([...absent(1), ...absent(1)]))).toThrow();
      // A step's elements and the result elements share one 24-element observation.
      const wide = {
        ...withAbsent(absent(4)),
        rejection: { by: "id", value: "rejected" },
        slots: Array.from({ length: 19 }, (_, index) => `s${index}`),
        steps: [
          {
            kind: "fill",
            path: "/identity",
            fields: Array.from({ length: 19 }, (_, index) => ({
              slot: `s${index}`,
              target: { by: "id", value: `field${index}` },
            })),
          },
          {
            kind: "click",
            path: "/identity",
            target: { by: "id", value: "go" },
            purpose: "submit",
          },
        ],
      };
      expect(() => parseLoginRecipe(wide)).toThrow();
      expect(parseLoginRecipe({ ...wide, rejection: undefined }).steps).toHaveLength(2);
      // Every marker counts in that observation, with the elements it needs missing.
      expect(() =>
        parseLoginRecipe({
          ...wide,
          rejection: undefined,
          completion: [...wide.completion, { target: { by: "id", value: "account" } }],
        }),
      ).toThrow();
    });

    it("keeps up to four distinct signed-in markers (ADR 0029)", () => {
      const marker = (value: string) => ({ target: { by: "id" as const, value } });
      const withMarkers = (completion: unknown[]) => ({ ...recipe(), completion });
      expect(
        parseLoginRecipe(withMarkers(["a", "b", "c", "d"].map(marker))).completion,
      ).toHaveLength(4);
      expect(() => parseLoginRecipe(withMarkers(["a", "b", "c", "d", "e"].map(marker)))).toThrow();
      expect(() => parseLoginRecipe(withMarkers([]))).toThrow();
      expect(() => parseLoginRecipe(withMarkers([marker("a"), marker("a")]))).toThrow();
      // A marker has no path: it proves a sign-in on any path.
      expect(() => parseLoginRecipe(withMarkers([{ ...marker("a"), path: "/home" }]))).toThrow();
    });

    it("names a marker's link by a path without numbers, and only a marker (ADR 0029)", () => {
      const withMarker = (value: string) => ({
        ...recipe(),
        completion: [{ target: { by: "href", value } }],
      });
      for (const value of ["/my", "/my/", "/member/settings", "/my_page.php"])
        expect(parseLoginRecipe(withMarker(value)).completion, value).toHaveLength(1);
      // A number, a percent-encoded name, a query, a fragment or another origin never.
      for (const value of [
        "/",
        "/user/12345",
        "/%E3%83%9E%E3%82%A4",
        "/my?tab=1",
        "/my#top",
        "https://www.example/my",
        "my",
      ])
        expect(() => parseLoginRecipe(withMarker(value)), value).toThrow();
      // A step, the rejection or an account switch never takes one.
      const link = { by: "href", value: "/my" } as const;
      expect(() => parseLoginRecipe({ ...recipe(), accountSwitch: link })).toThrow();
      expect(() => parseLoginRecipe({ ...recipe(), rejection: link })).toThrow();
      expect(() =>
        parseLoginRecipe({
          ...recipe(),
          steps: [{ kind: "click", path: "/login", target: link, purpose: "submit" }],
        }),
      ).toThrow();
    });

    it("keeps a marker learned on another origin of the site apart (ADR 0022)", () => {
      const marker = (value: string, origin?: string) => ({
        target: { by: "id" as const, value },
        ...(origin ? { origin } : {}),
      });
      const withMarkers = (completion: unknown[]) => ({ ...recipe(), completion });
      // The same element on the recipe's own origin and on another one are two markers.
      expect(
        parseLoginRecipe(withMarkers([marker("a"), marker("a", "https://www.bank.example")]))
          .completion,
      ).toHaveLength(2);
      expect(() =>
        parseLoginRecipe(
          withMarkers([
            marker("a", "https://www.bank.example"),
            marker("a", "https://www.bank.example"),
          ]),
        ),
      ).toThrow();
      // The recipe's own origin is never named, and an origin is exact.
      expect(() => parseLoginRecipe(withMarkers([marker("a", "https://bank.example")]))).toThrow();
      expect(() =>
        parseLoginRecipe(withMarkers([marker("a", "https://www.bank.example/home")])),
      ).toThrow();
    });

    it("refuses an account switch that is a step's button, the rejection or a marker", () => {
      const other = { by: "text", value: "Use another account" } as const;
      expect(parseLoginRecipe({ ...recipe(), accountSwitch: other }).accountSwitch).toEqual(other);
      for (const target of [
        { by: "id", value: "login" },
        { by: "id", value: "rejected" },
        // A marker proves the sign-in wherever it shows, so a login page that shows the
        // switch would read as signed in (ADR 0029).
        { by: "id", value: "authenticated" },
      ])
        expect(() => parseLoginRecipe({ ...recipe(), accountSwitch: target })).toThrow();
    });

    it("requires the start page's kind, and runs only a sign-in recipe (ADR 0035)", () => {
      const { pageKind: _kind, ...kindless } = recipe();
      expect(() => parseLoginRecipe(kindless)).toThrow();
      expect(() => parseLoginRecipe({ ...recipe(), pageKind: "personal-details" })).toThrow();
      expect(runsLogin(parseLoginRecipe({ ...recipe(), pageKind: "sign-in" }))).toBe(true);
      expect(runsLogin(parseLoginRecipe({ ...recipe(), pageKind: "confirm" }))).toBe(false);
      expect(runsLogin(parseLoginRecipe({ ...recipe(), pageKind: "unclear" }))).toBe(false);
    });

    it("accepts a generated recipe whose completion is not learned yet", () => {
      const { completion: _unlearned, ...generated } = recipe();
      expect(parseLoginRecipe(generated)).toEqual(generated);
      expect(() => parseLoginRecipe({ ...generated, completion: null })).toThrow();
    });

    it("requires one explicit event and one field for an input-triggered submission", () => {
      const valid = {
        ...recipe(),
        slots: ["password"],
        maxSubmissions: 1,
        steps: [
          {
            kind: "fill",
            effect: "submit",
            event: "input",
            path: "/login",
            fields: [{ slot: "password", target: { by: "id", value: "password" } }],
          },
        ],
      };
      expect(parseLoginRecipe(valid)).toEqual(valid);
      const step = valid.steps[0]!;
      for (const malformed of [
        { ...valid, steps: [{ ...step, event: undefined }] },
        { ...valid, steps: [{ ...step, event: "blur" }] },
        { ...valid, steps: [{ ...step, effect: "prepare" }] },
        {
          ...valid,
          slots: ["password", "account"],
          steps: [
            {
              ...step,
              fields: [...step.fields, { slot: "account", target: { by: "id", value: "account" } }],
            },
          ],
        },
        {
          ...valid,
          maxSubmissions: 2,
          steps: [
            step,
            {
              kind: "click",
              path: "/login",
              target: { by: "id", value: "login" },
              purpose: "submit",
            },
          ],
        },
      ])
        expect(() => parseLoginRecipe(malformed)).toThrow();
    });

    it("submits a form that shows no button by Enter in the field typed last (ADR 0064)", () => {
      const account = { by: "id", value: "account" } as const;
      const valid = {
        ...recipe(),
        slots: ["account", "password"],
        maxSubmissions: 2,
        steps: [
          { kind: "fill", path: "/login", fields: [{ slot: "account", target: account }] },
          { kind: "click", path: "/login", target: account, purpose: "advance", press: "enter" },
          {
            kind: "fill",
            path: "/login",
            fields: [{ slot: "password", target: { by: "id", value: "password" } }],
          },
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "login" },
            purpose: "submit",
          },
        ],
      };
      expect(parseLoginRecipe(valid)).toEqual({
        ...valid,
        steps: valid.steps.map((step) =>
          step.kind === "fill" ? { ...step, effect: "prepare" } : step,
        ),
      });
      const [fill, enter, ...rest] = valid.steps;
      for (const malformed of [
        // Not after a fill, or after one on another path.
        { ...valid, steps: [enter, fill, ...rest] },
        { ...valid, steps: [{ ...fill, path: "/other" }, enter, ...rest] },
        // Not in the field the fill typed last.
        { ...valid, steps: [fill, { ...enter, target: { by: "id", value: "other" } }, ...rest] },
        {
          ...valid,
          steps: [
            {
              ...fill,
              fields: [...fill!.fields, { slot: "password", target: { by: "id", value: "pin" } }],
            },
            enter,
          ],
        },
        // A button's text or accessible name names no field.
        { ...valid, steps: [fill, { ...enter, target: { by: "text", value: "Next" } }, ...rest] },
        // Into a code.
        {
          ...valid,
          slots: ["totp", "password"],
          steps: [{ ...fill, fields: [{ slot: "totp", target: account }] }, enter, ...rest],
        },
      ])
        expect(() => parseLoginRecipe(malformed)).toThrow();
    });

    it("counts both input advancement and a later click against the effect budget", () => {
      const valid = {
        ...recipe(),
        steps: [
          {
            kind: "fill",
            effect: "advance",
            event: "change",
            path: "/identity",
            fields: [{ slot: "account", target: { by: "id", value: "account" } }],
          },
          recipe().steps[2]!,
          recipe().steps[3]!,
        ],
      };
      expect(parseLoginRecipe(valid)).toEqual(valid);
      expect(() => parseLoginRecipe({ ...valid, maxSubmissions: 1 })).toThrow();
    });

    it("rejects executable, secret-bearing and ambiguous recipe input", () => {
      const valid = recipe();
      for (const malformed of [
        { ...valid, script: "document.body.click()" },
        { ...valid, password: "synthetic-only" },
        { ...valid, origin: "https://bank.example/path" },
        { ...valid, origin: "https://user@bank.example" },
        { ...valid, slots: ["account", "account"] },
        { ...valid, maxSubmissions: 0 },
        { ...valid, maxSubmissions: 9 },
        { ...valid, steps: [{ kind: "eval", source: "alert(1)" }] },
        {
          ...valid,
          steps: [
            {
              kind: "click",
              path: "/identity",
              target: { by: "css", value: "*" },
              purpose: "submit",
            },
          ],
        },
        {
          ...valid,
          steps: [
            {
              kind: "fill",
              path: "/identity",
              fields: [{ slot: "unknown", target: { by: "id", value: "account" } }],
            },
          ],
        },
        {
          ...valid,
          steps: [
            {
              kind: "fill",
              path: "/identity",
              fields: [
                {
                  slot: "account",
                  target: { by: "id", value: "account" },
                  value: "synthetic-only",
                },
              ],
            },
          ],
        },
      ])
        expect(() => parseLoginRecipe(malformed)).toThrow();
    });

    it("accepts ASCII attribute values and exact button text, and fills by attribute only", () => {
      const target = (value: unknown) => v.safeParse(loginTargetSchema, value).success;
      for (const accepted of [
        { by: "name", value: "ctl00$Main$txtUserId" },
        { by: "name", value: "user[login]" },
        { by: "id", value: "a'b\"c" },
        { by: "test-id", value: "sign-in" },
        { by: "data-test", value: "register-button" },
        { by: "password-form-name", value: "acct" },
        { by: "autocomplete", value: "username" },
        { by: "autocomplete", value: "current-password" },
        { by: "text", value: "ログイン" },
        { by: "text", value: "Sign in" },
      ])
        expect(target(accepted)).toBe(true);
      for (const rejected of [
        { by: "id", value: "user id" },
        { by: "id", value: "会員" },
        { by: "id", value: "a\u0000" },
        { by: "test-id", value: "a$b" },
        { by: "data-test", value: "a b" },
        { by: "password-form-name", value: "a b" },
        { by: "autocomplete", value: "new-password" },
        { by: "autocomplete", value: "Username" },
        { by: "autocomplete", value: "username webauthn" },
        { by: "text", value: "" },
        { by: "text", value: " Sign in" },
        { by: "text", value: "Sign  in" },
        { by: "text", value: "Sign\u00a0in" },
        { by: "text", value: "Sign\nin" },
        { by: "text", value: "Sign\u200bin" },
        { by: "text", value: "x".repeat(121) },
        { by: "text", value: "Sign in", extra: true },
      ])
        expect(target(rejected)).toBe(false);
      const valid = recipe();
      const click = { kind: "click", path: "/identity", target: { by: "text", value: "次へ" } };
      expect(() =>
        parseLoginRecipe({ ...valid, steps: [valid.steps[0], { ...click, purpose: "advance" }] }),
      ).not.toThrow();
      expect(() =>
        parseLoginRecipe({
          ...valid,
          steps: [
            {
              kind: "fill",
              path: "/identity",
              fields: [{ slot: "account", target: { by: "text", value: "Account" } }],
            },
          ],
        }),
      ).toThrow();
    });

    it("fills a field by its visible name, a locator of fields only (ADR 0037)", () => {
      const target = (value: unknown) => v.safeParse(loginTargetSchema, value).success;
      expect(target({ by: "label", value: "メールアドレス" })).toBe(true);
      expect(target({ by: "label", value: "Email address" })).toBe(true);
      for (const value of ["", " Email", "Email  address", "Email\naddress", "x".repeat(121)])
        expect(target({ by: "label", value })).toBe(false);
      const valid = recipe();
      const byName = (value: string) => ({
        ...valid,
        steps: [
          {
            kind: "fill",
            path: "/identity",
            fields: [
              { slot: "branch", target: { by: "label", value } },
              { slot: "account", target: { by: "id", value: "account" } },
            ],
          },
          ...valid.steps.slice(1),
        ],
      });
      expect(parseLoginRecipe(byName("支店番号")).steps[0]).toMatchObject({
        fields: [{ target: { by: "label", value: "支店番号" } }, {}],
      });
      expect(() => parseLoginRecipe(byName(""))).toThrow();
      // A list control or a sign-in entry is pressed, so a field's name never names one.
      expect(
        v.is(loginEntryRecipeSchema, {
          version: 1,
          id: "entry-01",
          revision: 1,
          origin: "https://www.example.test",
          entry: { path: "/", target: { by: "label", value: "Login" } },
        }),
      ).toBe(false);
    });

    it("takes a custom-field slot named from the page's text (ADR 0027)", () => {
      const rename = (slot: string) => {
        const named = recipe();
        named.slots[0] = slot;
        const fill = named.steps[0] as Extract<LoginRecipe["steps"][number], { kind: "fill" }>;
        fill.fields[0]!.slot = slot;
        const bound = binding();
        bound.slots[0]!.slot = slot;
        return [named, bound] as const;
      };
      const [named, bound] = rename("会員番号 (ログインID)");
      expect(parseLoginRecipe(named)).toEqual(named);
      expect(parseLoginAccountBinding(bound)).toEqual(bound);
      for (const slot of ["店番  号", " 店番号", "店番\u3000号", "Ｂｒａｎｃｈ", "a".repeat(61)]) {
        const [recipeWith, bindingWith] = rename(slot);
        expect(() => parseLoginRecipe(recipeWith), slot).toThrow();
        expect(() => parseLoginAccountBinding(bindingWith), slot).toThrow();
      }
    });

    it("rejects duplicate bindings and secret-shaped extras", () => {
      const valid = binding();
      for (const malformed of [
        { ...valid, value: "synthetic-only" },
        { ...valid, slots: [...valid.slots, valid.slots[0]] },
        { ...valid, slots: [{ slot: "account", fieldId: "username", value: "synthetic-only" }] },
      ])
        expect(() => parseLoginAccountBinding(malformed)).toThrow();
    });

    it("binds every operation to a finite browser document and operation ID", () => {
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
        stepIndex: 0,
        step: recipe().steps[0],
        expiresAt: 15_000,
      };
      expect(parseLoginOperation(operation)).toEqual(operation);
      for (const malformed of [
        { ...operation, operationId: "" },
        { ...operation, stepIndex: -1 },
        { ...operation, values: { password: "synthetic-only" } },
        { ...operation, document: { ...operation.document, tabId: -1 } },
        { ...operation, document: { ...operation.document, frameId: -1 } },
        { ...operation, document: { ...operation.document, documentId: "" } },
      ])
        expect(() => parseLoginOperation(malformed)).toThrow();
    });
  });
}

export function registerSavedPlanAuthorization({
  recipe,
  binding,
  snapshot,
}: Pick<LoginTestContext, "recipe" | "binding" | "snapshot">): void {
  describe("saved login plan authorization", () => {
    it("resolves only the configured connection, item and explicit field mappings", () => {
      expect(
        resolveLoginPlan(
          snapshot(),
          DUMMY_VAULT_CATALOG,
          "https://bank.example/identity",
          recipe(),
          binding(),
          recipe().slots,
        ),
      ).toMatchObject({
        ok: true,
        account: { connectionId: "demo-personal", itemId: "primary" },
      });
    });

    it("does not fall back to another eligible account when the default is absent or revoked", () => {
      const absent = snapshot();
      absent.settings.siteDefaults = [];
      expect(
        resolveLoginPlan(
          absent,
          DUMMY_VAULT_CATALOG,
          "https://bank.example/identity",
          recipe(),
          binding(),
          recipe().slots,
        ),
      ).toMatchObject({ ok: false });
      const disabled = snapshot();
      disabled.settings.accountPolicies[0]!.enabled = false;
      expect(
        resolveLoginPlan(
          disabled,
          DUMMY_VAULT_CATALOG,
          "https://bank.example/identity",
          recipe(),
          binding(),
          recipe().slots,
        ),
      ).toMatchObject({ ok: false });
      const another = snapshot();
      another.settings.siteDefaults[0]!.itemId = "secondary";
      expect(
        resolveLoginPlan(
          another,
          DUMMY_VAULT_CATALOG,
          "https://bank.example/identity",
          recipe(),
          binding(),
          recipe().slots,
        ),
      ).toMatchObject({ ok: false });
    });

    it("a field exclusion wins over a saved recipe, default and available field", () => {
      // A site exclusion rule only pauses automatic login, which the login runtime enforces;
      // a pick there still plans its account (ADR 0062).
      const paused = snapshot();
      paused.settings.excludedSites = [{ hostname: "bank.example", includeSubdomains: true }];
      expect(
        resolveLoginPlan(
          paused,
          DUMMY_VAULT_CATALOG,
          "https://bank.example/identity",
          recipe(),
          binding(),
          recipe().slots,
        ),
      ).toMatchObject({ ok: true });
      const fieldExcluded = snapshot();
      fieldExcluded.settings.itemPolicies = [
        {
          provider: "dummy",
          server: "cloud-us",
          userId: "demo-personal-account",
          itemId: "primary",
          itemName: "Demo primary account",
          selected: false,
          excluded: false,
          excludedFields: ["password"],
        },
      ];
      expect(
        resolveLoginPlan(
          fieldExcluded,
          DUMMY_VAULT_CATALOG,
          "https://bank.example/identity",
          recipe(),
          binding(),
          recipe().slots,
        ),
      ).toMatchObject({ ok: false });
    });

    it("refuses destination changes, incomplete mappings and unmapped vault fields", () => {
      const missing = binding();
      missing.slots = missing.slots.filter((entry) => entry.slot !== "password");
      const wrongField = binding();
      wrongField.slots[0]!.fieldId = "nonexistent";
      const wrongOrigin = binding();
      wrongOrigin.origin = "https://mail.example";
      for (const candidate of [missing, wrongField, wrongOrigin]) {
        expect(
          resolveLoginPlan(
            snapshot(),
            DUMMY_VAULT_CATALOG,
            "https://bank.example/identity",
            recipe(),
            candidate,
            recipe().slots,
          ),
        ).toMatchObject({ ok: false });
      }
      expect(
        resolveLoginPlan(
          snapshot(),
          DUMMY_VAULT_CATALOG,
          "https://evil.example/identity",
          recipe(),
          binding(),
          recipe().slots,
        ),
      ).toMatchObject({ ok: false });
    });
  });
}

export function registerShadowLocators(): void {
  describe("locators inside shadow hosts (ADR 0070)", () => {
    const field = { by: "id", value: "input", within: [{ by: "id", value: "login-password" }] };
    it("takes up to three hosts named by id, name or test ID on field and attribute locators", () => {
      for (const target of [
        field,
        { by: "data-test", value: "submit", within: [{ by: "data-test", value: "login" }] },
        { by: "name", value: "password", within: [{ by: "test-id", value: "login.form" }] },
        { by: "autocomplete", value: "username", within: [{ by: "name", value: "user" }] },
        {
          by: "label",
          value: "Password",
          within: [
            { by: "id", value: "a" },
            { by: "id", value: "b" },
          ],
        },
        {
          by: "test-id",
          value: "submit",
          within: [
            { by: "id", value: "a" },
            { by: "name", value: "b" },
            { by: "test-id", value: "c" },
          ],
        },
      ])
        expect(v.is(loginTargetSchema, target), JSON.stringify(target)).toBe(true);
    });

    it("refuses hosts on text locators, too many hosts and hosts named by anything else", () => {
      for (const target of [
        { by: "text", value: "Log in", within: [{ by: "id", value: "a" }] },
        { by: "accessible-name", value: "Select", within: [{ by: "id", value: "a" }] },
        { by: "password-form-name", value: "acct", within: [{ by: "id", value: "a" }] },
        { ...field, within: [] },
        { ...field, within: [field.within[0], field.within[0], field.within[0], field.within[0]] },
        { ...field, within: [{ by: "label", value: "Password" }] },
        { ...field, within: [{ by: "id", value: "a b" }] },
        { ...field, within: [{ by: "id", value: "a", within: [{ by: "id", value: "b" }] }] },
      ])
        expect(v.is(loginTargetSchema, target), JSON.stringify(target)).toBe(false);
    });

    it("tells locators in other hosts apart", () => {
      const parsed = v.parse(loginTargetSchema, field);
      expect(sameLoginTarget(parsed, v.parse(loginTargetSchema, field))).toBe(true);
      expect(sameLoginTarget(parsed, { by: "id", value: "input" })).toBe(false);
      expect(
        sameLoginTarget(parsed, { ...parsed, within: [{ by: "id", value: "login-username" }] }),
      ).toBe(false);
    });
  });
}
