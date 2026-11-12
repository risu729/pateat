import { describe, expect, it } from "vitest";
import {
  latestRulesCase,
  pauseSettings,
  rule,
  sharedRulesCase,
  sitePauseCases,
} from "../../../../packages/contracts/src/__fixtures__/site-pause";
import { siteRules } from "./pause";

// The owner web UI's wrapper of the same policy is tested in tests/manage/site-rules.test.tsx.
describe("popup permanent pause wrapper", () => {
  it.each(sitePauseCases)("preserves the site boundary for $origin", ({ origin, site, other }) => {
    const snapshot = pauseSettings([rule(site, true), rule(other, true)]);
    const edit = siteRules(snapshot, origin);
    expect(edit.rules).toEqual([rule(site, true)]);
    expect(edit.shared).toEqual([]);
    const latest = structuredClone(snapshot);
    edit.resume(latest);
    expect(latest.excludedSites).toEqual([rule(other, true)]);
    edit.pause(latest);
    expect(latest.excludedSites).toEqual([rule(other, true), rule(site, true)]);
    expect(snapshot.excludedSites).toEqual([rule(site, true), rule(other, true)]);
  });

  it("reports broader shared rules separately and keeps exact-only parents on resume", () => {
    const snapshot = pauseSettings(sharedRulesCase.excludedSites);
    const edit = siteRules(snapshot, sharedRulesCase.origin);
    expect(edit.rules).toEqual(sharedRulesCase.rules);
    expect(edit.shared).toEqual(sharedRulesCase.shared);
    const latest = structuredClone(snapshot);
    edit.resume(latest);
    expect(latest.excludedSites).toEqual(sharedRulesCase.resumed);
  });

  it("applies a prepared edit in place to new rules without restoring or deleting unrelated policy", () => {
    const snapshot = pauseSettings(latestRulesCase.snapshot);
    const beforeSnapshot = structuredClone(snapshot);
    const edit = siteRules(snapshot, latestRulesCase.origin);
    const latest = pauseSettings(latestRulesCase.latest);
    const toPause = structuredClone(latest);
    edit.resume(latest);
    expect(latest).toEqual(pauseSettings(latestRulesCase.resumed));
    edit.pause(toPause);
    expect(toPause).toEqual(pauseSettings(latestRulesCase.paused));
    expect(snapshot).toEqual(beforeSnapshot);
    expect(edit.rules).toEqual([]);
  });
});
