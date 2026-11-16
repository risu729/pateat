import { describe, expect, it } from "vitest";
import { CHOICE_ONLY_CAUSES, onlyChoicesSince, type SettingsChangeCause } from "./index";

// Synthetic revisions only (ADR 0007, ADR 0061, ADR 0085).

const at = (revision: number, ...causes: SettingsChangeCause[]) => ({
  revision,
  changes: causes.map((cause, index) => ({
    revision: revision - causes.length + 1 + index,
    cause,
  })),
});

describe("revisions of only a choice", () => {
  it("names the passkey browser sites, the removal of refused detail links and SSO mappings", () => {
    expect([...CHOICE_ONLY_CAUSES].toSorted()).toEqual([
      "detail-refused",
      "passkey-browser-site",
      "sso-mapping",
    ]);
  });

  it("leaves a revision standing while every later one wrote only a choice", () => {
    expect(onlyChoicesSince(at(4), 4)).toBe(true);
    expect(onlyChoicesSince(at(6, "passkey-browser-site", "detail-refused"), 4)).toBe(true);
  });

  it("ends it with any other cause, a revision the history no longer holds or a store behind", () => {
    expect(onlyChoicesSince(at(6, "passkey-browser-site", "settings-save"), 4)).toBe(false);
    expect(onlyChoicesSince(at(6, "detail-link", "passkey-browser-site"), 4)).toBe(false);
    // Revision 5 has no recorded cause.
    expect(onlyChoicesSince(at(6, "passkey-browser-site"), 4)).toBe(false);
    expect(onlyChoicesSince({ revision: 6 }, 5)).toBe(false);
    expect(onlyChoicesSince(at(3), 4)).toBe(false);
  });

  it("takes another set of causes", () => {
    expect(onlyChoicesSince(at(5, "detail-link"), 4, new Set(["detail-link"]))).toBe(true);
  });
});
