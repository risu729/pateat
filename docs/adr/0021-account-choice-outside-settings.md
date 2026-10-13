# ADR 0021: Choosing an account outside the settings page

Status: accepted by the owner on 2026-10-11 (10:56 UTC). Amends
[ADR 0007](0007-existing-passkey-assertions.md) (item selection and the rejected
chooser alternative) and [ADR 0013](0013-service-held-recipes-and-settings.md) (where
account defaults and exclusions are edited, and manual choices before they are saved).
Each part lands in its own PR. All four parts, A to D, are implemented. Amended on
2026-10-12 by [ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge):
in D, a watched login is released like a finished one when its first step shows in a new
page of its tab or of another tab of the site (implemented). Amended on 2026-10-13 by
ADR 0027 (owner's 「このタブだけ」): a watched login is no longer released as a logout;
only its own tab asks (implemented, see the end of D).

Amended on 2026-10-11 by [ADR 0023](0023-synced-vault-policy.md): the popup also repairs
a binding that names a missing custom field (not implemented yet). Amended on 2026-10-11
by [ADR 0027](0027-per-account-login-routes.md): a passkey request during a login that
has not ended uses that login's item instead of the chooser (implemented). Amended on
2026-10-12: in B, the open popup keeps asking until a choice waits, and closes once a
picked login starts (closing is the owner's suggestion). Observed on 2026-10-12 in the
owner's Chrome on github.com with three matching items: the first popup open showed no
choice although the badge read "3"; reopening showed it. Most likely cause, reproduced
in a synthetic test: opening the popup restarts the worker, and when the tab is reached
by its reconnect of every tab (a persisted attempt in the tab, or an origin with one),
that reconnect announces the page again while the popup's own reconnect is admitted; the
popup's answer comes back stale, so it sees no choice. The popup's question now also
waits for the newer announcement, and a choice whose page can no longer be admitted
ends. Also observed in a recheck that day: the choice first named the items by a
shortened item ID, and after Log in it vanished without a login because another tab's
unfinished GitHub login held the site
([ADR 0022](0022-login-attempts-per-tab-and-origin.md)). The choice now shows only once
the site's matches name each account by its username, and while another tab's login
holds the site it says so, disables Log in and stays for a pick once that hold ends.
Amended on 2026-10-13 by [ADR 0036](0036-passkey-after-the-identifier.md): fill only (D)
also fills the identifier for an item without a password that may go on to a passkey
after it, and presses nothing (implemented). Amended on 2026-10-13: in A, while the
tab's page waits for a choice the popup lists only the choice's candidates, since
listing the site default's candidates below them showed each account twice (the owner
asked for one list at 03:54 UTC). The saved default is marked in that list and can still
be removed there; choosing a default without logging in waits until the page no longer
waits, or uses the settings page (implemented).

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
candidates the executor accepts for that document. While open, the popup asks again
every second until a choice waits, so a choice that starts waiting late, for example
after a restarted service worker asked the page to announce again, still appears; until
the first answer it says it is checking (amended 2026-10-12). The list shows once the
site's matches are known, so each candidate is named by its username from the first time
it shows; the popup asks at open and caches no usernames, since vault field values are
not kept. While another tab's login holds the site (ADR 0022), the list says so and Log
in is disabled; the popup keeps asking and enables it once the hold ends. A pick refused
because such a hold started meanwhile keeps the choice for a later pick.

Choosing one stores the choice in `chrome.storage.session` for that `documentId` and
sends `login.reconnect` to that document only. Once that starts the login, the popup
closes (owner's suggestion, 2026-10-12). The page announces itself again and a new
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
request is delegated with `settings-changed` (or `vault-incomplete` when the vault could
not be searched in full). A lookup or signing after a choice that fails is tried once
more.

### D. After a logout, choose again (detection L1)

Once a Pateat login in a tab has finished, the next appearance of a recipe's first step
for the same origin in that same tab counts as a logout. "Finished" includes
`authenticated`, `credential-rejected` and `wrong-account`, and since
[ADR 0022](0022-login-attempts-per-tab-and-origin.md) `left-origin` and `interrupted`.
An unknown outcome is not finished (corrected on 2026-10-12: this sentence listed it,
while the paragraph below and the code never did). Since
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge) (owner,
2026-10-12 13:08 UTC), a top-level `password` login that ends `challenge` or settles as
unknown is watched for 10 minutes, and during the watch the first step showing in a new
page of the tab, or of another tab of the site, releases it the same way as a logout
here, `login.logout` marked `watched`. Such a release in another tab is the exception to
the rule below that only a tab's own record is released: a watched login is never
submitted again by itself, and the page there is filled without pressing anything.
On that appearance Pateat does not log in automatically. It asks for an account as in B,
with the default listed first.

Only that tab's own finished attempt record is released. Another tab's attempt for the
origin that still holds it under [ADR 0022](0022-login-attempts-per-tab-and-origin.md)
(running, or ended without success in a way that still holds, such as a refused
password) blocks with `origin-busy`, because cookies are shared across tabs; that tab's
tooltip says why. While the tab asks, other tabs of the origin that show a recipe's
first step ask too (amended 2026-10-11; before, they were refused `origin-busy`), so
they do not log in again behind the logout. Their tooltip says the logout happened in
another tab. A result Pateat could not observe stays `reconciling` and is resumed by the
next page, not taken as a logout, except as the watch above releases it. The runtime and
the content script must keep watching after a finished attempt, including after an
in-document (SPA) logout.

Amended 2026-10-12 by the owner: after a logout Pateat fills the login form but never
presses anything. When the tab would ask as above and one account is to be used, the
usable saved default or, without a saved default, the only URI match, Pateat runs the
chosen password route's steps up to, not including, the first step with an effect: no
click (advance or submit) and no fill whose event may advance or submit. So every
leading field of the page is filled (on Vpass the ID and the password); on a site whose
email page is followed by a password page, only the email is filled. When the fill ends,
the tab asks as above: the badge and popup list the accounts, and a pick there logs in
with its button as before. The fill's record is then forgotten; while it runs it does
not hold the site for other tabs, and it never counts as a login of the tab. The logout
state is kept, so the next logout is detected again. A document is filled once, also
across a worker restart (filled documents are kept in `pateat.login-logout-fills.v1` in
`chrome.storage.session` until their tab closes): a re-render or a re-announcement of
the same document only asks, so Pateat never overwrites what the user typed, while a
reload fills again. Nothing is filled when several accounts match without a saved
default, when the saved default cannot be used, when the passkey route is chosen, or
while another tab's login holds the site. The attempt record carries `fillOnly`, and the
attempt contract refuses to issue or authorize a step with an effect for it, so a
restarted worker cannot click. The recipe's account switch is never clicked either: when
the page shows another account, the fill ends and the tab asks. The log shows such a
login as `login.attempt` with reason `fill-only`, then the asking as `login.refused`
`logged-out` with the tab that logged out.

Amended 2026-10-12 by the owner (07:41 UTC, after a decision card): a tab whose login of
the origin stopped (`blocked`) after it submitted something, other than an account
switch, is no longer stuck. Evidence: on APA Hotel a login stopped `policy-changed`
after its click; every later page of the tab resumed that ended record, and after a
worker restart the recipe's newer revision was refused `recipe-not-found`, so the tab
never logged in again until it closed. Now a later top-level document of that origin in
the tab (another document than the one the record belongs to) watches the recipes' first
steps; when one shows, the record is released and the tab asks as after a logout, and
with one account to use it fills without pressing anything, as above. Only that tab (its
page and that origin's frames in it) asks: `pateat.login-stopped-asks.v1` in
`chrome.storage.session` keeps it until a login that is not fill-only starts for that
origin in the tab, or the tab closes; other tabs of the site keep logging in. Pateat
never submits again from that tab by itself, so ADR 0022's reason for resuming such
records still holds. While the record still holds the site against other tabs (ADR 0022,
5 minutes after it last changed), it is resumed as before, so the hold is not cut short;
a page loaded during the hold asks only once the tab loads a new page after it.
A record stopped before any submission is released as ADR 0022 describes; one still
`reconciling` (its result not known yet) is resumed as before. The log shows the
watching page as `login.refused` `not-started` with `stopped-login` and the asking as
`logged-out` with `stopped-login`.

Constraint, set by the owner on 2026-10-12 (07:41 UTC): beyond the cases above, where
this tab's own Pateat login of the site is known, a site session that only expired must
never make the user press the site's button. Pateat cannot tell an expiry from a logout
it did not see, and timing does not help: some banks end the session as soon as a page
is opened out of their expected order (owner, 07:42 UTC). So a tab treats a login form
as a logout only after this tab's own login (finished, or stopped after a submission as
above) or while another tab of the site asks after its logout. A session
carried over from a login in another tab, or from an earlier browser session, is
therefore not detected: after a logout there, Pateat logs in again automatically.
Rejected for this reason: counting a signed-in marker seen in the tab (it would make
every expiry after such a page ask), and counting another tab's finished login (also
against ADR 0022's choice that a new tab logs in).

Amended 2026-10-13 by the owner (04:30 UTC, decision card asking whether a sign-in page
shown again after a confirmation page timed out also makes the site's other tabs only
fill; answer 「このタブだけ」, this tab only): the first step showing again while a
login is watched under
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge) is no logout,
since that login never signed in. Evidence: on Oracle Cloud (2026-10-13 03:59 UTC) a
challenge page timed out and the site went back to its sign-in page with no action from
the person; on Sony Bank (04:16 UTC) a password login whose result settled as unknown
saw its sign-in page again, was logged `login.logout` `watched`, and every other tab of
the site then only filled. Now such a login ends `challenge-abandoned` (from a
`challenge`) or `watch-abandoned` (from a result settled as unknown), and only the
watched login's tab asks and fills without pressing anything, as after a stopped login
above (`pateat.login-stopped-asks.v1`, `logged-out` with `stopped-login`). The site's
other tabs and new tabs log in as before, which may show the challenge again there. The
same holds when the first step shows in another tab first: that tab logs in, and the
watched tab asks if its own first step shows again. `login.logout` and
`pateat.login-logouts.v1` are left for a logout after a finished login, as above.

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

