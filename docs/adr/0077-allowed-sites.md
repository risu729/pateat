# ADR 0077: Allowed sites

Status: accepted by the owner. The plan's phase 4 item "Settings to limit Pateat as an
extension that handles personal data: only allowed sites (an allowlist)" is the owner's,
and the owner chose to build it now (2026-10-19 13:36 UTC). On 2026-10-19 the owner
chose that the list is a part of each settings profile, like the exclusions (root
decision 1-3, A). On 2026-10-23 at 12:43 UTC the owner accepted the rest of the bundle
recommended for [#614](https://github.com/risu729/pateat/pull/614): a separate on/off
switch that keeps the list, an empty list to start, a popup switch that edits the
allowed sites, the **Allow** button renamed **Remove exclusion**, and the allowed sites
shown on the management page's site switch in the same change. Details not covered there
were chosen by an agent and are marked so.
[ADR 0062](0062-log-in-again-after-a-logout.md) then made an exclusion a pause of
automatic login and replaced the popup's switch with a pause row, and main renamed the
button **Resume**, so the parts about the switch and the button were reworked on
2026-10-24 (agent's choice, below; the owner was asked whether a site left out stops
Pateat fully or only pauses automatic login, and this ADR assumes the full stop until
the owner answers). Amends [ADR 0024](0024-settings-profiles.md) (a new profile part).
Replaces the allowlist half of the proposal that was ADR 0042 on the
[#614](https://github.com/risu729/pateat/pull/614) branch, whose vault timeout half
became [ADR 0075](0075-vault-lock-and-timeout.md).

Date: 2026-10-23

## Context

Pateat may act on every HTTPS page and, for vault items saved with an `http://` URI, on
HTTP pages too ([ADR 0009](0009-install-time-https-site-access.md),
[ADR 0050](0050-http-pages-for-http-items.md)). What it does there is limited by
exclusion rules per hostname, and per connection by whether the connection is on, which
items are selected, and which items and fields are excluded
([ADR 0023](0023-synced-vault-policy.md)). There was no way to say "only these sites":
an agent's browser that should sign in to two sites had to exclude every other one it
might visit.

## Decision

- The settings gain `allowedSites`, a list of the same rules as `excludedSites` (a
  hostname, optionally with its subdomains, at most 1000, no duplicates), and
  `allowedSitesEnabled`. While the switch is on, Pateat acts only on a site one of the
  rules covers. While it is off, the list is kept and limits nothing. Both are optional
  in the document: absent is an empty list that is off, which is how every profile
  starts (owner).
- A site the allowed sites leave out is a full stop (agent's choice, pending the owner):
  Pateat does not admit its documents, logs in from no popup pick there, fills nothing
  and answers no passkey request. An exclusion only pauses automatic login
  ([ADR 0062](0062-log-in-again-after-a-logout.md)), so an allowed site can still be
  paused, and a site that is both left out and excluded counts as left out. A rule names
  a hostname only, so it covers every scheme and port, HTTP pages included.
- `isSiteAllowed` in `packages/contracts/src/settings.ts` is the one check, next to
  `isSiteExcluded`, which stays the pause alone. Every place that refuses a site checks
  it: document admission (`site-not-allowed`), logins, sign-in entries and their
  destinations (`destination-not-allowed`), recipe generation, personal-detail offers,
  passkey answers, vault URI matches and the popup's account list. A login across hosts,
  such as a frame of another host, needs each host allowed. `siteAccess` orders the
  causes: an invalid address, then a site left out, then a paused one; the toolbar
  badge says a site left out is not allowed, and the settings page says a default is not
  used because its site is not allowed.
- They are a profile part ([ADR 0024](0024-settings-profiles.md),
  [ADR 0076](0076-settings-profiles-delivered.md); owner): `profileDocument` stores
  them, leaving them out while the list is empty and off. The extension merges the list
  per hostname, like the exclusions, and the switch like one entry: the service's change
  since the last sync wins, then a local change
  ([ADR 0013](0013-service-held-recipes-and-settings.md)).
- The extension's settings page has an **Allowed sites** section: a **Run only on
  allowed sites** switch, the rules with **Remove**, and a form to allow a site,
  optionally with its subdomains. The same section edits another profile from the
  settings page's profile editor (agent's choice).
- On a site the allowed sites leave out, the popup lists no accounts and has no pause
  row. It says Pateat runs only on allowed sites and offers **Allow** with the site's
  name, which adds the registrable site with its subdomains, the same site a pause
  covers (agent's choice). Removing an allowed site is done in the settings.
- The management page's Sites page has the same **Allowed sites** section for the
  profile it shows and marks a site the allowed sites leave out **Not allowed**, beside
  any **Paused** mark. A site's page says such a site is not allowed and offers the same
  **Allow** button; its **Automatic login on this site** switch only pauses and resumes
  (agent's choice).
- Diagnostics count the allowed sites and say whether they are on; the hostnames are
  only used to decide whether a log entry may keep a site's address, as excluded
  hostnames are.
- No new permission: the allowed sites narrow what Pateat does with the access it has.

## Consequences

- Turning the switch on with an empty list stops every login, fill and passkey answer on
  the devices of that profile until a site is allowed. The settings page and the
  management page say so (agent's wording).
- The official Bitwarden extension has nothing like the allowed sites; see
  [the differences](../bitwarden-differences.md#allowed-sites).
