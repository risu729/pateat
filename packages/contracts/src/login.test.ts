import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  extendsRecipe,
  handlerSteps,
  loginFieldFacts,
  loginFieldSource,
  loginTargetSchema,
  parseLoginAccountBinding,
  parseLoginOperation,
  parseLoginRecipe,
  resolveLoginPlan,
  type LoginAccountBinding,
  type LoginRecipe,
  type LoginTarget,
} from "./login";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  getItemEligibility,
  type SettingsSnapshot,
  type VaultItemMetadata,
} from "./settings";

function recipe(): LoginRecipe {
  return {
    version: 1,
    id: "bank-login",
    revision: 1,
    origin: "https://bank.example",
    slots: ["branch", "account", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/identity",
        fields: [
          { slot: "branch", target: { by: "id", value: "branch" } },
          { slot: "account", target: { by: "id", value: "account" } },
        ],
      },
      { kind: "click", path: "/identity", target: { by: "id", value: "next" }, purpose: "advance" },
      {
        kind: "fill",
        effect: "prepare",
        path: "/password",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      },
      { kind: "click", path: "/password", target: { by: "id", value: "login" }, purpose: "submit" },
    ],
    completion: { path: "/authenticated", target: { by: "id", value: "authenticated" } },
    rejection: { by: "id", value: "rejected" },
    maxSubmissions: 2,
  };
}

function binding(): LoginAccountBinding {
  return {
    origin: "https://bank.example",
    connectionId: "demo-personal",
    itemId: "primary",
    slots: [
      { slot: "branch", fieldId: "branch" },
      { slot: "account", fieldId: "username" },
      { slot: "password", fieldId: "password" },
    ],
  };
}

function snapshot(): SettingsSnapshot {
  const settings = createDefaultSettings();
  settings.siteDefaults = [
    {
      origin: "https://bank.example",
      provider: "dummy",
      userId: "demo-personal-account",
      itemId: "primary",
    },
  ];
  return { version: 1, revision: 4, settings };
}

describe("declarative login boundaries", () => {
  it("accepts separate multi-page field mappings without containing values", () => {
    expect(parseLoginRecipe(recipe())).toEqual(recipe());
    expect(parseLoginAccountBinding(binding())).toEqual(binding());
  });
  it("bounds the elements a completion requires to be absent", () => {
    const base = recipe();
    const absent = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ by: "id" as const, value: `f${index}` }));
    const withAbsent = (targets: unknown[]) => ({
      ...base,
      completion: { ...base.completion, absent: targets },
    });
    expect(parseLoginRecipe(withAbsent(absent(4))).completion?.absent).toHaveLength(4);
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
        { kind: "click", path: "/identity", target: { by: "id", value: "go" }, purpose: "submit" },
      ],
    };
    expect(() => parseLoginRecipe(wide)).toThrow();
    expect(parseLoginRecipe({ ...wide, rejection: undefined }).steps).toHaveLength(2);
  });

  it("refuses an account switch that is a step's button or the rejection", () => {
    const other = { by: "text", value: "Use another account" } as const;
    expect(parseLoginRecipe({ ...recipe(), accountSwitch: other }).accountSwitch).toEqual(other);
    for (const target of [
      { by: "id", value: "login" },
      { by: "id", value: "rejected" },
    ])
      expect(() => parseLoginRecipe({ ...recipe(), accountSwitch: target })).toThrow();
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
              { slot: "account", target: { by: "id", value: "account" }, value: "synthetic-only" },
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
      { by: "text", value: "ログイン" },
      { by: "text", value: "Sign in" },
    ])
      expect(target(accepted)).toBe(true);
    for (const rejected of [
      { by: "id", value: "user id" },
      { by: "id", value: "会員" },
      { by: "id", value: "a\u0000" },
      { by: "test-id", value: "a$b" },
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

describe("saved login plan authorization", () => {
  it("resolves only the configured connection, item and explicit field mappings", () => {
    expect(
      resolveLoginPlan(
        snapshot(),
        DUMMY_VAULT_CATALOG,
        "https://bank.example/identity",
        recipe(),
        binding(),
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
      ),
    ).toMatchObject({ ok: false });
    const disabled = snapshot();
    disabled.settings.connections[0]!.enabled = false;
    expect(
      resolveLoginPlan(
        disabled,
        DUMMY_VAULT_CATALOG,
        "https://bank.example/identity",
        recipe(),
        binding(),
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
      ),
    ).toMatchObject({ ok: false });
  });

  it("exclusion wins over a saved recipe, default and available field", () => {
    const excluded = snapshot();
    excluded.settings.excludedSites = [{ hostname: "bank.example", includeSubdomains: true }];
    expect(
      resolveLoginPlan(
        excluded,
        DUMMY_VAULT_CATALOG,
        "https://bank.example/identity",
        recipe(),
        binding(),
      ),
    ).toMatchObject({ ok: false });
    const fieldExcluded = snapshot();
    fieldExcluded.settings.connections[0]!.excludedFields = [
      { itemId: "primary", fieldId: "password" },
    ];
    expect(
      resolveLoginPlan(
        fieldExcluded,
        DUMMY_VAULT_CATALOG,
        "https://bank.example/identity",
        recipe(),
        binding(),
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
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("second-factor page handlers (ADR 0027)", () => {
  const securityKey = { by: "text", value: "Use security key" } as const;
  const passkeyHandler = (path = "/webauthn", target: LoginTarget = securityKey) => ({
    kind: "passkey" as const,
    path,
    target,
  });
  const withHandlers = (handlers: unknown[], base: LoginRecipe = recipe()) => ({
    ...base,
    handlers,
  });

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
    expect(() =>
      parseLoginRecipe(withHandlers([passkeyHandler("/authenticated", marker)])),
    ).toThrow();
    // The same element on another path proves nothing on the completion's page.
    expect(
      parseLoginRecipe(withHandlers([passkeyHandler("/webauthn", marker)])).handlers,
    ).toHaveLength(1);
  });

  it("derives a passkey handler's steps from its kind", () => {
    expect(handlerSteps(passkeyHandler())).toEqual([
      { kind: "click", path: "/webauthn", target: securityKey, purpose: "submit" },
    ]);
  });

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
      // An unchanged completion is kept.
      const learned = next({ completion });
      expect(extendsRecipe(learned, next({ handlers: [passkeyHandler()] }, learned))).toBe(true);
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
              completion: { path: "/home", target: { by: "id", value: "sign-out" } },
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
      settings.connections[0]!.excludedFields = [{ itemId: "primary", fieldId: "login.password" }];
      const eligibility = getItemEligibility(settings, catalog, "demo-personal", "primary");
      expect(eligibility.eligible).toBe(true);
      if (eligibility.eligible)
        expect(loginFieldFacts(primary, eligibility.fieldIds)).toEqual({
          password: false,
          totp: true,
        });
    });
  });
});
