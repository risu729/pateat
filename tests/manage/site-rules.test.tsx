import { describe, expect, it } from "vitest";
import {
  latestRulesCase,
  pauseSettings,
  rule,
  sharedRulesCase,
  sitePauseCases,
} from "../../packages/contracts/src/__fixtures__/site-pause";
import { siteRules } from "../../services/api/web/settings";

// The extension popup's wrapper of the same policy is tested in
// apps/extension/src/popup/site-rules.test.ts.
describe("owner web UI permanent pause wrapper", () => {
  it.each(sitePauseCases)("preserves the site boundary for $origin", ({ origin, site, other }) => {
    const snapshot = pauseSettings([rule(site, true), rule(other, true)]);
    const edit = siteRules(snapshot, origin);
    expect(edit.site).toBe(site);
    expect(edit.rules).toEqual([rule(site, true)]);
    expect(edit.shared).toEqual([]);
    const resumed = edit.resume.apply(structuredClone(snapshot));
    expect(resumed.excludedSites).toEqual([rule(other, true)]);
    expect(edit.pause.apply(resumed).excludedSites).toEqual([rule(other, true), rule(site, true)]);
    expect(resumed.excludedSites).toEqual([rule(other, true)]);
    expect(snapshot.excludedSites).toEqual([rule(site, true), rule(other, true)]);
  });

  it("reports broader shared rules separately and keeps exact-only parents on resume", () => {
    const snapshot = pauseSettings(sharedRulesCase.excludedSites);
    const edit = siteRules(snapshot, sharedRulesCase.origin);
    expect(edit.rules).toEqual(sharedRulesCase.rules);
    expect(edit.shared).toEqual(sharedRulesCase.shared);
    expect(edit.resume.apply(snapshot).excludedSites).toEqual(sharedRulesCase.resumed);
    expect(snapshot.excludedSites).toEqual(sharedRulesCase.excludedSites);
  });

  it("applies a prepared edit to a copy of new rules without restoring or deleting unrelated policy", () => {
    const snapshot = pauseSettings(latestRulesCase.snapshot);
    const beforeSnapshot = structuredClone(snapshot);
    const edit = siteRules(snapshot, latestRulesCase.origin);
    const latest = pauseSettings(latestRulesCase.latest);
    const beforeLatest = structuredClone(latest);
    const resumed = edit.resume.apply(latest);
    expect(resumed).toEqual(pauseSettings(latestRulesCase.resumed));
    expect(resumed).not.toBe(latest);
    const paused = edit.pause.apply(latest);
    expect(paused).toEqual(pauseSettings(latestRulesCase.paused));
    expect(paused).not.toBe(latest);
    expect(latest).toEqual(beforeLatest);
    expect(snapshot).toEqual(beforeSnapshot);
    expect(edit.rules).toEqual([]);
  });
});

it("keeps the owner web UI wrapper's empty-settings behavior and completion notices", () => {
  const edit = siteRules(null, "https://login.example.co.uk");
  expect(edit.site).toBe("example.co.uk");
  expect(edit.rules).toEqual([]);
  expect(edit.shared).toEqual([]);
  expect(edit.pause.done).toBe("example.co.uk paused");
  expect(edit.resume.done).toBe("example.co.uk resumed");
  expect(edit.pause.apply(pauseSettings([]))).toEqual(pauseSettings([rule("example.co.uk", true)]));
});
