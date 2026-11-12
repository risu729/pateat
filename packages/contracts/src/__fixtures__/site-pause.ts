import type { LocalSettings } from "../settings/schema";

/** Canonical rules and synthetic origins shared by policy and public-wrapper tests. */
export const rule = (hostname: string, includeSubdomains = false) => ({
  hostname,
  includeSubdomains,
});
export const sitePauseCases = [
  { origin: "https://login.example.co.uk", site: "example.co.uk", other: "other.co.uk" },
  { origin: "http://login.example.co.uk:8080", site: "example.co.uk", other: "other.co.uk" },
  { origin: "https://auth.alice.github.io", site: "alice.github.io", other: "bob.github.io" },
  { origin: "https://LOGIN.Example.COM.", site: "example.com", other: "other.example.com" },
  { origin: "http://192.0.2.1:8080", site: "192.0.2.1", other: "192.0.2.2" },
  { origin: "https://[2001:0db8::1]:8443", site: "[2001:db8::1]", other: "[2001:db8::2]" },
  { origin: "http://localhost:8080", site: "localhost", other: "other.localhost" },
  { origin: "http://router.", site: "router", other: "other.router" },
  { origin: "https://login.intranet", site: "login.intranet", other: "other.intranet" },
  { origin: "https://co.uk", site: "co.uk", other: "other.uk" },
] as const;

/**
 * Settings with the given exclusion rules and unrelated site policy that a pause or resume
 * of the popup or the owner web UI must leave as it is.
 */
export const pauseSettings = (excludedSites: LocalSettings["excludedSites"]): LocalSettings => ({
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

/**
 * A rule for a parent of the site covers other sites too, so it is reported as shared and
 * stays on resume, as do exact-only parents and rules that do not cover the origin.
 */
export const sharedRulesCase = {
  origin: "https://login.auth.example.co.uk",
  excludedSites: [
    rule("example.co.uk"),
    rule("auth.example.co.uk", true),
    rule("login.auth.example.co.uk"),
    rule("co.uk", true),
    rule("mail.example.co.uk", true),
    rule("child.login.auth.example.co.uk", true),
  ],
  rules: [rule("auth.example.co.uk", true), rule("login.auth.example.co.uk"), rule("co.uk", true)],
  shared: [rule("co.uk", true)],
  resumed: [
    rule("example.co.uk"),
    rule("co.uk", true),
    rule("mail.example.co.uk", true),
    rule("child.login.auth.example.co.uk", true),
  ],
};

/**
 * An edit prepared from `snapshot` and applied to `latest`, which changed meanwhile: it
 * neither restores the snapshot's rules nor deletes unrelated policy.
 */
export const latestRulesCase = {
  origin: "https://login.auth.example.co.uk",
  snapshot: [rule("example.co.uk")],
  latest: [
    rule("co.uk", true),
    rule("example.co.uk", true),
    rule("auth.example.co.uk", true),
    rule("login.auth.example.co.uk"),
    rule("child.login.auth.example.co.uk", true),
    rule("mail.example.co.uk"),
    rule("other.example"),
  ],
  resumed: [
    rule("co.uk", true),
    rule("child.login.auth.example.co.uk", true),
    rule("mail.example.co.uk"),
    rule("other.example"),
  ],
  paused: [
    rule("co.uk", true),
    rule("auth.example.co.uk", true),
    rule("login.auth.example.co.uk"),
    rule("child.login.auth.example.co.uk", true),
    rule("mail.example.co.uk"),
    rule("other.example"),
    rule("example.co.uk", true),
  ],
};
