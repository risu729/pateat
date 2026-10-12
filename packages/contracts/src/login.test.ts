import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  chooseLoginRoute,
  chooserBranch,
  chooserRoute,
  CHOOSER_ENTRY_TARGET,
  continuesRecipe,
  extendsRecipe,
  refillsLoginSlot,
  handlerSteps,
  handlerTargets,
  isLoginRouteRecipe,
  loginAutocompleteTokens,
  loginChooserRecipeSchema,
  loginEntryRecipeSchema,
  passkeyAnswersRequest,
  passwordVariants,
  recipeHasRoute,
  recipeSlots,
  recipeStartSteps,
  routeFillTargets,
  routePaths,
  routeSignInPaths,
  routeSignInTargets,
  routeSlots,
  routeSteps,
  storedLoginRecipeSchema,
  storedRecipeSlots,
  storedRecipeStartPath,
  withChooserBranch,
  loginFieldFacts,
  loginFieldSource,
  loginRecipeSchema,
  loginTargetSchema,
  parseLoginAccountBinding,
  parseLoginOperation,
  parseLoginRecipe,
  resolveLoginPlan,
  type LoginAccountBinding,
  type LoginRecipe,
  type LoginTarget,
  type StoredLoginRecipe,
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
    completion: [{ target: { by: "id", value: "authenticated" } }],
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
        { kind: "click", path: "/identity", target: { by: "id", value: "go" }, purpose: "submit" },
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
    expect(parseLoginRecipe(withMarkers(["a", "b", "c", "d"].map(marker))).completion).toHaveLength(
      4,
    );
    expect(() => parseLoginRecipe(withMarkers(["a", "b", "c", "d", "e"].map(marker)))).toThrow();
    expect(() => parseLoginRecipe(withMarkers([]))).toThrow();
    expect(() => parseLoginRecipe(withMarkers([marker("a"), marker("a")]))).toThrow();
    // A marker has no path: it proves a sign-in on any path.
    expect(() => parseLoginRecipe(withMarkers([{ ...marker("a"), path: "/home" }]))).toThrow();
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
    disabled.settings.connections[0]!.enabled = false;
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
        recipe().slots,
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
    // A marker proves a sign-in on any path, so no handler's element is one on any path.
    for (const path of ["/authenticated", "/webauthn"])
      expect(() => parseLoginRecipe(withHandlers([passkeyHandler(path, marker)]))).toThrow();
  });

  it("derives a passkey handler's steps from its kind", () => {
    expect(handlerSteps(passkeyHandler())).toEqual([
      { kind: "click", path: "/webauthn", target: securityKey, purpose: "submit" },
    ]);
  });

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

