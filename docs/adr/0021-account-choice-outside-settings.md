# ADR 0021: Choosing an account outside the settings page

Status: accepted by the owner on 2026-10-11 (10:56 UTC). Amends
[ADR 0007](0007-existing-passkey-assertions.md) (item selection and the rejected
chooser alternative) and [ADR 0013](0013-service-held-recipes-and-settings.md) (where
account defaults and exclusions are edited, and manual choices before they are saved).
Not implemented yet; each part below lands in its own PR.

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
the popup says so.

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
- settings change (`cancelAll`).

The worker is kept alive while the window waits. The default is saved only after the
assertion has been returned, because a settings save cancels pending passkey requests.
In incognito no window opens and the request is delegated as before.

### D. After a logout, choose again (detection L1)

Once a Pateat login in a tab has finished, the next appearance of a recipe's first step
for the same origin in that same tab counts as a logout. "Finished" includes
`authenticated`, `credential-rejected`, `wrong-account` and unknown outcomes. On that
appearance Pateat does not log in automatically. It asks for an account as in B, with
the default listed first.

Only that tab's own finished attempt record is released. Another tab holding an attempt
for the origin still blocks with `origin-busy`, because cookies are shared across tabs;
that tab's tooltip says why. The runtime and the content script must keep watching after
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
