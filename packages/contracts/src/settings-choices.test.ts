import { describe, expect, it } from "vitest";
import {
  CHOICE_ONLY_CAUSES,
  onlyChoicesSince,
  standingRevision,
  type SettingsChangeCause,
} from "./index";

// Synthetic revisions only (ADR 0007, ADR 0061).

const at = (revision: number, ...causes: SettingsChangeCause[]) => ({
  revision,
  changes: causes.map((cause, index) => ({
    revision: revision - causes.length + 1 + index,
    cause,
  })),
});

describe("revisions of only a choice", () => {
  it("names the passkey browser sites and the removal of refused detail links", () => {
    expect([...CHOICE_ONLY_CAUSES].toSorted()).toEqual(["detail-refused", "passkey-browser-site"]);
  });

  it("leaves a revision standing while every later one wrote only a choice", () => {
    expect(onlyChoicesSince(at(4), 4)).toBe(true);
    expect(onlyChoicesSince(at(6, "passkey-browser-site", "detail-refused"), 4)).toBe(true);
    expect(standingRevision(at(6, "passkey-browser-site", "detail-refused"), 4)).toBe(6);
  });

  it("ends it with any other cause, a revision the history no longer holds or a store behind", () => {
    expect(onlyChoicesSince(at(6, "passkey-browser-site", "settings-save"), 4)).toBe(false);
    expect(onlyChoicesSince(at(6, "detail-link", "passkey-browser-site"), 4)).toBe(false);
    // Revision 5 has no recorded cause.
    expect(onlyChoicesSince(at(6, "passkey-browser-site"), 4)).toBe(false);
    expect(onlyChoicesSince({ revision: 6 }, 5)).toBe(false);
    expect(onlyChoicesSince(at(3), 4)).toBe(false);
    // The write then expects the older revision, which the store refuses.
    expect(standingRevision(at(6, "detail-link", "passkey-browser-site"), 4)).toBe(4);
  });

  it("takes another set of causes", () => {
    expect(onlyChoicesSince(at(5, "detail-link"), 4, new Set(["detail-link"]))).toBe(true);
  });
});