describe("password route variants (ADR 0027)", () => {
  const id = (value: string) => ({ by: "id" as const, value });
  const fill = (slots: string[], path = "/login") => ({
    kind: "fill" as const,
    effect: "prepare" as const,
    path,
    fields: slots.map((slot) => ({ slot, target: id(slot) })),
  });
  const submit = (path = "/login", value = "login") => ({
    kind: "click" as const,
    path,
    target: id(value),
    purpose: "submit" as const,
  });
  const variant = (slots: string[], path = "/login") => ({
    slots,
    steps: [fill(slots, path), submit(path)],
  });
  /** Branch and account numbers, or a contract number, with the same password and button. */
  const varied = (change: Record<string, unknown> = {}) => ({
    version: 1,
    id: "bank-variants",
    revision: 1,
    origin: "https://bank.example",
    slots: ["branch", "account", "password"],
    steps: [fill(["branch", "account", "password"]), submit()],
    alternatives: [variant(["contract", "password"])],
    completion: [{ target: id("welcome") }],
    rejection: id("rejected"),
    maxSubmissions: 1,
    ...change,
  });
  const valid = (change: Record<string, unknown> = {}) => v.is(loginRecipeSchema, varied(change));

  it("keeps the recipe's own slots and steps as variant 0 and adds up to 3 alternatives", () => {
    const parsed = parseLoginRecipe(varied());
    expect(passwordVariants(parsed).map((entry) => entry.slots)).toEqual([
      ["branch", "account", "password"],
      ["contract", "password"],
    ]);
    expect(routeSteps(parsed, { route: "password", variant: 1 })).toEqual(
      variant(["contract", "password"]).steps,
    );
    expect(routeSlots(parsed, { route: "password", variant: 0 })).toEqual(parsed.slots);
    expect(routeSlots(parsed, { route: "password", variant: 1 })).toEqual(["contract", "password"]);
    // An unknown variant has no steps, so no attempt can be created on it.
    expect(routeSteps(parsed, { route: "password", variant: 2 })).toEqual([]);
    expect(recipeSlots(parsed)).toEqual(["branch", "account", "password", "contract"]);
    expect(routeFillTargets(parsed, "password")).toEqual(
      ["branch", "account", "password", "contract"].map(id),
    );
    expect(routePaths(parsed, "password")).toEqual(["/login"]);
    expect(recipeStartSteps(parsed)).toEqual([
      fill(["branch", "account", "password"]),
      fill(["contract", "password"]),
    ]);
    const four = [variant(["contract", "password"]), variant(["card", "password"])];
    expect(valid({ alternatives: [...four, variant(["member", "password"])] })).toBe(true);
    expect(
      valid({ alternatives: [...four, variant(["member", "password"]), variant(["id"])] }),
    ).toBe(false);
    expect(valid({ alternatives: [] })).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "an alternative's unknown slot",
      { alternatives: [{ slots: ["contract"], steps: [fill(["contract", "pin"]), submit()] }] },
    ],
    [
      "slots its fill steps do not use",
      { alternatives: [{ slots: ["contract", "pin"], steps: [fill(["contract"]), submit()] }] },
    ],
    [
      "unused top-level slots once alternatives exist",
      { slots: ["branch", "account", "password", "pin"] },
    ],
    ["another start path", { alternatives: [variant(["contract", "password"], "/contract")] }],
    ["the same slots", { alternatives: [variant(["password", "account", "branch"])] }],
    ["a subset of another variant's slots", { alternatives: [variant(["branch", "password"])] }],
    [
      "an element another variant fills as another slot",
      {
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [
              {
                ...fill([]),
                fields: [
                  { slot: "contract", target: id("branch") },
                  { slot: "password", target: id("password") },
                ],
              },
              submit(),
            ],
          },
        ],
      },
    ],
    [
      "the same elements under other slots",
      {
        slots: ["branch", "password"],
        steps: [fill(["branch", "password"]), submit()],
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [
              {
                ...fill([]),
                fields: [
                  { slot: "contract", target: id("branch") },
                  { slot: "password", target: id("password") },
                ],
              },
              submit(),
            ],
          },
        ],
      },
    ],
    [
      "a variant that advances",
      {
        alternatives: [
          {
            slots: ["contract"],
            steps: [fill(["contract"]), { ...submit(), purpose: "advance" }],
          },
        ],
      },
    ],
    [
      "a first variant that advances",
      { steps: [fill(["branch", "account", "password"]), { ...submit(), purpose: "advance" }] },
    ],
    [
      "an alternative beyond the effect budget",
      {
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [
              fill(["contract"]),
              { ...submit("/login", "next"), purpose: "advance" },
              fill(["password"], "/password"),
              submit("/password"),
            ],
          },
        ],
      },
    ],
    [
      "an alternative's fallback click after an input-triggered effect",
      {
        maxSubmissions: 2,
        alternatives: [
          {
            slots: ["contract"],
            steps: [{ ...fill(["contract"]), effect: "submit", event: "input" }, submit()],
          },
        ],
      },
    ],
    [
      "an account switch that is an alternative's button",
      {
        accountSwitch: id("contract-login"),
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [fill(["contract", "password"]), submit("/login", "contract-login")],
          },
        ],
      },
    ],
  ])("refuses %s", (_label, change) => {
    expect(valid()).toBe(true);
    expect(valid(change)).toBe(false);
  });

  it("chooses the first variant the binding fills, and only for an item with a password", () => {
    const parsed = parseLoginRecipe(varied());
    expect(
      chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [true, true]),
    ).toEqual({
      route: "password",
      variant: 0,
    });
    expect(
      chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [false, true]),
    ).toEqual({
      route: "password",
      variant: 1,
    });
    expect(
      chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [false, false]),
    ).toBeUndefined();
    expect(
      chooseLoginRoute(parsed, { password: false, discoverablePasskey: false }, [true, true]),
    ).toBeUndefined();
    // A fit reported for a variant the parsed lacks chooses nothing.
    expect(
      chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [
        false,
        false,
        true,
      ]),
    ).toBeUndefined();
  });

  it("keeps the alternatives fixed when a revision is taken over", () => {
    const base = parseLoginRecipe(varied({ completion: undefined }));
    const next = (change: Record<string, unknown>) =>
      parseLoginRecipe({ ...base, revision: 2, ...change });
    expect(
      extendsRecipe(
        base,
        next({ handlers: [{ kind: "passkey", path: "/webauthn", target: id("key") }] }),
      ),
    ).toBe(true);
    expect(extendsRecipe(base, next({ completion: [{ target: id("welcome") }] }))).toBe(true);
    expect(extendsRecipe(base, next({ alternatives: undefined }))).toBe(false);
    expect(
      extendsRecipe(
        base,
        next({ alternatives: [variant(["contract", "password"]), variant(["card", "password"])] }),
      ),
    ).toBe(false);
    expect(extendsRecipe(base, next({ alternatives: [variant(["card", "password"])] }))).toBe(
      false,
    );
    const single = parseLoginRecipe(varied({ alternatives: undefined, completion: undefined }));
    expect(
      extendsRecipe(
        single,
        parseLoginRecipe({
          ...single,
          revision: 2,
          alternatives: [variant(["contract", "password"])],
        }),
      ),
    ).toBe(false);
  });

  it("authorizes a binding that covers exactly the chosen variant's slots", () => {
    const parsed = varied({ origin: "https://bank.example" });
    const contract = {
      ...binding(),
      slots: [
        { slot: "contract", fieldId: "username" },
        { slot: "password", fieldId: "password" },
      ],
    };
    const resolve = (value: LoginAccountBinding, slots: string[]) =>
      resolveLoginPlan(
        snapshot(),
        DUMMY_VAULT_CATALOG,
        "https://bank.example/login",
        parsed,
        value,
        slots,
      );
    expect(resolve(contract, ["contract", "password"])).toMatchObject({ ok: true });
    expect(resolve(contract, ["branch", "account", "password"])).toMatchObject({
      ok: false,
      reason: "binding-slots-mismatch",
    });
    expect(resolve(binding(), ["branch", "account", "password"])).toMatchObject({ ok: true });
    expect(resolve(binding(), ["contract", "password"])).toMatchObject({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });

  it("refuses a variant whose slots contain another's, in either direction", () => {
    // Variant 0 is a subset of the alternative.
    expect(valid({ alternatives: [variant(["branch", "account", "password", "pin"])] })).toBe(
      false,
    );
    // Two alternatives, one a subset of the other, apart from variant 0.
    expect(
      valid({
        alternatives: [variant(["contract", "password"]), variant(["contract", "pin", "password"])],
      }),
    ).toBe(false);
    // Overlapping sets that neither contain the other are distinct variants.
    expect(valid({ alternatives: [variant(["branch", "contract", "password"])] })).toBe(true);
  });

  it("accepts exactly 20 slots over all variants and 24 observed elements", () => {
    const named = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
    // 3 + 10 + 7 distinct slots.
    expect(
      valid({ alternatives: [variant(named("first", 10)), variant(named("second", 7))] }),
    ).toBe(true);
    expect(
      valid({ alternatives: [variant(named("first", 10)), variant(named("second", 8))] }),
    ).toBe(false);
    // The completion with 4 absent elements and the rejection take 6 of the 24 elements, so
    // an alternative's fill step may hold 18 fields. The union stays within 20 slots, so
    // only the observation bound decides.
    const result = {
      completion: [{ target: id("welcome"), absent: ["a", "b", "c", "d"].map(id) }],
    };
    const wide = (count: number) => [variant(["account", "password", ...named("extra", count)])];
    expect(valid({ ...result, alternatives: wide(16) })).toBe(true);
    expect(valid({ ...result, alternatives: wide(17) })).toBe(false);
    expect(valid({ alternatives: wide(17) })).toBe(true);
  });

  it("refuses a marker or rejection that is any variant's element", () => {
    // A marker proves a sign-in on any path, so no variant's field or button is one.
    expect(valid({ completion: [{ target: id("welcome") }] })).toBe(true);
    expect(valid({ completion: [{ target: id("contract") }] })).toBe(false);
    expect(valid({ completion: [{ target: id("welcome") }, { target: id("login") }] })).toBe(false);
    // The rejection is checked on every page, so no variant's button may be it.
    expect(valid({ rejection: id("login") })).toBe(false);
    expect(valid({ rejection: id("contract") })).toBe(false);
  });

  it("validates a single-variant recipe as before alternatives existed", () => {
    const single = (change: Record<string, unknown>) =>
      v.is(loginRecipeSchema, varied({ alternatives: undefined, ...change }));
    expect(single({})).toBe(true);
    // A slot no step fills yet, and a last step that advances to a page still to be learned.
    expect(single({ slots: ["branch", "account", "password", "pin"] })).toBe(true);
    expect(
      single({
        steps: [fill(["branch", "account", "password"]), { ...submit(), purpose: "advance" }],
      }),
    ).toBe(true);
    // A rejection on the recipe's own elements is left to the recipe's author, but a marker
    // proves a sign-in wherever it shows (ADR 0029), so it is never a step's element.
    expect(single({ completion: [{ target: id("branch") }] })).toBe(false);
    expect(single({ rejection: id("login") })).toBe(true);
  });

  it("chooses a variant only from fits reported true, as a sparse list leaves them", () => {
    const parsed = parseLoginRecipe(
      varied({ alternatives: [variant(["contract", "password"]), variant(["card", "password"])] }),
    );
    // planFor fills `fits` only at the index it checked, so earlier entries are holes.
    const sparse: boolean[] = [];
    sparse[2] = true;
    expect(
      chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, sparse),
    ).toEqual({
      route: "password",
      variant: 2,
    });
    expect(
      chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, []),
    ).toBeUndefined();
    expect(
      chooseLoginRoute(parsed, { password: true, discoverablePasskey: false }, [false, true, true]),
    ).toEqual({
      route: "password",
      variant: 1,
    });
  });
});

