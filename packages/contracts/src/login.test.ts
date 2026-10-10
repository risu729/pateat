import { describe, expect, it } from "vitest";
import {
  parseLoginAccountBinding,
  parseLoginOperation,
  parseLoginRecipe,
  resolveLoginPlan,
  type LoginAccountBinding,
  type LoginRecipe,
} from "./login";
import { createDefaultSettings, DUMMY_VAULT_CATALOG, type SettingsSnapshot } from "./settings";

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
    { origin: "https://bank.example", connectionId: "demo-personal", itemId: "primary" },
  ];
  return { version: 1, revision: 4, settings };
}

describe("declarative login boundaries", () => {
  it("accepts separate multi-page field mappings without containing values", () => {
    expect(parseLoginRecipe(recipe())).toEqual(recipe());
    expect(parseLoginAccountBinding(binding())).toEqual(binding());
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
