import type { LocalSettings } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { rule, sitePauseCases } from "../../../../packages/contracts/src/__fixtures__/site-pause";
import { siteRules as managementRules } from "../../../../services/api/web/settings";
import { siteRules as popupRules } from "./pause";

const settings = (excludedSites: LocalSettings["excludedSites"]): LocalSettings => ({
  connections: [],
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites,
  repromptSites: [rule("reprompt.example")],
  passkeyBrowserSites: [{ hostname: "browser.example" }],
  allowedSitesEnabled: true,
  allowedSites: [rule("allowed.example", true)],
  siteDefaults: [],
  bindings: [],
  loginInPrivateWindows: true,
});

describe.each(["popup", "management"] as const)("%s permanent pause wrapper", (surface) => {
  function plan(value: LocalSettings, origin: string) {
    if (surface === "management") {
      const edit = managementRules(value, origin);
      return { ...edit, pause: edit.pause.apply, resume: edit.resume.apply };
    }
    const edit = popupRules(value, origin);
    return {
      ...edit,
      pause: (latest: LocalSettings) => {
        expect(edit.pause(latest)).toBeUndefined();
        return latest;
      },
      resume: (latest: LocalSettings) => {
        expect(edit.resume(latest)).toBeUndefined();
        return latest;
      },
    };
  }

  it.each(sitePauseCases)("preserves the site boundary for $origin", ({ origin, site, other }) => {
    const snapshot = settings([rule(site, true), rule(other, true)]);
    const edit = plan(snapshot, origin);
    expect(edit.rules).toEqual([rule(site, true)]);
    expect(edit.shared).toEqual([]);
    const latest = structuredClone(snapshot);
    const resumed = edit.resume(latest);
    expect(resumed.excludedSites).toEqual([rule(other, true)]);
    expect(edit.pause(resumed).excludedSites).toEqual([rule(other, true), rule(site, true)]);
    expect(snapshot.excludedSites).toEqual([rule(site, true), rule(other, true)]);
  });

  it("reports broader shared rules separately and keeps exact-only parents on resume", () => {
    const snapshot = settings([
      rule("example.co.uk"),
      rule("auth.example.co.uk", true),
      rule("login.auth.example.co.uk"),
      rule("co.uk", true),
      rule("mail.example.co.uk", true),
      rule("child.login.auth.example.co.uk", true),
    ]);
    const edit = plan(snapshot, "https://login.auth.example.co.uk");
    expect(edit.rules).toEqual([
      rule("auth.example.co.uk", true),
      rule("login.auth.example.co.uk"),
      rule("co.uk", true),
    ]);
    expect(edit.shared).toEqual([rule("co.uk", true)]);
    expect(edit.resume(structuredClone(snapshot)).excludedSites).toEqual([
      rule("example.co.uk"),
      rule("co.uk", true),
      rule("mail.example.co.uk", true),
      rule("child.login.auth.example.co.uk", true),
    ]);
  });

  it("applies a prepared edit to new rules without restoring or deleting unrelated policy", () => {
    const snapshot = settings([rule("example.co.uk")]);
    const beforeSnapshot = structuredClone(snapshot);
    const edit = plan(snapshot, "https://login.auth.example.co.uk");
    const latest = settings([
      rule("co.uk", true),
      rule("example.co.uk", true),
      rule("auth.example.co.uk", true),
      rule("login.auth.example.co.uk"),
      rule("child.login.auth.example.co.uk", true),
      rule("mail.example.co.uk"),
      rule("other.example"),
    ]);
    const beforeLatest = structuredClone(latest);
    const expected = settings([
      rule("co.uk", true),
      rule("child.login.auth.example.co.uk", true),
      rule("mail.example.co.uk"),
      rule("other.example"),
    ]);
    const resumed = edit.resume(latest);
    expect(resumed).toEqual(expected);
    expect(snapshot).toEqual(beforeSnapshot);
    if (surface === "popup") expect(resumed).toBe(latest);
    else {
      expect(resumed).not.toBe(latest);
      expect(latest).toEqual(beforeLatest);
    }
    const toPause = structuredClone(beforeLatest);
    const paused = edit.pause(toPause);
    expect(paused).toEqual(
      settings([
        rule("co.uk", true),
        rule("auth.example.co.uk", true),
        rule("login.auth.example.co.uk"),
        rule("child.login.auth.example.co.uk", true),
        rule("mail.example.co.uk"),
        rule("other.example"),
        rule("example.co.uk", true),
      ]),
    );
    if (surface === "popup") expect(paused).toBe(toPause);
    else {
      expect(paused).not.toBe(toPause);
      expect(toPause).toEqual(beforeLatest);
    }
    expect(edit.rules).toEqual([]);
  });
});

it("keeps the management wrapper's empty-settings behavior and completion notices", () => {
  const edit = managementRules(null, "https://login.example.co.uk");
  expect(edit.site).toBe("example.co.uk");
  expect(edit.rules).toEqual([]);
  expect(edit.shared).toEqual([]);
  expect(edit.pause.done).toBe("example.co.uk paused");
  expect(edit.resume.done).toBe("example.co.uk resumed");
  expect(edit.pause.apply(settings([]))).toEqual(settings([rule("example.co.uk", true)]));
});
