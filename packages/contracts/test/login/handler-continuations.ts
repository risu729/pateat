import { describe, expect, it } from "vitest";
import {
  continuesRecipe,
  replacesClick,
  extendsRecipe,
  refillsLoginSlot,
  loginFieldFacts,
  loginFieldSource,
  parseLoginRecipe,
  type LoginRecipe,
  type LoginStep,
} from "../../src/login";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  getItemEligibility,
  type VaultItemMetadata,
} from "../../src/settings";
import type { LoginTestContext } from "./context";

export function registerHandlerContinuations({
  recipe,
  passkeyHandler,
}: Pick<LoginTestContext, "recipe" | "passkeyHandler">): void {
  describe("taking over a newer revision", () => {
    const { completion, ...unlearned } = recipe();
    const base = parseLoginRecipe(unlearned);
    const next = (change: Partial<LoginRecipe>, from: LoginRecipe = base) =>
      parseLoginRecipe({ ...from, revision: from.revision + 1, ...change });

    it("accepts a revision that adds handlers, a completion, or both", () => {
      expect(extendsRecipe(base, next({ handlers: [passkeyHandler()] }))).toBe(true);
      expect(extendsRecipe(base, next({ completion }))).toBe(true);
      expect(extendsRecipe(base, next({ handlers: [passkeyHandler()], completion }))).toBe(true);
      // Revisions may skip numbers; handlers are appended after the existing ones.
      const handled = next({ handlers: [passkeyHandler()] });
      expect(
        extendsRecipe(
          handled,
          next(
            {
              revision: handled.revision + 3,
              handlers: [passkeyHandler(), passkeyHandler("/password", { by: "id", value: "key" })],
              completion,
            },
            handled,
          ),
        ),
      ).toBe(true);
      // An unchanged completion is kept, and a later marker is appended (ADR 0029).
      const learned = next({ completion });
      expect(extendsRecipe(learned, next({ handlers: [passkeyHandler()] }, learned))).toBe(true);
      const account = { target: { by: "id", value: "profile" } } as const;
      expect(extendsRecipe(learned, next({ completion: [...completion!, account] }, learned))).toBe(
        true,
      );
      // A marker put before the learned ones changes their order.
      expect(extendsRecipe(learned, next({ completion: [account, ...completion!] }, learned))).toBe(
        false,
      );
    });

    it("compares the recipe whatever the key order", () => {
      const reordered = Object.fromEntries(
        Object.entries(next({ handlers: [passkeyHandler()] })).reverse(),
      ) as LoginRecipe;
      reordered.steps = reordered.steps.map(
        (step) => Object.fromEntries(Object.entries(step).reverse()) as typeof step,
      );
      expect(extendsRecipe(base, reordered)).toBe(true);
    });

    it.each<[string, (recipe: LoginRecipe) => Partial<LoginRecipe>]>([
      [
        "changed steps",
        (from) => ({
          steps: from.steps.map((step, index) =>
            index === 1 ? { ...step, path: "/identity-next" } : step,
          ),
        }),
      ],
      ["changed slots", (from) => ({ slots: [...from.slots].reverse() })],
      ["a changed submission budget", () => ({ maxSubmissions: 3 })],
      ["a changed rejection", () => ({ rejection: { by: "id", value: "error" } })],
      ["an added account switch", () => ({ accountSwitch: { by: "text", value: "Switch" } })],
      ["another origin", () => ({ origin: "https://other.example" })],
      ["another ID", () => ({ id: "bank-login-2" })],
    ])("refuses %s", (_label, change) => {
      expect(extendsRecipe(base, next({ ...change(base), handlers: [passkeyHandler()] }))).toBe(
        false,
      );
    });

    it("refuses removed, reordered or changed handlers and a changed completion", () => {
      const second = passkeyHandler("/password", { by: "id", value: "key" });
      const handled = next({ handlers: [passkeyHandler(), second], completion });
      expect(
        extendsRecipe(handled, next({ handlers: [passkeyHandler()], completion }, handled)),
      ).toBe(false);
      expect(extendsRecipe(handled, next({ handlers: undefined, completion }, handled))).toBe(
        false,
      );
      expect(
        extendsRecipe(handled, next({ handlers: [second, passkeyHandler()], completion }, handled)),
      ).toBe(false);
      expect(
        extendsRecipe(
          handled,
          next(
            {
              handlers: [passkeyHandler("/webauthn", { by: "id", value: "other-key" }), second],
              completion,
            },
            handled,
          ),
        ),
      ).toBe(false);
      expect(
        extendsRecipe(
          handled,
          next(
            {
              completion: [{ target: { by: "id", value: "sign-out" } }],
            },
            handled,
          ),
        ),
      ).toBe(false);
      // A learned completion is never dropped either.
      const { completion: _dropped, ...withoutCompletion } = handled;
      expect(
        extendsRecipe(
          handled,
          parseLoginRecipe({ ...withoutCompletion, revision: handled.revision + 1 }),
        ),
      ).toBe(false);
    });

    it("refuses an equal or lower revision", () => {
      const handled = next({ handlers: [passkeyHandler()] });
      expect(extendsRecipe(handled, { ...handled, revision: base.revision + 1 })).toBe(false);
      expect(
        extendsRecipe(handled, { ...handled, handlers: [passkeyHandler()], revision: 1 }),
      ).toBe(false);
      expect(extendsRecipe(base, base)).toBe(false);
    });
  });

  describe("continuing after the final advance (ADR 0018)", () => {
    const { completion, ...unlearned } = recipe();
    const full = parseLoginRecipe(unlearned);
    // The identity page alone, which ends in its advance; the password page follows.
    const first = parseLoginRecipe({
      ...full,
      slots: ["branch", "account"],
      steps: full.steps.slice(0, 2),
      maxSubmissions: 1,
    });
    const continued = parseLoginRecipe({ ...full, revision: 2 });
    const next = (change: Partial<LoginRecipe>) => parseLoginRecipe({ ...continued, ...change });

    it("accepts a newer revision whose steps extend the advancing ones", () => {
      expect(continuesRecipe(first, continued)).toBe(true);
      // With a completion learned at once, a newly added account switch, or a later revision.
      expect(continuesRecipe(first, next({ completion }))).toBe(true);
      expect(continuesRecipe(first, next({ accountSwitch: { by: "text", value: "Switch" } }))).toBe(
        true,
      );
      expect(continuesRecipe(first, next({ revision: 5 }))).toBe(true);
      expect(continuesRecipe(first, next({ handlers: [passkeyHandler()] }))).toBe(true);
      // The new revision may end in another advance, to be continued again.
      const third = next({ steps: continued.steps.slice(0, 3).concat(first.steps[1]!) });
      expect(continuesRecipe(first, third)).toBe(true);
    });

    it.each<[string, Partial<LoginRecipe>]>([
      ["the same revision", { revision: 1 }],
      ["another ID", { id: "bank-login-2" }],
      ["another origin", { origin: "https://other.example" }],
      ["no added step", { steps: first.steps, slots: first.slots, maxSubmissions: 1 }],
      [
        "a changed earlier step",
        {
          steps: continued.steps.map((step, index) =>
            index === 1 ? { ...step, path: "/identity-next" } : step,
          ),
        },
      ],
      ["a dropped earlier slot", { slots: ["password", "account"] }],
      [
        // The identity form shown again where it posted, as after an unknown account.
        "a later page that fills an earlier slot again",
        {
          slots: first.slots,
          steps: [
            ...first.steps,
            ...first.steps.map((step) => ({ ...step, path: "/identity/again" })),
          ],
          maxSubmissions: 2,
        },
      ],
      [
        "alternatives",
        {
          alternatives: [
            {
              slots: ["password"],
              steps: [
                {
                  kind: "fill",
                  effect: "prepare",
                  path: "/identity",
                  fields: [{ slot: "password", target: { by: "id", value: "pin" } }],
                },
                {
                  kind: "click",
                  path: "/identity",
                  target: { by: "id", value: "pin-login" },
                  purpose: "submit",
                },
              ],
            },
          ],
          slots: ["branch", "account", "password"],
        },
      ],
      ["a changed rejection", { rejection: { by: "id", value: "error" } }],
      // A continuation keeps its first page's kind (ADR 0035).
      ["a changed page kind", { pageKind: "confirm" }],
      [
        "a passkey route",
        { passkey: { path: "/identity", target: { by: "text", value: "Use a passkey" } } },
      ],
    ])("refuses %s", (_label, change) => {
      expect(continuesRecipe(first, { ...continued, ...change } as LoginRecipe)).toBe(false);
    });

    it("refuses to continue a recipe that is complete or does not advance, and keeps its account switch and handlers", () => {
      expect(
        continuesRecipe(parseLoginRecipe({ ...first, completion }), next({ completion })),
      ).toBe(false);
      expect(continuesRecipe(continued, next({ revision: 3 }))).toBe(false);
      const switched = parseLoginRecipe({
        ...first,
        accountSwitch: { by: "text", value: "Switch" },
      });
      expect(continuesRecipe(switched, next({}))).toBe(false);
      expect(
        continuesRecipe(switched, next({ accountSwitch: { by: "text", value: "Switch" } })),
      ).toBe(true);
      const handled = parseLoginRecipe({ ...first, handlers: [passkeyHandler()] });
      expect(continuesRecipe(handled, next({}))).toBe(false);
      expect(continuesRecipe(handled, next({ handlers: [passkeyHandler()] }))).toBe(true);
    });
  });

  describe("replacing a disabled final advance (ADR 0018 amendment of 2026-11-03)", () => {
    const email = { by: "id", value: "email" } as const;
    const login = { by: "text", value: "Log In" } as const;
    // The email, then a Log In that stays disabled until a password input opens.
    const first = parseLoginRecipe({
      version: 1,
      id: "mail-login",
      revision: 1,
      origin: "https://mail.example",
      pageKind: "sign-in",
      slots: ["username"],
      steps: [
        {
          kind: "fill",
          effect: "prepare",
          path: "/login",
          fields: [{ slot: "username", target: email }],
        },
        { kind: "click", path: "/login", target: login, purpose: "advance" },
      ],
      maxSubmissions: 1,
    });
    const password = {
      kind: "fill",
      effect: "prepare",
      path: "/login",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    } as const;
    const submit = { kind: "click", path: "/login", target: login, purpose: "submit" } as const;
    const replaced = (steps: LoginStep[] = [password, submit], change: Partial<LoginRecipe> = {}) =>
      parseLoginRecipe({
        ...first,
        revision: 2,
        slots: ["username", "password"],
        steps: [first.steps[0]!, ...steps],
        ...change,
      });

    it("accepts the page's password and the same click in place of the final click", () => {
      expect(continuesRecipe(first, replaced(), { replacesLast: true })).toBe(true);
      expect(replacesClick(first.steps[1]!, [password, submit])).toBe(true);
      // Without the option, the steps must follow the click instead.
      expect(continuesRecipe(first, replaced())).toBe(false);
      const following = replaced([first.steps[1]!, password, submit], { maxSubmissions: 2 });
      expect(continuesRecipe(first, following)).toBe(true);
      expect(continuesRecipe(first, following, { replacesLast: true })).toBe(false);
    });

    it.each<[string, LoginStep[]]>([
      ["no password", [submit]],
      [
        "another final button",
        [password, { ...submit, target: { by: "text", value: "Continue" } }],
      ],
      ["a final fill", [submit, password]],
      ["the email again", [first.steps[0]!, password, submit]],
    ])("refuses steps with %s", (_label, steps) => {
      const next = parseLoginRecipe({
        ...replaced(),
        steps: [first.steps[0]!, ...steps],
      });
      expect(continuesRecipe(first, next, { replacesLast: true })).toBe(false);
    });

    it("refuses to replace a final fill or a recipe that ends without advancing", () => {
      expect(replacesClick(first.steps[0]!, [password, submit])).toBe(false);
      expect(
        continuesRecipe(replaced(), replaced([password, submit], { revision: 3 }), {
          replacesLast: true,
        }),
      ).toBe(false);
    });
  });

  describe("continuesRecipe edge cases, probed independently (ADR 0018)", () => {
    const { completion: _learned, ...unlearned } = recipe();
    const full = parseLoginRecipe(unlearned);
    const first = parseLoginRecipe({
      ...full,
      slots: ["branch", "account"],
      steps: full.steps.slice(0, 2),
      maxSubmissions: 1,
    });
    const continued = parseLoginRecipe({ ...full, revision: 2 });
    const key = passkeyHandler("/key", { by: "id", value: "key" });
    const other = passkeyHandler("/other", { by: "id", value: "other-key" });
    const alternatives: LoginRecipe["alternatives"] = [
      {
        slots: ["password"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/identity",
            fields: [{ slot: "password", target: { by: "id", value: "pin" } }],
          },
          {
            kind: "click",
            path: "/identity",
            target: { by: "id", value: "pin-login" },
            purpose: "submit",
          },
        ],
      },
    ];
    // Unparsed on purpose: the comparison alone is probed, whatever the schema accepts.
    const changed = (base: LoginRecipe, change: Partial<LoginRecipe>) =>
      ({ ...base, ...change }) as LoginRecipe;

    it.each<[string, Partial<LoginRecipe>]>([
      [
        "earlier steps in another order",
        { steps: [full.steps[1]!, full.steps[0]!, ...full.steps.slice(2)] },
      ],
      [
        "an earlier fill's fields in another order",
        {
          steps: [
            {
              ...full.steps[0]!,
              fields: [
                { slot: "account", target: { by: "id", value: "account" } },
                { slot: "branch", target: { by: "id", value: "branch" } },
              ],
            } as LoginRecipe["steps"][number],
            ...full.steps.slice(1),
          ],
        },
      ],
      [
        "an earlier step's target changed",
        {
          steps: [
            full.steps[0]!,
            {
              kind: "click",
              path: "/identity",
              target: { by: "text", value: "Next" },
              purpose: "advance",
            },
            ...full.steps.slice(2),
          ],
        },
      ],
      [
        "the final advance turned into a submit",
        {
          steps: [
            full.steps[0]!,
            {
              kind: "click",
              path: "/identity",
              target: { by: "id", value: "next" },
              purpose: "submit",
            },
            ...full.steps.slice(2),
          ],
        },
      ],
      [
        "steps inserted before the appended page",
        {
          steps: [
            full.steps[0]!,
            {
              kind: "fill",
              effect: "prepare",
              path: "/identity",
              fields: [{ slot: "password", target: { by: "id", value: "early" } }],
            },
            ...full.steps.slice(1),
          ],
        },
      ],
      ["a renamed slot", { slots: ["branch", "account-number", "password"] }],
      ["fewer submissions", { maxSubmissions: 0 }],
      ["the rejection removed", { rejection: undefined }],
    ])("refuses %s", (_label, change) => {
      expect(continuesRecipe(first, changed(continued, change))).toBe(false);
    });

    it("refuses a changed, reordered or replaced handler, and accepts only appended ones", () => {
      const handled = changed(first, { handlers: [key, other] });
      expect(continuesRecipe(handled, changed(continued, { handlers: [key, other] }))).toBe(true);
      const appended = passkeyHandler("/third", { by: "id", value: "third-key" });
      expect(
        continuesRecipe(handled, changed(continued, { handlers: [key, other, appended] })),
      ).toBe(true);
      for (const handlers of [
        [other, key],
        [key],
        [key, passkeyHandler("/other", { by: "id", value: "changed" })],
        [key, passkeyHandler("/moved", { by: "id", value: "other-key" })],
        [appended, key, other],
        [key, appended, other],
      ])
        expect(
          continuesRecipe(handled, changed(continued, { handlers })),
          JSON.stringify(handlers),
        ).toBe(false);
      // A totp handler in place of the passkey handler is a changed handler too.
      expect(
        continuesRecipe(
          changed(first, { handlers: [key] }),
          changed(continued, {
            handlers: [{ kind: "totp", path: "/key", target: { by: "id", value: "key" } } as never],
          }),
        ),
      ).toBe(false);
    });

    it("refuses an account switch that is changed or dropped, and keeps an unchanged one", () => {
      const switched = changed(first, { accountSwitch: { by: "text", value: "Switch" } });
      expect(
        continuesRecipe(
          switched,
          changed(continued, { accountSwitch: { by: "text", value: "Switch" } }),
        ),
      ).toBe(true);
      for (const accountSwitch of [
        { by: "text", value: "Use another account" },
        { by: "id", value: "Switch" },
        undefined,
      ] as const)
        expect(continuesRecipe(switched, changed(continued, { accountSwitch }))).toBe(false);
    });

    it("refuses a passkey route that is changed or dropped, and keeps an unchanged one", () => {
      const passkey = { path: "/identity", target: { by: "id", value: "passkey" } } as const;
      const withPasskey = changed(first, { passkey });
      expect(continuesRecipe(withPasskey, changed(continued, { passkey }))).toBe(true);
      expect(continuesRecipe(withPasskey, changed(continued, { passkey: undefined }))).toBe(false);
      expect(
        continuesRecipe(
          withPasskey,
          changed(continued, {
            passkey: { ...passkey, target: { by: "text", value: "Use a passkey" } },
          }),
        ),
      ).toBe(false);
    });

    it("refuses alternatives on either side, even identical ones", () => {
      const varied = changed(first, { alternatives, slots: ["branch", "account", "password"] });
      expect(continuesRecipe(varied, changed(continued, { alternatives }))).toBe(false);
      expect(continuesRecipe(varied, continued)).toBe(false);
      expect(continuesRecipe(first, changed(continued, { alternatives }))).toBe(false);
    });

    it("refuses a rejection added to a recipe that had none", () => {
      const plain = changed(first, { rejection: undefined });
      expect(continuesRecipe(plain, changed(continued, { rejection: undefined }))).toBe(true);
      expect(continuesRecipe(plain, continued)).toBe(false);
    });

    it("compares steps by value, not by key order, and accepts an advancing fill", () => {
      const reordered = full.steps.map(
        (step) => Object.fromEntries(Object.entries(step).reverse()) as typeof step,
      );
      expect(continuesRecipe(first, changed(continued, { steps: reordered }))).toBe(true);
      // A fill that advances on its own ends the first page as a click would.
      const autoAdvance = changed(first, {
        steps: [{ ...full.steps[0]!, effect: "advance" } as LoginRecipe["steps"][number]],
      });
      expect(
        continuesRecipe(
          autoAdvance,
          changed(continued, { steps: [autoAdvance.steps[0]!, ...full.steps.slice(2)] }),
        ),
      ).toBe(true);
      // A recipe ending in a preparing fill has no advance to continue after.
      const prepared = changed(first, { steps: [full.steps[0]!] });
      expect(
        continuesRecipe(
          prepared,
          changed(continued, { steps: [full.steps[0]!, ...full.steps.slice(2)] }),
        ),
      ).toBe(false);
    });

    it("refuses an appended page that fills an earlier slot again, among new ones too", () => {
      const refill = (fields: { slot: string; value: string }[]) =>
        ({
          kind: "fill",
          effect: "prepare",
          path: "/password",
          fields: fields.map(({ slot, value }) => ({ slot, target: { by: "id", value } })),
        }) as LoginRecipe["steps"][number];
      // The account filled again beside the password, in one fill or a later one.
      expect(
        continuesRecipe(
          first,
          changed(continued, {
            steps: [
              ...first.steps,
              refill([
                { slot: "password", value: "password" },
                { slot: "account", value: "account-again" },
              ]),
              full.steps[3]!,
            ],
          }),
        ),
      ).toBe(false);
      expect(
        continuesRecipe(
          first,
          changed(continued, {
            steps: [
              ...full.steps.slice(0, 3),
              refill([{ slot: "branch", value: "branch" }]),
              full.steps[3]!,
            ],
          }),
        ),
      ).toBe(false);
      expect(
        refillsLoginSlot(first.steps, [refill([{ slot: "password", value: "password" }])]),
      ).toBe(false);
      // A slot filled twice within the appended steps alone is not a refill of an earlier one.
      expect(
        refillsLoginSlot(first.steps, [
          refill([{ slot: "password", value: "password" }]),
          refill([{ slot: "password", value: "password-again" }]),
        ]),
      ).toBe(false);
      expect(
        refillsLoginSlot(first.steps, [full.steps[3]!, refill([{ slot: "branch", value: "x" }])]),
      ).toBe(true);
      // Clicks and an empty addition fill nothing.
      expect(refillsLoginSlot(first.steps, [])).toBe(false);
      expect(refillsLoginSlot(first.steps, [full.steps[1]!])).toBe(false);
    });

    it("accepts the earlier slots in any order beside the new ones", () => {
      // As long as every earlier slot is kept.
      expect(
        continuesRecipe(first, changed(continued, { slots: ["password", "account", "branch"] })),
      ).toBe(true);
    });
  });

  describe("item facts", () => {
    const item = (fields: VaultItemMetadata["fields"]) => ({ fields });
    const builtIn = (empty: { password?: boolean; totp?: boolean } = {}) =>
      item([
        { id: "login.username", label: "Username", name: null, kind: "text" },
        {
          id: "login.password",
          label: "Password",
          name: null,
          kind: "hidden",
          ...(empty.password ? { empty: true as const } : {}),
        },
        {
          id: "login.totp-code",
          label: "Verification code",
          name: null,
          kind: "otp",
          ...(empty.totp ? { empty: true as const } : {}),
        },
      ]);
    const allowed = ["login.username", "login.password", "login.totp-code"];

    it("reads the password and TOTP facts from the catalog's empty flags", () => {
      expect(loginFieldFacts(builtIn(), allowed)).toEqual({ password: true, totp: true });
      expect(loginFieldFacts(builtIn({ password: true }), allowed)).toEqual({
        password: false,
        totp: true,
      });
      expect(loginFieldFacts(builtIn({ totp: true }), allowed)).toEqual({
        password: true,
        totp: false,
      });
      // A missing field holds nothing.
      expect(loginFieldFacts(item([]), allowed)).toEqual({ password: false, totp: false });
    });

    it("counts an allowed Linked field like the built-in field it reads", () => {
      const linked = item([
        ...builtIn({ totp: true }).fields,
        {
          id: "custom.s.0",
          label: "Linked password",
          name: "pw",
          kind: "linked",
          linkedFieldId: "login.password",
        },
      ]);
      expect(loginFieldFacts(linked, ["login.username", "custom.s.0"])).toEqual({
        password: true,
        totp: false,
      });
      expect(loginFieldSource(linked, "custom.s.0")).toBe("login.password");
      expect(loginFieldSource(linked, "login.username")).toBe("login.username");
      expect(
        loginFieldFacts(item([...builtIn({ password: true }).fields, ...linked.fields.slice(3)]), [
          "custom.s.0",
        ]),
      ).toEqual({ password: false, totp: false });
    });

    it("counts an excluded field as missing", () => {
      expect(loginFieldFacts(builtIn(), ["login.username", "login.totp-code"])).toEqual({
        password: false,
        totp: true,
      });
      expect(loginFieldFacts(builtIn(), ["login.username", "login.password"])).toEqual({
        password: true,
        totp: false,
      });
      // The allowed IDs are the eligibility's, which drop excluded fields.
      const catalog = structuredClone(DUMMY_VAULT_CATALOG);
      const primary = catalog.connections[0]!.items[0]!;
      primary.fields = builtIn().fields;
      const settings = createDefaultSettings(catalog);
      settings.itemPolicies = [
        {
          provider: "dummy",
          server: "cloud-us",
          userId: "demo-personal-account",
          itemId: "primary",
          itemName: primary.label,
          selected: false,
          excluded: false,
          excludedFields: ["login.password"],
        },
      ];
      const eligibility = getItemEligibility(settings, catalog, "demo-personal", "primary");
      expect(eligibility.eligible).toBe(true);
      if (eligibility.eligible)
        expect(loginFieldFacts(primary, eligibility.fieldIds)).toEqual({
          password: false,
          totp: true,
        });
    });
  });
}