The owner added on 2026-10-12 (19:19 UTC), after ABEMA: when this is built, it also
switches a site where Pateat has not logged in, such as a site that created an account
for the visitor when it was first opened and signs in by switching that account. The
switch starts only from the person's choice in the popup; Pateat still never switches
such an account on its own ([plan](../plan.md#phase-4-issues-and-work-as-needed)).

The owner also asked on 2026-10-11 (17:05 UTC) to record, not build, a toolbar badge
that counts the matching items on every HTTPS site with at least one match, not only
while a login waits for a choice (part B). The owner expects it to help two later
features: the automatic account switching above, by showing whether there is another
account to switch to, and replacing the official Bitwarden extension, whose own badge
counts matching logins. Until then the badge shows only while a login waits for a
choice. Building it would:

- reverse the rule in [ADR 0009](0009-install-time-https-site-access.md) and
  [ADR 0016](0016-recipe-generation-trigger.md) that a page without a recipe gets no
  vault access; the vault would match URIs locally on almost every HTTPS page, since the
  vault is normally unlocked ([ADR 0006](0006-atomic-local-vault-cache.md));
- run each count through the login runtime's serialized vault path, because a vault
  session's worker takes one job at a time and a concurrent lookup can make a login
  refuse with `vault-unavailable`;
- show the waiting state in another color, because the site's count (origin-level, with
  passkeys and static items) and the waiting count (the document's URI matches) can
  differ;
- show no number when a vault could not be checked.

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
