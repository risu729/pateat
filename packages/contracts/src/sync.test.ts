import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { LoginRecipe } from "./login";
import { createDefaultSettings } from "./settings";
import {
  isGeneratedRecipeId,
  loginOutcomeReportSchema,
  loginRecordSchema,
  recipeUseReportSchema,
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

describe("login outcome report contract", () => {
  const report = { version: 1, revision: 3, outcome: "unknown-submit", cause: "settled", step: 1 };

  it("accepts codes and numbers only", () => {
    expect(accepts(loginOutcomeReportSchema, report)).toBe(true);
    expect(accepts(loginOutcomeReportSchema, { ...report, branch: "other" })).toBe(true);
    const { cause: _cause, ...withoutCause } = report;
    expect(accepts(loginOutcomeReportSchema, withoutCause)).toBe(true);
  });

  it("refuses free text, unknown codes and anything beyond the codes", () => {
    for (const extra of [
      { url: "https://bank.example/login" },
      { reason: "Sign in failed for user@example.com" },
      { recipeId: "gen-0123" },
      { at: 1 },
    ])
      expect(accepts(loginOutcomeReportSchema, { ...report, ...extra })).toBe(false);
    for (const changed of [
      { outcome: "failed" },
      { cause: "Wrong password" },
      { branch: "" },
      { revision: 0 },
      { step: 41 },
      { step: 1.5 },
      { version: 2 },
    ])
      expect(accepts(loginOutcomeReportSchema, { ...report, ...changed })).toBe(false);
  });
});

describe("login record contract", () => {
  const record = {
    version: 1,
    revision: 3,
    outcome: "authenticated",
    extensionBuild: "1c42ad3e9f0b5d7a6c4e2f1a3b5d7e9f0a1c3e5d",
    totalMs: 4210,
    serviceMs: 0,
    networkMs: 0,
    personMs: 0,
    pageMs: 0,
  };

  it("accepts codes, the build and whole milliseconds only", () => {
    expect(accepts(loginRecordSchema, record)).toBe(true);
    expect(accepts(loginRecordSchema, { ...record, branch: "other", cause: "settled" })).toBe(true);
    expect(accepts(loginRecordSchema, { ...record, extensionBuild: "development" })).toBe(true);
    expect(accepts(loginRecordSchema, { ...record, totalMs: 86_400_000 })).toBe(true);
  });

  it("refuses a site, free text, typing time and anything beyond the fields", () => {
    for (const extra of [
      { origin: "https://bank.example" },
      { url: "https://bank.example/login" },
      { reason: "Sign in failed for user@example.com" },
      { otherMs: 1 },
      { typingMs: 1 },
      { step: 1 },
      { at: 1 },
    ])
      expect(accepts(loginRecordSchema, { ...record, ...extra })).toBe(false);
    for (const changed of [
      { outcome: "failed" },
      { cause: "Wrong password" },
      { branch: "" },
      { revision: 0 },
      { totalMs: -1 },
      { serviceMs: 1.5 },
      { personMs: 86_400_001 },
      { pageMs: -1 },
      { pageMs: 86_400_001 },
      { extensionBuild: "Release 1" },
      { extensionBuild: "https://bank.example" },
      { version: 2 },
    ])
      expect(accepts(loginRecordSchema, { ...record, ...changed })).toBe(false);
    const { totalMs: _totalMs, ...withoutTotal } = record;
    expect(accepts(loginRecordSchema, withoutTotal)).toBe(false);
    const { pageMs: _pageMs, ...withoutPage } = record;
    expect(accepts(loginRecordSchema, withoutPage)).toBe(false);
  });
});

describe("recipe use report contract (ADR 0058)", () => {
  it("accepts a version and a written revision only", () => {
    expect(accepts(recipeUseReportSchema, { version: 1, revision: 1 })).toBe(true);
    expect(accepts(recipeUseReportSchema, { version: 1, revision: 3 })).toBe(true);
    expect(
      accepts(recipeUseReportSchema, { version: 1, revision: Number.MAX_SAFE_INTEGER - 1 }),
    ).toBe(true);
  });

  it("refuses an unwritten or malformed revision, a site and anything beyond the fields", () => {
    for (const changed of [
      { revision: 0 },
      { revision: -1 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER },
      { revision: "1" },
      { revision: undefined },
      { version: 2 },
      { version: undefined },
    ])
      expect(accepts(recipeUseReportSchema, { version: 1, revision: 1, ...changed })).toBe(false);
    for (const extra of [
      { origin: "https://bank.example" },
      { url: "https://bank.example/login" },
      { username: "someone@example.com" },
      { branch: "other" },
      { at: 1 },
    ])
      expect(accepts(recipeUseReportSchema, { version: 1, revision: 1, ...extra })).toBe(false);
    expect(accepts(recipeUseReportSchema, null)).toBe(false);
    expect(accepts(recipeUseReportSchema, [])).toBe(false);
  });
});

describe("generated recipe IDs (ADR 0058 A)", () => {
  it("accepts the service's generated form only", () => {
    expect(isGeneratedRecipeId("gen-0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isGeneratedRecipeId(`gen-${"0".repeat(32)}`)).toBe(true);
    expect(isGeneratedRecipeId(`gen-${"f".repeat(32)}`)).toBe(true);
  });

  it.each([
    ["an owner's recipe ID", "bank-login"],
    ["a short digest", `gen-${"a".repeat(31)}`],
    ["a long digest", `gen-${"a".repeat(33)}`],
    ["upper-case hex", `gen-${"A".repeat(32)}`],
    ["a non-hex digit", `gen-${"g".repeat(32)}`],
    ["another prefix", `gem-${"a".repeat(32)}`],
    ["a capitalized prefix", `GEN-${"a".repeat(32)}`],
    ["no separator", `gen${"a".repeat(32)}`],
    ["a prefix before it", `x-gen-${"a".repeat(32)}`],
    ["a suffix after it", `gen-${"a".repeat(32)}-2`],
    ["a trailing newline", `gen-${"a".repeat(32)}\n`],
    ["the prefix alone", "gen-"],
    ["nothing", ""],
  ])("refuses %s", (_, recipeId) => {
    expect(isGeneratedRecipeId(recipeId)).toBe(false);
  });
});