describe("the passkey route (ADR 0027)", () => {
  const id = (value: string) => ({ by: "id" as const, value });
  const passkey = { path: "/identity", target: id("passkey-login") };
  const withPasskey = (change: Record<string, unknown> = {}) => ({
    ...recipe(),
    passkey,
    ...change,
  });
  const valid = (change: Record<string, unknown> = {}) =>
    v.is(loginRecipeSchema, withPasskey(change));
  const click = {
    kind: "click",
    path: "/identity",
    target: id("passkey-login"),
    purpose: "submit",
  };

  it("adds one click on the start page that fills nothing", () => {
    const parsed = parseLoginRecipe(withPasskey());
    expect(recipeHasRoute(parsed, "passkey")).toBe(true);
    expect(recipeHasRoute(parsed, "password")).toBe(true);
    expect(routeSteps(parsed, { route: "passkey" })).toEqual([click]);
    expect(routeSlots(parsed, { route: "passkey" })).toEqual([]);
    expect(routeFillTargets(parsed, "passkey")).toEqual([]);
    expect(routePaths(parsed, "passkey")).toEqual(["/identity"]);
    // The passkey route's page is still the sign-in page while the button or the password
    // form shows, on its own path or any of the password route's.
    expect(routeSignInTargets(parsed, "passkey")).toEqual([
      id("passkey-login"),
      ...routeFillTargets(parsed, "password"),
    ]);
    expect(routeSignInTargets(parsed, "password")).toEqual(routeFillTargets(parsed, "password"));
    expect(routeSignInPaths(parsed, "passkey")).toEqual([
      "/identity",
      ...routePaths(parsed, "password").filter((path) => path !== "/identity"),
    ]);
    expect(routeSignInPaths(parsed, "passkey")).toEqual(
      expect.arrayContaining(routePaths(parsed, "password")),
    );
    expect(routeSignInPaths(parsed, "password")).toEqual(routePaths(parsed, "password"));
    // The passkey click is watched first, beside the password route's first step.
    expect(recipeStartSteps(parsed)).toEqual([click, parsed.steps[0]]);
    // The password route is unchanged, and the recipe's slots are only its own.
    expect(routeSteps(parsed, { route: "password", variant: 0 })).toEqual(parsed.steps);
    expect(recipeSlots(parsed)).toEqual(parsed.slots);
    // A recipe without the button has no route of its own to start; its passkey route
    // only answers the start page's own request (ADR 0034).
    const plain = parseLoginRecipe(recipe());
    expect(recipeHasRoute(plain, "passkey")).toBe(false);
    expect(passkeyAnswersRequest(parsed)).toBe(false);
    expect(passkeyAnswersRequest(plain)).toBe(true);
    expect(routeSteps(plain, { route: "passkey" })).toEqual([
      { kind: "click", path: "/identity", target: id("branch"), purpose: "submit" },
    ]);
    expect(routeSlots(plain, { route: "passkey" })).toEqual([]);
    expect(routeFillTargets(plain, "passkey")).toEqual([]);
    expect(routePaths(plain, "passkey")).toEqual(["/identity"]);
    expect(routeSignInTargets(plain, "passkey")).toEqual(routeFillTargets(plain, "password"));
    expect(routeSignInPaths(plain, "passkey")).toEqual(routePaths(plain, "password"));
    expect(recipeStartSteps(plain)).toEqual([plain.steps[0]]);
  });

  it("answers the start page's own request on the first step's target (ADR 0034)", () => {
    // A recipe whose first step is a click stands for the answer on that button.
    const clickFirst = parseLoginRecipe({
      ...recipe(),
      steps: [
        { kind: "click", path: "/start", target: id("open-login"), purpose: "advance" },
        ...recipe().steps,
      ],
      maxSubmissions: 3,
    });
    expect(passkeyAnswersRequest(clickFirst)).toBe(true);
    expect(routeSteps(clickFirst, { route: "passkey" })).toEqual([
      { kind: "click", path: "/start", target: id("open-login"), purpose: "submit" },
    ]);
    expect(routePaths(clickFirst, "passkey")).toEqual(["/start"]);
    expect(routeSignInPaths(clickFirst, "passkey")).toEqual(["/start", "/identity", "/password"]);
    // The step stands for the answer only: the password route keeps its own steps.
    expect(routeSteps(clickFirst, { route: "password", variant: 0 })).toEqual(clickFirst.steps);
  });

  it("chooses the passkey route for a page's own request only with a discoverable passkey", () => {
    const plain = parseLoginRecipe(recipe());
    const facts = (discoverablePasskey: boolean, password = true) => ({
      password,
      discoverablePasskey,
    });
    // Without the page's request a recipe without the button takes the password route.
    expect(chooseLoginRoute(plain, facts(true), [true])).toEqual({
      route: "password",
      variant: 0,
    });
    expect(chooseLoginRoute(plain, facts(true), [true], false)).toEqual({
      route: "password",
      variant: 0,
    });
    expect(chooseLoginRoute(plain, facts(true), [true], true)).toEqual({ route: "passkey" });
    // An item without a password still answers the request.
    expect(chooseLoginRoute(plain, facts(true, false), [], true)).toEqual({ route: "passkey" });
    // A passkey that is not discoverable never answers it.
    expect(chooseLoginRoute(plain, facts(false), [true], true)).toEqual({
      route: "password",
      variant: 0,
    });
    expect(chooseLoginRoute(plain, facts(false, false), [true], true)).toBeUndefined();
    // A recipe with the button takes its route either way.
    const button = parseLoginRecipe(withPasskey());
    expect(chooseLoginRoute(button, facts(true), [true], true)).toEqual({ route: "passkey" });
    expect(chooseLoginRoute(button, facts(true), [true], false)).toEqual({ route: "passkey" });
    // An item without a password, or whose binding fills no variant, still takes it.
    expect(chooseLoginRoute(button, facts(true, false), [])).toEqual({ route: "passkey" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["on another path than the start path", { passkey: { ...passkey, path: "/password" } }],
    ["on a variant's fill field", { passkey: { ...passkey, target: id("branch") } }],
    ["on a variant's button", { passkey: { ...passkey, target: id("next") } }],
    ["on the account switch", { accountSwitch: id("passkey-login") }],
    ["on the rejection", { rejection: id("passkey-login") }],
    [
      "on a handler on its path",
      { handlers: [{ kind: "passkey", path: "/identity", target: id("passkey-login") }] },
    ],
    ["with a value", { passkey: { ...passkey, value: "synthetic-only" } }],
    ["with CSS", { passkey: { ...passkey, target: { by: "css", value: "#passkey" } } }],
  ])("refuses a passkey button %s", (_label, change) => {
    expect(valid()).toBe(true);
    expect(valid(change)).toBe(false);
  });

  it("keeps its button apart from every password variant on the start page", () => {
    const contract = {
      slots: ["contract", "pin"],
      steps: [
        {
          kind: "fill",
          path: "/identity",
          fields: [
            { slot: "contract", target: id("contract") },
            { slot: "pin", target: id("pin") },
          ],
        },
        { kind: "click", path: "/identity", target: id("contract-login"), purpose: "submit" },
      ],
    };
    const varied = (change: Record<string, unknown> = {}) =>
      withPasskey({ alternatives: [contract], ...change });
    expect(v.is(loginRecipeSchema, varied())).toBe(true);
    // An alternative's field or button is not the passkey button either.
    for (const value of ["contract", "pin", "contract-login"])
      expect(
        v.is(loginRecipeSchema, varied({ passkey: { ...passkey, target: id(value) } })),
        value,
      ).toBe(false);
    const parsed = parseLoginRecipe(varied());
    // The button is watched first, then every variant's first step.
    expect(recipeStartSteps(parsed)).toEqual([
      click,
      parsed.steps[0],
      parsed.alternatives![0]!.steps[0],
    ]);
    expect(parsed.alternatives![0]!.steps[0]).toMatchObject(contract.steps[0]!);
    // The password route's sign-in elements are its fill fields, never the button.
    expect(routeSignInTargets(parsed, "password")).not.toContainEqual(id("passkey-login"));
    expect(routeSignInTargets(parsed, "password")).toContainEqual(id("contract"));
    // The passkey route wins over any fitting variant, and a second factor leaves them.
    const facts = (discoverablePasskey: boolean) => ({ password: true, discoverablePasskey });
    expect(chooseLoginRoute(parsed, facts(true), [false, true])).toEqual({ route: "passkey" });
    expect(chooseLoginRoute(parsed, facts(false), [false, true])).toEqual({
      route: "password",
      variant: 1,
    });
    expect(
      chooseLoginRoute(parsed, { password: false, discoverablePasskey: false }, [true, true]),
    ).toBeUndefined();
  });

  it("counts its button as one element within the observation bound", () => {
    // 18 fields, a completion with 4 absent elements and the rejection fill the 24.
    const fields = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        slot: `s${index}`,
        target: id(`field${index}`),
      }));
    const wide = (count: number) =>
      withPasskey({
        slots: fields(count).map((field) => field.slot),
        steps: [
          { kind: "fill", path: "/identity", fields: fields(count) },
          { kind: "click", path: "/identity", target: id("go"), purpose: "submit" },
        ],
        completion: [{ target: id("welcome"), absent: ["a", "b", "c", "d"].map(id) }],
        maxSubmissions: 1,
      });
    // The button is observed with the start page's step, not on top of its fields.
    expect(v.is(loginRecipeSchema, wide(18))).toBe(true);
    expect(v.is(loginRecipeSchema, wide(19))).toBe(false);
  });

  it("allows the same locator where another path uses it, but never as a marker", () => {
    // The password page's button and a handler on other paths are other elements than the
    // start page's passkey button.
    expect(valid({ passkey: { ...passkey, target: id("login") } })).toBe(true);
    // A marker proves a sign-in on any path, the start page included (ADR 0029).
    expect(valid({ completion: [{ target: id("passkey-login") }] })).toBe(false);
    expect(
      valid({
        handlers: [{ kind: "passkey", path: "/webauthn", target: id("passkey-login") }],
      }),
    ).toBe(true);
  });

  it("keeps the route fixed when a revision is taken over", () => {
    const base = parseLoginRecipe(withPasskey({ completion: undefined }));
    const next = (change: Record<string, unknown>) =>
      parseLoginRecipe({ ...base, revision: 2, ...change });
    expect(
      extendsRecipe(
        base,
        next({ handlers: [{ kind: "passkey", path: "/webauthn", target: id("key") }] }),
      ),
    ).toBe(true);
    expect(extendsRecipe(base, next({ completion: [{ target: id("welcome") }] }))).toBe(true);
    expect(extendsRecipe(base, next({ passkey: undefined }))).toBe(false);
    expect(extendsRecipe(base, next({ passkey: { ...passkey, target: id("other") } }))).toBe(false);
    const plain = parseLoginRecipe({ ...recipe(), completion: undefined });
    expect(extendsRecipe(plain, parseLoginRecipe({ ...plain, revision: 2, passkey }))).toBe(false);
  });

  it("authorizes a binding without slots for the route's empty slot list only", () => {
    const empty = { ...binding(), slots: [] };
    expect(parseLoginAccountBinding(empty)).toEqual(empty);
    const resolve = (value: LoginAccountBinding, slots: string[]) =>
      resolveLoginPlan(
        snapshot(),
        DUMMY_VAULT_CATALOG,
        "https://bank.example/identity",
        withPasskey(),
        value,
        slots,
      );
    expect(resolve(empty, [])).toMatchObject({ ok: true, binding: empty });
    expect(resolve(binding(), [])).toMatchObject({ ok: false, reason: "binding-slots-mismatch" });
    expect(resolve(empty, ["branch", "account", "password"])).toMatchObject({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });
});

describe("totp handler recipe checks, probed independently (ADR 0027)", () => {
  const verify = { by: "text", value: "Verify" } as const;
  const totp = (change: Record<string, unknown> = {}) => ({
    kind: "totp" as const,
    path: "/two-factor",
    field: { by: "id" as const, value: "otp" },
    target: verify,
    ...change,
  });
  const key = (change: Record<string, unknown> = {}) => ({
    kind: "passkey" as const,
    path: "/two-factor",
    target: { by: "text" as const, value: "Use security key" },
    ...change,
  });
  const parses = (value: Record<string, unknown>) =>
    v.safeParse(loginRecipeSchema, { ...recipe(), ...value }).success;

  it("refuses a field equal to its button under every attribute locator", () => {
    for (const element of [
      { by: "id", value: "code" },
      { by: "name", value: "code" },
      { by: "test-id", value: "code" },
    ])
      expect(parses({ handlers: [totp({ field: element, target: element })] })).toBe(false);
    // The same value under another locator is another element.
    expect(
      parses({
        handlers: [
          totp({ field: { by: "id", value: "code" }, target: { by: "name", value: "code" } }),
        ],
      }),
    ).toBe(true);
    expect(
      parses({
        handlers: [
          totp({ field: { by: "id", value: "code" }, target: { by: "text", value: "code" } }),
        ],
      }),
    ).toBe(true);
  });

  it("accepts name and test-id code fields and refuses a text-located one", () => {
    for (const field of [
      { by: "name", value: "otp" },
      { by: "test-id", value: "otp-input" },
    ])
      expect(parses({ handlers: [totp({ field })] })).toBe(true);
    expect(parses({ handlers: [totp({ field: { by: "text", value: "otp" } })] })).toBe(false);
    // The field is required, and the passkey shape carries none.
    expect(parses({ handlers: [{ kind: "totp", path: "/two-factor", target: verify }] })).toBe(
      false,
    );
    expect(parses({ handlers: [key({ field: { by: "id", value: "otp" } })] })).toBe(false);
  });

  it("lets a passkey and a totp handler share a path in either order", () => {
    for (const handlers of [
      [totp(), key()],
      [key(), totp()],
    ])
      expect(parseLoginRecipe({ ...recipe(), handlers }).handlers).toEqual(handlers);
    // Two code pages on different paths are two handlers.
    expect(parses({ handlers: [totp(), totp({ path: "/two-factor/again" })] })).toBe(true);
  });

  it("refuses a second handler of the same kind on one path, whatever its elements", () => {
    expect(
      parses({
        handlers: [
          totp(),
          totp({ field: { by: "id", value: "other" }, target: { by: "id", value: "go" } }),
        ],
      }),
    ).toBe(false);
    expect(parses({ handlers: [key(), totp(), key({ target: { by: "id", value: "k2" } })] })).toBe(
      false,
    );
  });

  it("refuses an account switch that is the code field or its button, on any path", () => {
    expect(parses({ handlers: [totp()], accountSwitch: { by: "id", value: "otp" } })).toBe(false);
    expect(parses({ handlers: [totp()], accountSwitch: verify })).toBe(false);
    expect(
      parses({
        handlers: [totp({ path: "/elsewhere" })],
        accountSwitch: { by: "id", value: "otp" },
      }),
    ).toBe(false);
    // An unrelated switch is fine.
    expect(parses({ handlers: [totp()], accountSwitch: { by: "id", value: "switch" } })).toBe(true);
  });

  it("refuses a signed-in marker that is either of the handler's elements, on any path", () => {
    const marker = { by: "id", value: "authenticated" } as const;
    expect(parses({ handlers: [totp({ path: "/authenticated", target: marker })] })).toBe(false);
    expect(parses({ handlers: [totp({ path: "/authenticated", field: marker })] })).toBe(false);
    expect(parses({ handlers: [totp({ target: marker })] })).toBe(false);
    expect(parses({ handlers: [totp({ field: marker })] })).toBe(false);
  });

  it("refuses a passkey route button that is either of the handler's elements on its path", () => {
    const button = { by: "id", value: "passkey-login" } as const;
    const passkey = { path: "/identity", target: button };
    expect(parses({ passkey, handlers: [totp({ path: "/identity", target: button })] })).toBe(
      false,
    );
    expect(parses({ passkey, handlers: [totp({ path: "/identity", field: button })] })).toBe(false);
    // On another path the same element is not the route's button.
    expect(parses({ passkey, handlers: [totp({ target: button })] })).toBe(true);
    expect(parses({ passkey, handlers: [totp({ field: button })] })).toBe(true);
  });
});

describe("entry recipes (ADR 0031)", () => {
  const entry = () => ({
    version: 1,
    id: "entry-01",
    revision: 1,
    origin: "https://www.example.test",
    entry: { path: "/en/", target: { by: "text", value: "Login" } },
  });

  it("stores a recipe with only an entry, told apart from a login route recipe", () => {
    const stored = v.parse(storedLoginRecipeSchema, entry());
    expect(stored).toEqual(entry());
    expect(v.is(loginEntryRecipeSchema, entry())).toBe(true);
    expect(isLoginRouteRecipe(stored)).toBe(false);
    expect(storedRecipeStartPath(stored)).toBe("/en/");
    const route = v.parse(storedLoginRecipeSchema, recipe());
    expect(isLoginRouteRecipe(route)).toBe(true);
    expect(storedRecipeStartPath(route)).toBe("/identity");
    // A login runs only a recipe with a route.
    expect(v.is(loginRecipeSchema, entry())).toBe(false);
  });

  it("accepts an id, name, test-id or text locator as the entry's target", () => {
    for (const target of [
      { by: "id", value: "login-link" },
      { by: "name", value: "login" },
      { by: "test-id", value: "header-login" },
      { by: "text", value: "Sign in" },
    ])
      expect(v.is(storedLoginRecipeSchema, { ...entry(), entry: { path: "/", target } })).toBe(
        true,
      );
  });

  it("refuses an autocomplete locator, which names only an input, as the entry's target", () => {
    for (const value of loginAutocompleteTokens)
      expect(
        v.is(storedLoginRecipeSchema, {
          ...entry(),
          entry: { path: "/", target: { by: "autocomplete", value } },
        }),
      ).toBe(false);
  });

  it("treats only a recipe with steps as one with a login route", () => {
    // A later kind without steps never passes as a route.
    const { steps: _steps, ...rest } = recipe();
    const other = { ...rest, later: {} } as unknown as StoredLoginRecipe;
    expect(isLoginRouteRecipe(other)).toBe(false);
    expect(() => storedRecipeStartPath(other)).toThrow("Unknown stored recipe kind");
  });

  it("never holds an entry beside a login route member", () => {
    const { slots, steps, maxSubmissions, completion, rejection } = recipe();
    for (const extra of [
      { slots },
      { steps },
      { slots, steps, maxSubmissions },
      { maxSubmissions },
      { completion },
      { rejection },
      { accountSwitch: { by: "text", value: "Use another account" } },
      { passkey: { path: "/en/", target: { by: "text", value: "Passkey" } } },
      { handlers: [{ kind: "passkey", path: "/2fa", target: { by: "id", value: "key" } }] },
      { alternatives: [{ slots, steps }] },
    ])
      expect(v.is(storedLoginRecipeSchema, { ...entry(), ...extra })).toBe(false);
    expect(v.is(storedLoginRecipeSchema, { ...recipe(), entry: entry().entry })).toBe(false);
  });

  it("refuses a recipe with neither an entry nor a route, and an incomplete entry", () => {
    const { entry: _entry, ...bare } = entry();
    expect(v.is(storedLoginRecipeSchema, bare)).toBe(false);
    expect(v.is(storedLoginRecipeSchema, { ...bare, slots: ["username"] })).toBe(false);
    for (const value of [
      { path: "/en/" },
      { target: { by: "text", value: "Login" } },
      { path: "/en/?return_to=%2F", target: { by: "text", value: "Login" } },
      { path: "https://www.example.test/", target: { by: "text", value: "Login" } },
      { path: "/en/", target: { by: "css", value: "a.login" } },
      { path: "/en/", target: { by: "text", value: " Login" } },
      { path: "/en/", target: { by: "text", value: "Login" }, href: "/login" },
    ])
      expect(v.is(storedLoginRecipeSchema, { ...entry(), entry: value })).toBe(false);
  });
});

describe("chooser recipes (ADR 0028)", () => {
  const chooser = (extra: Record<string, unknown> = {}) => ({
    version: 1,
    id: recipe().id,
    revision: recipe().revision,
    origin: recipe().origin,
    chooser: {
      path: "/login",
      other: { by: "text", value: "Sign in with another profile" },
      ...extra,
    },
  });

  it("stores a chooser without branches, told apart from a login route recipe", () => {
    const stored = v.parse(storedLoginRecipeSchema, chooser());
    expect(stored).toEqual(chooser());
    expect(v.is(loginChooserRecipeSchema, chooser())).toBe(true);
    expect(isLoginRouteRecipe(stored)).toBe(false);
    expect(storedRecipeStartPath(stored)).toBe("/login");
    expect(v.is(loginRecipeSchema, chooser())).toBe(false);
    expect(v.is(storedLoginRecipeSchema, { ...chooser(), chooser: { path: "/login" } })).toBe(true);
  });

  it("holds each branch as a route recipe under the chooser's ID, revision and origin", () => {
    const branch = recipe();
    expect(
      v.is(storedLoginRecipeSchema, chooser({ afterAccount: branch, afterOther: branch })),
    ).toBe(true);
    for (const changed of [
      { id: "other-01" },
      { revision: branch.revision + 1 },
      { origin: "https://other.example.test" },
    ])
      expect(
        v.is(storedLoginRecipeSchema, chooser({ afterAccount: { ...branch, ...changed } })),
      ).toBe(false);
    expect(v.is(storedLoginRecipeSchema, chooser({ afterAccount: { steps: [] } }))).toBe(false);
  });

  it("names its buttons by a non-input locator, never the same one twice", () => {
    const shown = { by: "text", value: "Log back in" };
    expect(v.is(storedLoginRecipeSchema, chooser({ continue: shown }))).toBe(true);
    expect(v.is(storedLoginRecipeSchema, chooser({ continue: chooser().chooser.other }))).toBe(
      false,
    );
    expect(
      v.is(storedLoginRecipeSchema, chooser({ other: { by: "autocomplete", value: "username" } })),
    ).toBe(false);
    // The other-account branch needs its button.
    const { other: _other, ...withoutOther } = chooser().chooser;
    expect(
      v.is(storedLoginRecipeSchema, {
        ...chooser(),
        chooser: { ...withoutOther, afterOther: recipe() },
      }),
    ).toBe(false);
  });

  it("never holds a chooser beside a login route member or an entry", () => {
    const { slots, steps } = recipe();
    expect(v.is(storedLoginRecipeSchema, { ...chooser(), slots, steps })).toBe(false);
    expect(
      v.is(storedLoginRecipeSchema, {
        ...chooser(),
        entry: { path: "/", target: { by: "text", value: "Login" } },
      }),
    ).toBe(false);
    expect(v.is(storedLoginRecipeSchema, { ...recipe(), chooser: chooser().chooser })).toBe(false);
  });

  it("reads and replaces a branch, moving the other one to the new revision", () => {
    const stored = v.parse(loginChooserRecipeSchema, chooser());
    expect(chooserBranch(stored, "account")).toBeUndefined();
    expect(storedRecipeSlots(stored)).toEqual([]);
    const account = { ...recipe(), revision: recipe().revision + 1 };
    const first = withChooserBranch(stored, "account", account);
    expect(first).toEqual({
      ...stored,
      revision: account.revision,
      chooser: { ...stored.chooser, afterAccount: account },
    });
    expect(v.is(loginChooserRecipeSchema, first)).toBe(true);
    const other = {
      ...recipe(),
      revision: account.revision + 1,
      slots: [...recipe().slots, "pin"],
    };
    const both = withChooserBranch(first, "other", { ...other, steps: [...other.steps] });
    expect(both.revision).toBe(other.revision);
    expect(chooserBranch(both, "account")).toEqual({ ...account, revision: other.revision });
    expect(chooserBranch(both, "other")?.revision).toBe(other.revision);
    expect(v.is(loginChooserRecipeSchema, both)).toBe(true);
    // A chooser's slots are its branches' together; a route recipe's are its own.
    expect(storedRecipeSlots(both)).toEqual(["branch", "account", "password", "pin"]);
    expect(storedRecipeSlots(recipe())).toEqual(recipeSlots(recipe()));
  });

  it("runs a click on the list, then the steps of the branch it leads to", () => {
    const stored = v.parse(loginChooserRecipeSchema, chooser());
    // Without a branch yet, the login clicks and continues on the next page.
    expect(chooserRoute(stored, "entry")).toEqual({
      version: 1,
      id: stored.id,
      revision: stored.revision,
      origin: stored.origin,
      slots: ["username"],
      steps: [{ kind: "click", path: "/login", target: CHOOSER_ENTRY_TARGET, purpose: "advance" }],
      maxSubmissions: 1,
    });
    expect(chooserRoute(stored, "other")?.steps[0]).toMatchObject({
      target: stored.chooser.other,
    });
    // No button, no route.
    expect(chooserRoute(stored, "continue")).toBeUndefined();
    const { alternatives: _alternatives, ...branch } = {
      ...recipe(),
      passkey: undefined,
      alternatives: undefined,
    };
    const both = withChooserBranch(stored, "account", { ...branch, revision: 2 });
    const route = chooserRoute(both, "entry");
    expect(route).toMatchObject({
      revision: 2,
      slots: ["username", "branch", "account", "password"],
      completion: recipe().completion,
      rejection: recipe().rejection,
      maxSubmissions: recipe().maxSubmissions + 1,
    });
    expect(route?.steps).toEqual([
      { kind: "click", path: "/login", target: CHOOSER_ENTRY_TARGET, purpose: "advance" },
      ...recipe().steps,
    ]);
    expect(v.is(loginRecipeSchema, route)).toBe(true);
    // The other branch is still absent: its route is the click alone.
    expect(chooserRoute(both, "other")?.steps).toHaveLength(1);
  });
});
