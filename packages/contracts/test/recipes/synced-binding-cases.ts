import { expect, it } from "vitest";
import * as v from "valibot";
import {
  defaultLoginBinding,
  findLoginBinding,
  isSsoFieldName,
  resolveBindingFields,
  resolveDetailSourceField,
  templateLoginBinding,
} from "../../src/recipes";
import {
  createDefaultSettings,
  localSettingsSchema,
  savedLoginBindingSchema,
} from "../../src/settings";
import type { SyncedBindingContext } from "./context";

export function registerSyncedBindings({
  origin,
  recipe,
  binding,
  snapshotId,
  fields,
  resolve,
}: SyncedBindingContext) {
  it("finds the binding for one recipe and item only", () => {
    const account = {
      provider: "bitwarden",
      server: "cloud-us",
      userId: binding().userId,
      itemId: binding().itemId,
    };
    const bindings = [binding(), binding({ itemId: "00000000-0000-4000-8000-000000000003" })];
    expect(findLoginBinding(bindings, { id: "bank-signin", origin }, account)).toBe(bindings[0]);
    expect(findLoginBinding(bindings, { id: "bank-admin", origin }, account)).toBeUndefined();
    expect(
      findLoginBinding(bindings, { id: "bank-signin", origin }, { ...account, userId: "other" }),
    ).toBeUndefined();
    // The same user ID on another server is another account (ADR 0023).
    expect(
      findLoginBinding(bindings, { id: "bank-signin", origin }, { ...account, server: "cloud-eu" }),
    ).toBeUndefined();
  });

  it("resolves built-in and named custom fields to this device's IDs", () => {
    expect(resolve(binding())).toEqual({
      ok: true,
      slots: [
        { slot: "branch", fieldId: `custom.${snapshotId}.0` },
        { slot: "password", fieldId: "login.password" },
      ],
    });
  });

  it("pins a duplicate name by position only while the count is unchanged", () => {
    const pin = (position: number, count: number) =>
      binding({ slots: [{ slot: "pin", field: { custom: "PIN", position, count } }] });
    expect(resolve(pin(2, 2))).toEqual({
      ok: true,
      slots: [{ slot: "pin", fieldId: `custom.${snapshotId}.2` }],
    });
    expect(resolve(pin(1, 3))).toEqual({
      ok: false,
      slot: "pin",
      reason: "field-count-changed",
    });
    expect(resolve(binding({ slots: [{ slot: "pin", field: { custom: "PIN" } }] }))).toEqual({
      ok: false,
      slot: "pin",
      reason: "field-ambiguous",
    });
  });

  it("refuses a missing field instead of falling back", () => {
    expect(resolve(binding(), [{ id: "login.password", name: null }])).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
    });
    expect(
      resolve(binding({ slots: [{ slot: "otp", field: "totp" }] }), fields.slice(0, 2)),
    ).toEqual({ ok: false, slot: "otp", reason: "field-missing" });
    // Built-in fields and unnamed custom fields never match a custom name, including
    // the display fallback an unnamed field gets in the catalog.
    for (const name of ["Username", "Custom field 4", `custom.${snapshotId}.3`]) {
      expect(resolve(binding({ slots: [{ slot: "x", field: { custom: name } }] }))).toEqual({
        ok: false,
        slot: "x",
        reason: "field-missing",
      });
    }
  });

  it("never binds a field reserved for SSO methods (ADR 0085)", () => {
    const sso = [
      ...fields,
      { id: `custom.${snapshotId}.4`, name: "SSO" },
      { id: `custom.${snapshotId}.5`, name: " sso 2 " },
    ];
    for (const name of ["SSO", " sso 2 ", "Sso 12"]) {
      expect(resolve(binding({ slots: [{ slot: "x", field: { custom: name } }] }), sso)).toEqual({
        ok: false,
        slot: "x",
        reason: "sso-field",
      });
    }
    expect(
      resolve(
        binding({ slots: [{ slot: "x", field: { custom: "SSO", position: 1, count: 1 } }] }),
        sso,
      ),
    ).toEqual({ ok: false, slot: "x", reason: "sso-field" });
    expect(resolveDetailSourceField({ custom: "SSO" }, sso)).toBeUndefined();
  });

  it("reserves `SSO` and `SSO <number>` by name only (ADR 0085)", () => {
    for (const name of [
      "SSO",
      "sso",
      " SSO ",
      "SSO 2",
      "SSO  3",
      "sso 10",
      "SSO\t2",
      "SSO\u00a02",
      "ＳＳＯ　２",
    ])
      expect(isSsoFieldName(name), name).toBe(true);
    for (const name of [null, undefined, "", "SSO2", "SSO-2", "SSO login", "My SSO", "SSO 2a"])
      expect(isSsoFieldName(name), String(name)).toBe(false);
  });

  it("counts same-name fields over the whole item in vault order", () => {
    const shuffled = [fields[5]!, fields[0]!, fields[4]!];
    const pin = (position: number) =>
      binding({ slots: [{ slot: "pin", field: { custom: "PIN", position, count: 2 } }] });
    expect(resolve(pin(1), shuffled)).toMatchObject({
      ok: true,
      slots: [{ fieldId: `custom.${snapshotId}.1` }],
    });
    // A removed duplicate is a count change, not a silent fallback to the other one.
    expect(resolve(pin(1), [fields[4]!])).toEqual({
      ok: false,
      slot: "pin",
      reason: "field-count-changed",
    });
  });

  it("refuses a binding that lacks a route slot and ignores its other slots", () => {
    const entry = binding();
    expect(resolveBindingFields(entry, ["branch", "password", "otp"], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
    // Another variant's slot is neither resolved nor refused when it no longer resolves.
    const stale = binding({
      slots: [
        { slot: "branch", field: { custom: "Gone" } },
        { slot: "password", field: "password" },
      ],
    });
    expect(resolveBindingFields(stale, ["password"], fields)).toEqual({
      ok: true,
      slots: [{ slot: "password", fieldId: "login.password" }],
    });
    expect(resolveBindingFields(stale, ["branch", "password"], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
    });
  });

  it.each([
    ["a position without a count", { custom: "PIN", position: 1 }],
    ["a position beyond the count", { custom: "PIN", position: 3, count: 2 }],
    ["a count of one", { custom: "PIN", position: 1, count: 1 }],
    ["a count without a position", { custom: "PIN", count: 2 }],
    ["a position of zero", { custom: "PIN", position: 0, count: 2 }],
    ["a fractional position", { custom: "PIN", position: 1.5, count: 2 }],
    ["an extra key", { custom: "PIN", index: 1 }],
    ["an empty name", { custom: "" }],
    ["an unknown built-in", "notes"],
  ])("rejects %s", (_label, field) => {
    expect(v.is(savedLoginBindingSchema, binding({ slots: [{ slot: "x", field }] as never }))).toBe(
      false,
    );
  });

  it("saves a slot named from the page's text, as the recipe slot schema allows (ADR 0027)", () => {
    const field = { custom: "支店番号" };
    for (const [slot, valid] of [
      ["店番号", true],
      ["会員番号 (ログインID)", true],
      ["店番  号", false],
      ["Ｂｒａｎｃｈ", false],
    ] as const)
      expect(v.is(savedLoginBindingSchema, binding({ slots: [{ slot, field }] })), slot).toBe(
        valid,
      );
  });

  it("rejects duplicate slots in one binding", () => {
    const field = "password" as const;
    expect(
      v.is(
        savedLoginBindingSchema,
        binding({
          slots: [
            { slot: "a", field },
            { slot: "a", field },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("names the account's server: a cloud region or an exact HTTPS origin (ADR 0023)", () => {
    for (const server of [
      "cloud-us",
      "cloud-eu",
      "https://vault.example",
      "https://vault.example:8443",
    ])
      expect(v.is(savedLoginBindingSchema, binding({ server })), server).toBe(true);
    for (const server of [
      "",
      "cloud-jp",
      "http://vault.example",
      "https://vault.example/",
      "https://VAULT.example",
      "https://user@vault.example",
      "vault.example",
    ])
      expect(v.is(savedLoginBindingSchema, binding({ server })), server).toBe(false);
    const { server: _server, ...serverless } = binding();
    expect(v.is(savedLoginBindingSchema, serverless)).toBe(false);
  });

  it("keeps an optional display-only account name", () => {
    expect(v.is(savedLoginBindingSchema, binding({ accountName: "Personal vault" }))).toBe(true);
    // Bindings made by AI generation on the service have none.
    expect(v.is(savedLoginBindingSchema, binding())).toBe(true);
    for (const accountName of ["", "x".repeat(201)])
      expect(v.is(savedLoginBindingSchema, binding({ accountName }))).toBe(false);
  });

  it("never accepts an empty binding where a synced or saved one is parsed (ADR 0027)", () => {
    // Only a running login on the passkey route has a binding without slots; it is never
    // stored or synced.
    const empty = binding({ slots: [] });
    expect(v.is(savedLoginBindingSchema, empty)).toBe(false);
    const settings = createDefaultSettings({ connections: [] });
    expect(v.is(localSettingsSchema, { ...settings, bindings: [empty] })).toBe(false);
    const account = {
      provider: "bitwarden",
      server: "cloud-us",
      userId: empty.userId,
      itemId: empty.itemId,
      itemName: "",
    };
    const signin = recipe("bank-signin", "/login");
    expect(defaultLoginBinding([], signin, account)).toBeUndefined();
    expect(templateLoginBinding([], signin, account, [[]], fields)).toEqual({
      ok: false,
      reason: "binding-not-found",
    });
  });

  it("keeps settings without bindings valid and rejects duplicate bindings", () => {
    const settings = createDefaultSettings({ connections: [] });
    expect(v.is(localSettingsSchema, settings)).toBe(true);
    expect(v.is(localSettingsSchema, { ...settings, bindings: [binding()] })).toBe(true);
    expect(v.is(localSettingsSchema, { ...settings, bindings: [binding(), binding()] })).toBe(
      false,
    );
  });
}
