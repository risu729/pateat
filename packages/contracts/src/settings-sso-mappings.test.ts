import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  createDefaultSettings,
  localSettingsSchema,
  MAX_SETTINGS_DOCUMENT_BYTES,
  MAX_SSO_MAPPINGS,
  onlyChoicesSince,
  SETTINGS_CHANGE_CAUSES,
  SETTINGS_CHANGE_HISTORY,
  settingsDocumentBytes,
  ssoMappingKey,
  ssoMappingSchema,
  type SettingsChangeCause,
} from "./index";

const account = { provider: "bitwarden", server: "cloud-us", userId: "synthetic-user" };
const mapping = (method = 1, itemId = "a0000000-0000-4000-8000-000000000001") => ({
  ...account,
  itemId,
  method,
  idp: {
    ...account,
    itemId: "a0000000-0000-4000-8000-000000000002",
    origin: "https://idp.example",
  },
});
const settings = (ssoMappings: unknown) => ({ ...createDefaultSettings(), ssoMappings });

describe("SSO mappings (ADR 0085)", () => {
  it("are an optional owner list that names two items, a method and the IdP origin", () => {
    expect(v.is(localSettingsSchema, createDefaultSettings())).toBe(true);
    expect(v.is(localSettingsSchema, settings([mapping(1), mapping(2)]))).toBe(true);
    expect(SETTINGS_CHANGE_CAUSES).toContain("sso-mapping");
  });

  it("refuse a label, evidence or any other field", () => {
    for (const extra of [{ label: "Provider" }, { sourceEvidence: "E".repeat(43) }])
      expect(v.is(ssoMappingSchema, { ...mapping(), ...extra })).toBe(false);
    expect(v.is(ssoMappingSchema, { ...mapping(), idp: { ...mapping().idp, label: "x" } })).toBe(
      false,
    );
  });

  it("need an exact HTTP(S) origin for the identity provider", () => {
    const { origin: _origin, ...idp } = mapping().idp;
    expect(v.is(ssoMappingSchema, { ...mapping(), idp })).toBe(false);
    for (const origin of [
      "https://idp.example/",
      "https://idp.example/login",
      "ftp://idp.example",
      "https://user@idp.example",
    ])
      expect(v.is(ssoMappingSchema, { ...mapping(), idp: { ...idp, origin } })).toBe(false);
  });

  it("refuse a method out of range", () => {
    for (const method of [0, 1_000_001, 1.5])
      expect(v.is(ssoMappingSchema, mapping(method))).toBe(false);
  });

  it("allow one mapping per method of an item, whatever its ID's letter case", () => {
    const upper = mapping(1, "A0000000-0000-4000-8000-000000000001");
    expect(ssoMappingKey(upper)).toBe(ssoMappingKey(mapping(1)));
    expect(v.is(localSettingsSchema, settings([mapping(1), upper]))).toBe(false);
  });

  it(`hold at most ${MAX_SSO_MAPPINGS} mappings, which fit in the settings document`, () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        mapping(1, `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      );
    const full = settings(many(MAX_SSO_MAPPINGS));
    expect(v.is(localSettingsSchema, full)).toBe(true);
    expect(settingsDocumentBytes(full)).toBeLessThan(MAX_SETTINGS_DOCUMENT_BYTES / 2);
    expect(v.is(localSettingsSchema, settings(many(MAX_SSO_MAPPINGS + 1)))).toBe(false);
  });
});

describe("revisions that only saved SSO mappings (ADR 0085)", () => {
  const snapshot = (revision: number, causes: SettingsChangeCause[]) => ({
    revision,
    changes: causes.map((cause, index) => ({
      revision: revision - causes.length + index + 1,
      cause,
    })),
  });

  it("leave a revision standing, alone or with other choices", () => {
    expect(onlyChoicesSince(snapshot(6, ["vault-sync", "sso-mapping", "sso-mapping"]), 4)).toBe(
      true,
    );
    expect(onlyChoicesSince(snapshot(6, ["sso-mapping", "passkey-browser-site"]), 4)).toBe(true);
  });

  it("end it with any other cause, or once the history no longer holds the revision", () => {
    expect(onlyChoicesSince(snapshot(6, ["sso-mapping", "account-choice"]), 4)).toBe(false);
    expect(onlyChoicesSince(snapshot(6, ["service-sync", "sso-mapping"]), 4)).toBe(false);
    const many = Array.from({ length: SETTINGS_CHANGE_HISTORY }, () => "sso-mapping" as const);
    expect(onlyChoicesSince(snapshot(20, many), 20 - SETTINGS_CHANGE_HISTORY)).toBe(true);
    expect(onlyChoicesSince(snapshot(20, many), 19 - SETTINGS_CHANGE_HISTORY)).toBe(false);
  });
});
