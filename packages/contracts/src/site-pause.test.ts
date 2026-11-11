import { describe, expect, it } from "vitest";
import { rule, sitePauseCases } from "./__fixtures__/site-pause";
import { sitePauseRules } from "./site";

describe("permanent site pause policy", () => {
  it.each(sitePauseCases)(
    "keeps the canonical site boundary for $origin",
    ({ origin, site, other }) => {
      const initial = [rule(site, true), rule(other, true)];
      const policy = sitePauseRules(initial, origin);
      expect(policy.site).toBe(site);
      expect(policy.rules).toEqual([rule(site, true)]);
      expect(policy.shared).toEqual([]);
      expect(policy.pause(initial)).toEqual([rule(other, true), rule(site, true)]);
      expect(policy.resume(initial)).toEqual([rule(other, true)]);
      expect(initial).toEqual([rule(site, true), rule(other, true)]);
    },
  );

  it("distinguishes covering ancestors from exact-only parents, siblings and descendants", () => {
    const initial = [
      rule("example.co.uk"),
      rule("auth.example.co.uk", true),
      rule("login.auth.example.co.uk"),
      rule("co.uk", true),
      rule("mail.example.co.uk", true),
      rule("child.login.auth.example.co.uk", true),
      rule("notexample.co.uk", true),
    ];
    const policy = sitePauseRules(initial, "https://login.auth.example.co.uk");
    expect(policy.rules).toEqual([
      rule("auth.example.co.uk", true),
      rule("login.auth.example.co.uk"),
      rule("co.uk", true),
    ]);
    expect(policy.shared).toEqual([rule("co.uk", true)]);
    expect(policy.resume(initial)).toEqual([
      rule("example.co.uk"),
      rule("co.uk", true),
      rule("mail.example.co.uk", true),
      rule("child.login.auth.example.co.uk", true),
      rule("notexample.co.uk", true),
    ]);
  });

  it("retains a private suffix rule that also covers other tenants", () => {
    const initial = [
      rule("github.io", true),
      rule("alice.github.io", true),
      rule("bob.github.io", true),
    ];
    const policy = sitePauseRules(initial, "https://auth.alice.github.io");
    expect(policy.rules).toEqual([rule("github.io", true), rule("alice.github.io", true)]);
    expect(policy.shared).toEqual([rule("github.io", true)]);
    expect(policy.resume(initial)).toEqual([rule("github.io", true), rule("bob.github.io", true)]);
  });

  it("edits the latest immutable list while leaving the displayed snapshot unchanged", () => {
    const snapshot = Object.freeze([Object.freeze(rule("example.co.uk"))]);
    const policy = sitePauseRules(snapshot, "https://login.auth.example.co.uk");
    const latest = Object.freeze(
      [
        rule("co.uk", true),
        rule("example.co.uk", true),
        rule("auth.example.co.uk", true),
        rule("login.auth.example.co.uk"),
        rule("child.login.auth.example.co.uk", true),
        rule("mail.example.co.uk"),
        rule("other.example"),
      ].map((entry) => Object.freeze(entry)),
    );
    const before = structuredClone(latest);
    expect(policy.rules).toEqual([]);
    expect(policy.pause(latest)).toEqual([
      rule("co.uk", true),
      rule("auth.example.co.uk", true),
      rule("login.auth.example.co.uk"),
      rule("child.login.auth.example.co.uk", true),
      rule("mail.example.co.uk"),
      rule("other.example"),
      rule("example.co.uk", true),
    ]);
    expect(policy.resume(latest)).toEqual([
      rule("co.uk", true),
      rule("child.login.auth.example.co.uk", true),
      rule("mail.example.co.uk"),
      rule("other.example"),
    ]);
    expect(latest).toEqual(before);
    expect(snapshot).toEqual([rule("example.co.uk")]);
    expect(policy.rules).toEqual([]);
  });
});
