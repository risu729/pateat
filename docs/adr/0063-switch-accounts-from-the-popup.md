# ADR 0063: Switch accounts from the popup

Status: proposed, not accepted. Built with
[ADR 0062](0062-log-in-again-after-a-logout.md) at the owner's request of 2026-10-23
(05:28 UTC) to build on the likely answers and decide later. The two questions here
(how Pateat logs out, and how long a pick that is not made the default lasts) were not
yet asked; the decisions below are the reviewed proposal's recommendations. On
2026-10-23 at 11:57 UTC the owner asked to build the switch in the same pull request as
ADR 0062 (「切替は一緒にやってしまいましょう」). Builds the
account switch that
[ADR 0021](0021-account-choice-outside-settings.md#later) kept for later and keeps the
owner's rules recorded there: a switch starts only from the person's choice in the
popup, and it also works on a site where Pateat has not logged in (owner, 2026-10-12
19:19 UTC).

Date: 2026-10-23

## Context

With [ADR 0062](0062-log-in-again-after-a-logout.md), a logout is followed by an
automatic login with the same account, so logging out no longer offers another one. A
person who wants another account needs a way to ask for it while signed in.

Logging out is different on every site, and Pateat writes no site-specific code
([ADR 0033](0033-no-site-specific-features.md)). Pages are judged by the AI first
(owner, 2026-10-12 04:36 UTC). The extractor leaves out hidden elements, so a logout
item inside a closed account menu is not in the observation until the menu is open.

## Decision

### Switching

- In a tab without a waiting choice, the popup lists the site's matching items, each
  with "Switch to this account". The item of the tab's last authenticated login is
  marked "Used in this tab"; Pateat does not otherwise know which account is signed in.
- Pressing it logs the site out and then logs in with that item. The pick is kept for
  the tab and site for two minutes in `pateat.login-switch-picks.v1`
  (`chrome.storage.session`), so the login after the logout uses it; it ends when it
  starts a login, when the switch fails or when the tab closes. A switch pick comes
  first in the account choice, then a popup pick, then an ask, then the session pick
  below, then the saved default, then the only match. The popup has a "Make it the
  default for {host}" checkbox for the switch.
- A switch is refused when the tab has no page, a choice waits, a switch or login runs,
  the settings cannot be read, the site is excluded or paused, or the item is not a
  candidate.
- The logout runs the site's logout recipe. Without one, the tab's top page is observed
  (redacted as a login page is) and sent to the service, whose model answers the control
  that logs out or, when none is shown, the control that opens a menu holding it. After
  a click the page is observed and sent again, also for a confirmation dialog, for at
  most three rounds, through `POST /v1/recipes/logout`. The answer is a logout recipe,
  a signed-out page, or an abstention (`no-logout-control`, `ambiguous`,
  `insufficient-evidence`, `unsafe-instructions`). After each click Pateat waits for the
  page to be quiet for 1.5 seconds, at most 15 seconds. A switch fails with
  `no-logout-control`, `still-signed-in`, `page-unreadable`, `target-missing`,
  `page-changed`, `left-site` or `service-unavailable`.
- After the logout, the login page logs in with the picked item. A site that lands on a
  page with a sign-in entry recipe ([ADR 0031](0031-sign-in-entry-pages.md)) has its
  entry pressed, without the `no-return-target` and `site-record` checks, only for this
  switch.
- The popup says when no logout control was found, when the page still looks signed in
  after three rounds, and when the site is excluded or paused. It also says that a site
  signing in through an identity provider
  ([ADR 0026](0026-sign-in-through-identity-providers.md)) may sign in to the same
  account again, since the provider's session stays.
- The log shows `login.switch` with its stage (`start`, `click`, `end`) and outcome
  only, a failure as a warning, under [ADR 0019](0019-local-diagnostics-and-logs.md).

### Logout recipes

- A stored recipe gains a `logout` member, `{path, targets}`, whose at most three
  targets are clicks (`{kind: "click", path, target, purpose}` with `purpose` `menu`,
  `logout` or `confirm`) with the login recipes' locators (`id`, `name`, `test-id`,
  `text`). Its ID is salted with `["logout", origin, path]`, and the automatic recipe
  removal of [ADR 0058](0058-automatic-recipe-removal.md) leaves it alone. Stored
  recipes are told apart by their members, as `entry` and `chooser` are. The service
  keeps logout recipes apart from login recipes, so a logout recipe on `/` does not
  replace an ADR 0031 entry recipe there.
- A model request costs about as much as a login page's (about $0.007), and only the
  first switch on a site makes one to three. It counts against the same daily and
  monthly limits as recipe generation. The prompt names no site.

### Picks that are not made the default

A pick with "Make default" off, in the ADR 0021 B choice or in a switch, is used for its
registrable site until the browser closes, separately for incognito, in
`pateat.login-session-picks.v1` in `chrome.storage.session` (at most 200 sites).
Automatic logins and the passkey item choice use it before the site default. It is
dropped when the site's saved defaults change, for example by "Use as default". Before,
such a pick lasted one login; with ADR 0062 the next automatic login after an expiry or
logout would otherwise return to the default account without the person noticing. "Make
default" on saves the default after a confirmed sign-in, as
[ADR 0021](0021-account-choice-outside-settings.md) already does.

## Considered alternatives

- Clear the site's cookies and storage with `chrome.browsingData.remove` (`origins`):
  needs no logout control, but adds the `browsingData` permission, clears cookies for
  the whole registrable domain including "remember this device", which makes banks ask
  for a device check again, signs out every account of the site and leaves the
  server-side session alive.
- Find the logout control with the fixed words of the former logout-click detection:
  no model call, but it misses controls inside menus and words in other languages, as
  ADR 0031 found for entry links.
- Ask the [ADR 0029](0029-local-sign-in-state.md) judge for the logout control: it runs
  only for some logins, so most sites would still need the request above.
- A pick that lasts one login, as before.

## Consequences

- A menu item without a link (`role=menuitem` with no `href`) or a menu button with no
  text or ID is not described to the model, so such a menu cannot be learned.
- A stored logout recipe whose control is gone fails the switch with `target-missing`.
- The first switch on a site spends one to three model requests.
- A switch on a site whose logout passes through another site that Pateat reads, or
  whose logout control is inside a closed shadow root or a cross-origin frame, fails
  with a message in the popup.
