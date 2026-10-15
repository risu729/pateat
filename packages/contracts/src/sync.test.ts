import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { LoginRecipe } from "./login";
import { createDefaultSettings, type LocalSettings } from "./settings";
import {
  syncErrorSchema,
  syncRecipeChangeSchema,
  syncRecipeWriteSchema,
  syncSettingsStateSchema,
  syncSettingsWriteSchema,
} from "./sync";

function recipe(revision: number): LoginRecipe {
  return {
    version: 1,
    id: "bank-login",
    revision,
    origin: "https://bank.example",
    slots: ["password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "submit" }, purpose: "submit" },
    ],
    completion: [{ target: { by: "id", value: "welcome" } }],
    maxSubmissions: 1,
  };
}

const accepts = (schema: v.GenericSchema, value: unknown) => v.safeParse(schema, value).success;

/** A synced document with an account policy, an item policy and a review record (ADR 0023). */
function policyDocument(): LocalSettings {
  const account = {
    provider: "bitwarden",
    server: "https://vault.example",
    userId: "00000000-0000-4000-8000-000000000001",
  };
  return {
    ...createDefaultSettings({ connections: [] }),
    accountPolicies: [
      {
        ...account,
        accountName: "Personal vault",
        enabled: true,
        selection: { mode: "selected", groups: [{ id: "folder-1", name: "Banking" }] },
      },
    ],
    itemPolicies: [
      {
        ...account,
        itemId: "00000000-0000-4000-8000-000000000002",
        itemName: "Example Bank",
        selected: true,
        excluded: false,
        excludedFields: ["login.totp", { custom: "PIN", position: 2, count: 2 }, { custom: null }],
      },
    ],
    customFieldReviews: [
      {
        ...account,
        itemId: "00000000-0000-4000-8000-000000000002",
        evidence: `bitwarden-v1:sha256:${"a".repeat(64)}`,
        revisionDate: "2026-10-11T07:10:03.1234567Z",
      },
    ],
  };
}

describe("settings sync contract", () => {
  it("represents an empty service state only at revision 0", () => {
    expect(accepts(syncSettingsStateSchema, { version: 1, revision: 0, settings: null })).toBe(
      true,
    );
    expect(accepts(syncSettingsStateSchema, { version: 1, revision: 1, settings: null })).toBe(
      false,
    );
    expect(
      accepts(syncSettingsStateSchema, {
        version: 1,
        revision: 0,
        settings: createDefaultSettings(),
      }),
    ).toBe(false);
  });

  it("syncs policy only, never device-local field policies or values", () => {
    const write = { version: 1, expectedRevision: 0, settings: createDefaultSettings() };
    expect(accepts(syncSettingsWriteSchema, write)).toBe(true);
    expect(accepts(syncSettingsWriteSchema, { ...write, fieldPolicies: [] })).toBe(false);
    expect(
      accepts(syncSettingsWriteSchema, {
        ...write,
        settings: { ...write.settings, password: "synthetic-forbidden-value" },
      }),
    ).toBe(false);
    // Field policies live in item policies now; the removed list is not accepted.
    expect(
      accepts(syncSettingsWriteSchema, {
        ...write,
        settings: { ...write.settings, fieldPolicies: [] },
      }),
    ).toBe(false);
  });

  it("carries account policies, item policies and custom-field reviews (ADR 0023)", () => {
    const settings = policyDocument();
    expect(accepts(syncSettingsWriteSchema, { version: 1, expectedRevision: 3, settings })).toBe(
      true,
    );
    const state = { version: 1, revision: 4, settings };
    expect(v.parse(syncSettingsStateSchema, state)).toEqual(state);
    // A conflict answers the current document with its lists.
    expect(v.parse(syncErrorSchema, { error: "settings_conflict", current: state })).toEqual({
      error: "settings_conflict",
      current: state,
    });
  });

  it.each([
    [
      "an account policy without a server",
      (s: LocalSettings) =>
        delete (s.accountPolicies[0] as Partial<LocalSettings["accountPolicies"][number]>).server,
    ],
    [
      "an item policy with a value",
      (s: LocalSettings) => Object.assign(s.itemPolicies[0]!, { value: "synthetic" }),
    ],
    [
      "a review without evidence",
      (s: LocalSettings) =>
        delete (s.customFieldReviews[0] as Partial<LocalSettings["customFieldReviews"][number]>)
          .evidence,
    ],
    [
      "an old connection policy",
      (s: LocalSettings) =>
        s.connections.push({
          connectionId: "c",
          enabled: true,
          selection: { mode: "all" },
        } as never),
    ],
  ])("refuses a document with %s", (_label, change) => {
    const settings = policyDocument();
    change(settings);
    expect(accepts(syncSettingsWriteSchema, { version: 1, expectedRevision: 0, settings })).toBe(
      false,
    );
    expect(accepts(syncSettingsStateSchema, { version: 1, revision: 1, settings })).toBe(false);
  });
});

describe("recipe sync contract", () => {
  it("binds the stored recipe to its sync identity and revision", () => {
    const change = { recipeId: "bank-login", revision: 2, state: "active", recipe: recipe(2) };
    expect(accepts(syncRecipeChangeSchema, change)).toBe(true);
    expect(accepts(syncRecipeChangeSchema, { ...change, revision: 3 })).toBe(false);
    expect(accepts(syncRecipeChangeSchema, { ...change, recipeId: "other-login" })).toBe(false);
    expect(
      accepts(syncRecipeChangeSchema, { recipeId: "bank-login", revision: 3, state: "revoked" }),
    ).toBe(true);
    expect(accepts(syncRecipeChangeSchema, { ...change, state: "revoked" })).toBe(false);
  });

  it("requires each write to advance exactly one revision", () => {
    const write = { version: 1, expectedRevision: 1, state: "active", recipe: recipe(2) };
    expect(accepts(syncRecipeWriteSchema, write)).toBe(true);
    expect(accepts(syncRecipeWriteSchema, { ...write, recipe: recipe(1) })).toBe(false);
    expect(accepts(syncRecipeWriteSchema, { ...write, recipe: recipe(3) })).toBe(false);
  });

  it("only tombstones a recipe that already has a revision", () => {
    expect(
      accepts(syncRecipeWriteSchema, { version: 1, expectedRevision: 1, state: "revoked" }),
    ).toBe(true);
    expect(
      accepts(syncRecipeWriteSchema, { version: 1, expectedRevision: 0, state: "revoked" }),
    ).toBe(false);
  });
});
