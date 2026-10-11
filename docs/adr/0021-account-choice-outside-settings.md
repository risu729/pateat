# ADR 0021: Choosing an account outside the settings page

Status: accepted by the owner on 2026-10-11 (10:56 UTC). Amends
[ADR 0007](0007-existing-passkey-assertions.md) (item selection and the rejected
chooser alternative) and [ADR 0013](0013-service-held-recipes-and-settings.md) (where
account defaults and exclusions are edited, and manual choices before they are saved).
Each part lands in its own PR. All four parts, A to D, are implemented.
Amended on 2026-10-11 by [ADR 0023](0023-synced-vault-policy.md): the popup also repairs
a binding that names a missing custom field (not implemented yet).
Amended on 2026-10-11 by [ADR 0027](0027-per-account-login-routes.md): a passkey request
during a login that has not ended uses that login's item instead of the chooser
(implemented).

Date: 2026-10-11

## Context

When several vault items match a site, Pateat stops instead of guessing. A password
login refuses with `account-ambiguous`; a passkey request with several matching
credentials is handed back to the browser (`ambiguous-credential`), where Bitwarden, if
installed, shows its own window. The only way to choose was the settings page's "Site
default accounts" list. On 2026-10-11 the owner added a default for a real site there.
The default was never saved, so the next passkey request was delegated again. That page
now saves each change at once (#160), but choosing still means leaving the site.

AI browser agents ("Chrome use") operate the page. They cannot operate extension pages
or extension windows, and an extension window takes focus. The existing rules kept page
UI out of the login flow for this reason ([architecture](../architecture.md),
"Background execution").

Once Pateat has logged in on a tab, it never logs in there again until the tab is
closed, and other tabs on the same origin are refused with `origin-busy`. A user who
logs out to switch accounts therefore has to log in by hand.

## Decision

Each part keeps the existing scope checks. The login still runs only on a recorded
document whose site and account the policy allows. No new extension permission is added.

### A. Toolbar popup for the current site

Clicking the toolbar icon opens `popup.html` instead of the settings page. The settings
page stays reachable from a link. For the tab's site the popup shows:

- the site default account, chosen from the same candidates as the settings page;
- whether the site is excluded.

Changes are saved through the same worker-owned settings store and sync like
settings-page edits. The popup edits nothing else.

### B. Several password candidates

The page shows nothing. The background records the refused document as
`{tabId, frameId, documentId, origin}`. That tab's icon gets a badge with the candidate
count and a tooltip asking the user to choose. Opening the popup lists only the
candidates the executor accepts for that document.

Choosing one stores the choice in `chrome.storage.session` for that `documentId` and
sends `login.reconnect` to that document only. The page announces itself again and a new
attempt starts from the recipe's first step on the same page, with no reload. Text the
user typed is overwritten. If the form has moved past its first step, nothing runs and
the popup says so. The choice then applies to the login it started, including its later
pages; a choice that starts nothing is dropped, and the form's next appearance asks
again. The waiting choice is also kept in `chrome.storage.session`, so it survives a
service-worker restart like the badge does.

The choice becomes the site default only after the outcome is `authenticated`, through
the existing automatic-choice save. A "make default" checkbox is on by default and off
in incognito. With it off, the choice is used for this one login only.

A single match whose account is connected more than once is not offered as a choice; the
popup points to the settings page instead.

### C. Several passkey candidates

Pateat opens its own chooser window (`chrome.windows.create`, `passkey-picker.html`).
This applies only when several credentials match and no site default is among them. It
lists item name, passkey `userName` and connection, with a "make default" checkbox and a
"use the browser / Bitwarden" button. Closing the window or pressing that button
delegates as before.

The owner accepted that a Chrome-use agent cannot operate this window. It cannot operate
Bitwarden's window either, which appears in the same case today. A choice made in
Pateat's window can become the default, so later requests need no window.

Timeouts change only while the window is open. Today the page delegates after 15 s and
the background stops after 10 s; while the window is open both wait. The bridge relays
the request's `timeout`. The wait ends at that timeout or at Pateat's 2-minute limit,
whichever is shorter (WebAuthn recommends 2 to 5 minutes). The window closes when:

- the request is cancelled or aborted;
- the page navigates or the tab closes;
- settings change (`cancelAll`). Superseded below: the window stays open, and the
  choice is checked against the new settings.

The worker is kept alive while the window waits. The default is saved only after the
assertion has been returned, because a settings save cancels pending passkey requests.
In incognito no window opens and the request is delegated as before.

As implemented: the page learns nothing new while it waits. The isolated relay repeats
its existing acknowledgement every 5 s while the background works, and the page's 15 s
limit counts from the latest one, under an absolute limit of 2 minutes 15 s. A `timeout`
below 10 s is raised to 10 s, as Chrome raises it for its own UI. The window opens only
for a visible, focused, active document with at least 5 s of that wait left, and
signing after a choice gets its own 10 s. One window is open at a time; a second request
delegates. Leaving the page cancels its pending requests. "Use the browser" or closing
the window delegates only after the window has closed and the tab's window has been
focused again (each step waits at most 2 s), so the browser's own prompt has focus. When
the origin already has a default that holds none of the matching passkeys, the
checkbox starts unticked and says it replaces that default, because the same default
also picks the password login account. The default is not saved while a password login
is running, as for an automatic account choice.

Changed by the owner on 2026-10-11 (17:03 UTC), after the check in installed Chrome:
when the wait ends with the window still open, Pateat closes it and the request fails
with `NotAllowedError`, as Chrome's own prompt does when it times out. The browser and
Bitwarden are not asked instead, so no second prompt appears by itself.

Changed on 2026-10-11 by Claude as a fix, after the same check found a settings sync
from the service closing the window: a settings change no longer cancels a request
once its window has opened. It still cancels requests that never opened one. After a
choice, the chosen passkey is looked up again under the settings current then, since
they may have changed meanwhile, and is used only if they still offer it; otherwise the
request is delegated with `settings-changed`. A failed lookup or signing after a choice
is tried once more.

### D. After a logout, choose again (detection L1)

Once a Pateat login in a tab has finished, the next appearance of a recipe's first step
for the same origin in that same tab counts as a logout. "Finished" includes
`authenticated`, `credential-rejected`, `wrong-account` and unknown outcomes, and since
[ADR 0022](0022-login-attempts-per-tab-and-origin.md) `left-origin` and `interrupted`.
On that appearance Pateat does not log in automatically. It asks for an account as in B,
with the default listed first.

Only that tab's own finished attempt record is released. Another tab holding an attempt
for the origin still blocks with `origin-busy`, because cookies are shared across tabs;
that tab's tooltip says why. For the same reason, while the tab asks, other tabs of the
origin are refused `origin-busy` too, so they cannot log in again behind the logout.
A result Pateat could not observe stays `reconciling` and is resumed by the next page,
not taken as a logout. The runtime and the content script must keep watching after
a finished attempt, including after an in-document (SPA) logout.

Known gaps:

- Frame logins are not detected (ADR 0017).
- Sites that show only a password step after logout are not detected, because no
  recipe's first step appears.
- A login form that stays in the page after login, or a re-authentication form shaped
  like the first step, can ask for a choice while still logged in.

For passkeys, an attempt record does not exist. After Pateat signs for an RP ID in a
tab, a later username-less request (no allow list) for that RP ID in the same tab opens
the chooser window of C. This happens even with a single match or a default. A request
that names credentials, such as a re-authentication while signed in, still signs
silently.

As implemented for passkeys: the RP IDs Pateat returned an assertion for are kept per
tab in `chrome.storage.session` (`pateat.passkey-signed.v1`, at most 8 per tab and 256
tabs), so they survive a worker restart, and a tab's entry goes when the tab closes. A
navigation in the tab keeps it, since a logout often navigates. The window lists the
site default first, marked as such, and says that Pateat signed in from this tab before.
The checkbox starts unticked, because switching accounts may be a one-off, and it is
hidden when every listed passkey is the site default, since choosing the default saves
nothing. When the window cannot open (the
same cases as C) or a connection or item could not be searched, the request goes to
the browser instead of being signed unasked.

## Considered alternatives

- An in-page card in an extension-origin iframe: needs the no-page-UI rule changed, can
  be overlaid by the page, and agents cannot operate it either.
- Opening a window for password logins: blocks Chrome use where badge and popup do not.
- Keeping passkey delegation and only badging for next time: Bitwarden's window still
  blocks agents, and the choice could not be saved on the spot.
- A per-tab "next login uses this account" selector: dropped by the owner in favour of
  choosing after logout.
- Other logout detection:
  - logout locators in recipes: needs recipe-format and generation changes per site;
  - watching clicks on "log out" text: misses and false positives;
  - watching cookie removal: new `cookies` permission;
  - watching logout requests: new `webRequest` permission.

## Later

The owner asked on 2026-10-11 to record, not build, a follow-up. Choosing another
account in the popup while logged in would log out and log in again automatically. This
is the "automatic logout/re-login" operation that the [plan](../plan.md) keeps for
later. It needs per-site logout steps and shared-session/race tests.

## Consequences

- The [architecture](../architecture.md) now allows:
  - the toolbar popup as a third place to edit two settings;
  - a popup choice to restart one recorded, refused document;
  - the passkey chooser window.
- One-time account choices (B with "make default" off) and re-login after logout (D)
  move from later to initial scope. They need tests that cover several tabs on one
  origin.
- ADR 0007's item selection now ends with a chooser instead of delegation. Its rejected
  alternative "Show a Pateat chooser" is reversed for this window.
