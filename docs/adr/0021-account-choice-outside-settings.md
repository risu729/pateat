# ADR 0021: Choosing an account outside the settings page

Status: accepted by the owner on 2026-10-11 (10:56 UTC). Amends
[ADR 0007](0007-existing-passkey-assertions.md) (item selection and the rejected chooser
alternative) and [ADR 0013](0013-service-held-recipes-and-settings.md) (where account
defaults and exclusions are edited, and manual choices before they are saved). Each part
lands in its own PR. All four parts, A to D, are implemented. Amended on 2026-10-12 by
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge): in D, a watched
login is released like a finished one when its first step shows in a new page of its tab
or of another tab of the site (implemented). Amended on 2026-10-13 by ADR 0027 (owner's
「このタブだけ」): a watched login is no longer released as a logout; only its own tab
asks (implemented, see the end of D). Amended on 2026-10-13 by the owner's
[site count badge](#site-count-badge) decision (part B, implemented on 2026-10-23).
Amended on 2026-10-16 by the owner: in D, a click on a control that logs out also makes
the tab ask (implemented, see [logout clicks](#logout-clicks)).

Amended on 2026-10-23 by [ADR 0062](0062-log-in-again-after-a-logout.md) and
[ADR 0063](0063-switch-accounts-from-the-popup.md) (owner, accepted and implemented):
D's logout state, fill-only login after a logout, logout clicks and passkey chooser
after a sign-in are removed, so a logout is followed by an ordinary login; its
rejected-password, stopped-login and abandoned-watch asks stay and still fill the page
once without pressing; [Later](#later)'s account switch is built, and a pick not made
the default makes the site ask every time until the browser closes or a default is set.
An exclusion rule now pauses automatic login instead of turning Pateat off: the popup
lists the accounts and offers a choice there, and its "Pateat on this site" switch is
replaced by the pause row.

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
waits, or uses the settings page (implemented). Amended on 2026-10-13 after the owner's
report from github.com (three matching items, the picked one's stored email stale):
after GitHub's "Incorrect username or password" page the popup offered no account, so
another one could not be tried. The log (build fdf57ef) showed the page at `/session`,
the path the form posted to, read as the sign-in form shown again (`reshown`, S1 and S2)
with no failure mark, so the login settled `unknown-submit` and was watched (ADR 0027);
no recipe starts on that path, so the watch never released it and the tab never asked.
Now in D, a login asks at once, as after a logout, in the page where the sign-in form
showed again in the first new document after the password submission with its password
input and no other sign (no code input, CAPTCHA, passkey request or sign of a sign-in),
also when the result there stays unknown, also after the submitted page settled first,
and in the page a `credential-rejected` result was read in, on any path. When the
submitted page settled first and the form shows again on a path where a recipe starts,
the watch ends `watch-abandoned` first (below): only that tab asks, as after a stopped
login, and fills its page without pressing. That page is
never filled again, because the site just refused what was filled there; nothing is
submitted by itself. Like any sign-in page without a recipe it may be sent for one, and
its accounts are offered once a recipe's first step is ready there. The record is
released as after a logout, so the site's other tabs ask too (and fill without pressing)
instead of waiting out the 5-minute hold of ADR 0022 and then submitting the same
account again; the owner confirmed this on 2026-10-13 (06:33 UTC, decision card
answer 「他のタブも聞く」, other tabs ask too) over asking in this tab only as for an
abandoned watch below, so a refused password is not sent again from another tab. A
document whose login ended with a rejection takes the form still
showing as shown again, and a new login in the same document, as after a pick there,
watches for its own end. The badge, popup and log name the rejection instead of a logout
(`pateat.login-rejected-asks.v1`, `login.logout` marked `rejected`, `logged-out` with
`rejected`). A pick marked "make default" is still saved only after `authenticated`, so
a rejected pick is not kept as the default (part B) (implemented).

In the tab whose login the site rejected, the popup's list has no account chosen, and
Log in stays disabled until the user picks one, so a single press there never sends the
rejected account again; the "make default" box keeps its usual state. The owner chose
this on 2026-10-13 (13:54 UTC, decision card answer 「何も選ばない」) over choosing the
first other account or also clearing the box (implemented). The site's other tabs
that offer a choice while the rejected tab still asks choose no account either (the
popup's answer carries `rejectedElsewhere`); the owner chose this on 2026-10-13
(14:43 UTC, decision card answer 「他のタブもそろえる」) over leaving them on the first
account (implemented).

Amended on 2026-10-14 by
[ADR 0029](0029-local-sign-in-state.md#amendment-unconfirmed-completion-2026-10-14):
only confirmed completion counts as a successful sign-in (implemented); see the dated
amendment below.

Amended on 2026-10-18 by [ADR 0049](0049-start-at-a-later-step.md) (owner, 01:40 UTC,
implemented): in D, a later step a login may start at counts as the first step does,
and a fill-only login after a logout starts at it; this closes the known gap for sites
that show only a password step after a logout.

Amended on 2026-10-19 by [ADR 0052](0052-immediate-ui-stored-passkeys.md) (owner, 20:48
UTC, implemented): C and D apply to Chrome Immediate UI requests (`uiMode: "immediate"`)
as to other passkey get requests.

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

Replaced on 2026-10-23 by [ADR 0062](0062-log-in-again-after-a-logout.md): only the
rejected-password, stopped-login and abandoned-watch asks below remain, each still
filling the page once without pressing. The text below records the rule as built until
then.

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

Implementation detail, not confirmed by the owner (2026-10-21,
[#831](https://github.com/risu729/pateat/issues/831)): a document is filled once on
each path, so a start on another path of the same document, as the password step
a single-page app shows in place of its email step
([ADR 0049](0049-start-at-a-later-step.md)), is filled once too; a document whose page
the site rejected a login on is still never filled again.

A tab is known by its Chrome tab ID. When Chrome's Memory Saver discards an idle tab,
the tab gets a new ID (seen on Wise on 2026-10-13: the restored tab that logged out was
then told it had logged out in another tab). Chrome reports the change with
`tabs.onReplaced`, which may also start a stopped worker. The tab's logout state, its
login records, its sign-in entry press, a pick that started its login and its passkey
sign-ins then move to the new ID; the page that went away is forgotten as on a close, so
the restored page asks as the tab that logged out. When a tab that asks after a logout
closes, its logout state goes with it, and unless another tab of the site logged out
too, the site's other tabs that asked only because of it log in again; the log shows
`login.ask-ended`
([ADR 0019](0019-local-diagnostics-and-logs.md#amendment-2026-10-19-tab-numbers-and-closed-tabs-that-asked)).

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
therefore not detected by the form alone: after a logout there, Pateat logs in again
automatically, unless the logout was a click [counted since 2026-10-16](#logout-clicks).
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
other tabs and new tabs log in as before, which may show the challenge again there.
Since 2026-10-23 (owner) only the watched tab's own first step ends the watch; until it
ends, the site's other tabs that share its cookies are refused `origin-busy`
([ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)). A logout or a
rejection in a tab of an incognito window makes no tab outside such windows ask, nor the
other way around, since they keep separate cookies. `login.logout` and
`pateat.login-logouts.v1` are left for a logout after a finished login, and for a
rejection, as above.

Known gaps:

- Frame logins are not detected (ADR 0017).
- Sites that show only a password step after logout are not detected, because no
  recipe's first step appears. (Closed on 2026-10-18 by
  [ADR 0049](0049-start-at-a-later-step.md): such a step counts as the first step does.)
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

#### Logout clicks

Amended 2026-10-16 by the owner (14:06 UTC, decision card answer 「B: 語のクリック」,
then 「表示テキスト以外、ariaとかも見て」「後周りのテキストとか。他と同様です」: read
ARIA names and the text around a control as other page reading does). Evidence: on
dash.cloudflare.com the owner logged out of a session that no Pateat login in that tab
had started, and Pateat logged in again with the site default. A click on a control that
logs out now counts as a logout of that tab's site, so the case above is detected when
the person logs out by hand. An expired session still logs in by itself, since nobody
clicked, so the constraint holds; the tab asks wrongly only when the session also
expires within 10 minutes after such a click.

- The content script listens for clicks on the window in the capture phase, so the click
  is read before most of the page's handlers act on it, and reads the nearest control
  around the clicked element (a button, a link, an element with a control role or a
  `tabindex` of 0 or more, or the element that sets `cursor: pointer`), also inside an
  open shadow root. A field, a `<label>` or a control that sets a state (a checkbox,
  switch, radio button or slider), or a click inside one, never counts: its words
  describe a setting, as "Log out when I close the browser" does. Only trusted clicks
  count: a page's own script that clicks for an expired session is not a person's
  logout.
- The control's name is read in the order an accessible name is computed and the
  observation names a control (ADR 0037): the first of the text its `aria-labelledby`
  names, its `aria-label`, its rendered text (an input button's `value` or `alt`) and
  its `title`. Only a control with none of them is named by the elements inside it (an
  image's `alt`, an SVG `<title>`, an `aria-label` or a `title`, as an icon's) and the
  text its `aria-describedby` names, so a session timeout's "Stay signed in" button
  described by a warning that it will log out does not count. A control that names
  nothing even so is named by the nearest text before or after it, at most three levels
  up, never across another control or out of a form. A name longer than 64 characters
  does not count, and a control whose name or rendered text is that long counts as
  named, so nothing else is read for it, as for a container of several controls.
- A name counts when it holds "log out", "logout", "sign out", "log off" or "sign off"
  as whole words in English, or ログアウト, サインアウト, ログオフ or サインオフ
  anywhere, after NFKC normalisation. A name that logs other devices, sessions or
  accounts out does not count: "other", "others" or "another" followed within three
  words by a device, session, browser, computer, phone, place or location ("Sign out of
  all other active web sessions"), "other" or "others" followed within three words by an
  account ("Log out of other accounts"), "except this", "but this" or "everywhere else",
  or 他の, ほかの or 別の before 端末, デバイス, セッション, ブラウザ, 場所 or 機器 with
  at most eight characters between, 他の or ほかの before アカウント the same way,
  他端末, or 以外 (「このデバイス以外からログアウト」). "Sign out and use another
  account" and 「ログアウトして別のアカウントでログイン」 log this session out, so they
  count. Only these fixed words count, never a site name (ADR 0033).
- Only on a page of an origin with recipes, and only the fact that such a control was
  clicked goes to the worker, never its text, the page's URL or a locator (ADR 0019).
- The worker keeps the click by tab and registrable site, so the first step may show on
  another origin with recipes of the site (`www.` and `accounts.`), in memory and in
  `pateat.login-logout-clicks.v1` in `chrome.storage.session` (the 256 newest), and a
  page of the tab announced after the click waits until it is kept. It is forgotten
  when the tab closes, moves with a tab Chrome replaced, and stops waiting when the
  tab's page shows another site, after 10 minutes (as a watch of ADR 0027), or when it
  is used.
- When a recipe's first step then shows in that tab's page (not a frame) on that site,
  and the tab has no login record of the origin, it is used as this tab's logout: the
  tab asks, fills only when one account is to be used, and the site's other tabs ask
  too, as above. The log shows `login.logout` marked `clicked`; when the tab's own
  finished login is released there at the same time, that logout alone is logged.
  Logging out to the top page and pressing the site's own sign-in link later within the
  10 minutes is caught the same way.
- While a click waits, the tab presses no sign-in entry of the site (ADR 0031,
  `logout-clicked`). A username-less passkey request for an RP ID of the site in the tab
  opens the chooser as after Pateat signed there, saying "You logged out of this site in
  this tab" (`passkey.request` marked `logoutClicked`), while the click waits and, once
  used, while the tab keeps a logout state for an origin of the site, so a "Sign in with
  a passkey" press on the sign-in page asks too.
- No permission is added: the login content script already runs on every HTTPS page (and
  HTTP page since [ADR 0050](0050-http-pages-for-http-items.md)).
- Also counted, by the words alone: a link or button whose name holds them without
  logging out, such as "Auto sign out settings", "Logout history" or "How do I log
  out?". Such a click only makes the tab ask when the site's first step shows in it
  within 10 minutes, and keeps sign-in entries unpressed and passkey requests asking
  meanwhile.
- Still missed, so Pateat logs in again: a control with no name and no text beside it, a
  control in a closed shadow root or a cross-origin frame of another site, a control on
  an origin without recipes (its page does not send the click), a logout that passes
  through a page of another site that Pateat reads (the tab left the site), a logout in
  another tab or on another site (such as an identity provider), a logout link inside a
  `<label>` or an editable region, a keyboard shortcut that logs out without a click,
  words in languages other than English and Japanese, and a first step that shows more
  than 10 minutes later.

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
  - watching clicks on "log out" text: misses and false positives (rejected on
    2026-10-11; adopted on 2026-10-16 for sessions the tab's own login did not start,
    see [logout clicks](#logout-clicks));
  - watching cookie removal: new `cookies` permission;
  - watching logout requests: new `webRequest` permission.

## Later

Built on 2026-10-23 by [ADR 0063](0063-switch-accounts-from-the-popup.md).

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
that counts the matching items on every HTTPS site (HTTP too since
[ADR 0050](0050-http-pages-for-http-items.md), with its `http://` rule) with at least
one match, not only while a login waits for a choice (part B). The owner expects it to
help two later features: the automatic account switching above, by showing whether there
is another account to switch to, and replacing the official Bitwarden extension, whose
own badge counts matching logins.

### Site count badge

Status: decided by the owner on 2026-10-13 (14:42 UTC, every recommendation of the
reviewed proposal), for [phase 2](../plan.md#phase-2-use-it-and-fix-what-comes-up).
Implemented on 2026-10-23 ([details](#site-count-implementation)).
[ADR 0038](0038-login-status-badge.md) (2026-10-13 19:28 UTC) already gives the waiting
choice its amber colour and puts a model request's spin and the last login's result
above the count; a brief result goes back to the count. The owner asked at 14:06 UTC for
the badge to always say whether a site has no saved item, items that are all excluded,
or usable items, and at 14:06 UTC for a gray number when all are excluded.

Each write sets the badge text, background, text colour and title for one tab:

| State                                  | Badge                           | Colours (background / text)        |
| -------------------------------------- | ------------------------------- | ---------------------------------- |
| Not HTTP(S), or no matching item       | none                            |                                    |
| At least one usable item               | the usable count, e.g. `2`      | teal `#115e59` / white             |
| Matching items, none usable            | the matching count, e.g. `3`    | light gray `#cbd5e1` / `#1e293b`   |
| A login waits for a choice             | the candidates, e.g. `2`        | amber `#8a5a00` / white            |
| A vault could not be checked           | none                            |                                    |

Counts above 99 show `99+`. When some matching items are excluded, the badge still
shows only the usable count and the title adds how many more are excluded. The gray
state's title names the reason: the site is excluded, the items are excluded in
settings, or they wait for a custom-field review. A waiting choice wins over the count,
and ending the choice shows the count again. The not-checked titles say why: the vault
is locked, has not been opened since Pateat restarted, could not be read, or is being
updated. The owner kept the gray lock-state icon as the only lock display (14:50 UTC),
with no lock badge.

The owner's choices:

1. The count covers the tab's origin, so it equals the popup's list.
2. Excluded sites are counted, in gray. This reverses the rule that an excluded site
   never reaches vault matching.
3. Disabled connections are not matched.
4. The waiting choice is amber.
5. When any enabled connection could not be checked, no number shows.
6. A count never opens a vault: when a connection's vault is not open in the service
   worker, or its snapshot is not the stored record's accepted one, the tab shows
   not checked. A count's restore could make the next login's restore fail with
   `resource-limit` and refuse with `vault-unavailable`. So after a restart, new
   origins show no number until a login or the popup opens the vault.
7. An item with an empty password and no passkey counts as usable, as the choice
   candidates treat it.

A matching item is a login, in an enabled connection, whose URI rule matches the
origin, or an item holding a passkey for one of the origin's RP IDs. It is usable when
the site is not excluded, the item is eligible under the connection's settings and it
is not quarantined. An item whose URI rule cannot be evaluated is left out of the count
and noted in the title.

A count runs through the login runtime's vault path, one at a time, inside the same
vault-replacement hold an admission takes, and only while no attempt runs and no
admission is pending; it checks again before each crypto job. Worker starts, tab
activation and finished loads only re-apply a cached result. A count runs on a cache
miss, after the runtime has handled the top frame's announcement, or 5 seconds after a
finished load without one. Results are cached per origin as counts only, keyed by the
settings revision and each enabled connection's accepted snapshot, in memory and in
`chrome.storage.session` (default trusted-contexts access), at most 200 origins. Nothing
reaches the service or a model, and no per-site log entry is written. It needs no new
permission. Tab-specific badge values are re-applied after every load, because they
reset when a tab navigates.

This amends [ADR 0009](0009-install-time-https-site-access.md) and
[ADR 0016](0016-recipe-generation-trigger.md): a tab's origin is matched against the
open vault locally even without a recipe or a sign-in signal. A test must show that a
count started before a page's announcement delays that page's login without refusing
it.

#### Site count implementation

Implemented on 2026-10-23 in `apps/extension/src/login/site-count.ts`, superseding the
stale [PR 602](https://github.com/risu729/pateat/pull/602). These details fill gaps the
decision left open; they are implementation choices, not owner decisions:

- A count matches through the same `match-uris` and passkey lookups the popup's list and
  logins use (`createVaultUriMatcher`, `createVaultPasskeyFinder`), so an `http:` page
  counts only items saved with an `http://` URI and asks for passkeys only on
  `http://localhost` ([ADR 0050](0050-http-pages-for-http-items.md)). The crypto Worker
  answers from the login URIs it decrypted when the snapshot opened; a count decrypts
  nothing. It reads an open snapshot's catalog once and keeps in memory, per connection,
  only what eligibility reads: item IDs, group IDs and field IDs, kinds and emptiness,
  no name or label. That copy goes once a scope read finds the vault closed, locked, on
  another snapshot, disabled or removed.
- An item whose URI rules could not be read is noted when the popup's eligibility rule
  allows it, one whose passkeys could not be read by the passkey rule, and a quarantined
  item never.
- Titles: `Pateat: 2 accounts for this site. 1 more is excluded in settings.`, or
  `1 more waits for a custom-field review in settings.` for a quarantined item, or
  `N more are excluded or wait for a custom-field review in settings.` for both;
  `Pateat: 3 accounts match this site, but none can be used:` followed by
  `this site is excluded in settings`, `they are excluded in settings`,
  `they wait for a custom-field review in settings`, or both of the last two; and for no
  match, `Pateat: no account for this site.` Items a login could use whose URI rules or
  passkeys could not be read add `N items could not be checked.`, as the popup's list
  notes only those. The not-checked titles end `so this site's accounts were not
  counted.` A held login's tooltip replaces the count's title, not its number.
- A locked vault (its record holds no key), an unreadable record or an open vault on
  another snapshot than the accepted one shows not checked even when a count is cached.
  A vault not opened since Pateat restarted shows a count cached for the same settings
  revision and accepted snapshot, as the official extension shows its count whenever
  the vault is unlocked, and not checked only on a miss.
- A saved or synced settings change, an account choice or passkey default a login saves,
  each vault record write, and a vault serving a new snapshot after a sync's accept or a
  restore (which happens after the record write notified) show again what the cache has
  for every counted tab, from one read of the settings and records, so a count of the
  previous settings stops showing, and count each miss of a tab whose page has announced
  or whose 5 seconds passed. The decision limits only worker starts, tab activation and
  finished loads to the cache. A worker start reads them once for all open tabs, and
  takes a tab that had finished loading as announced.
- A count stopped for a login or an admission (of any frame, in any tab) shows no number
  and a not-checked title that starts
  `Pateat: a login or a page check was using the vault` and ends `were not counted yet.`
  It is tried again after 1, 2, 4, 8, 16 and 32 seconds, then no more on its own; after
  any top frame's handled announcement; and when a login signs in, is blocked, settles
  as unknown or is only watched; those do not restart the waits. The vault-replacement
  hold covers only the count's jobs, not the final read of what applies now.
- A count that finishes after the settings or a vault changed is cached under the key
  it was made for, and the tabs show what applies now instead. An announcement whose
  origin is no longer the tab's does not count.
- In the probe build, the bundled demo connections are counted by their static
  `allowedOrigins`.

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

## Amendment: save choices only after confirmed sign-in (2026-10-14)

The owner's decision at 07:24 UTC in
[issue #546](https://github.com/risu729/pateat/issues/546), recorded in
[ADR 0029](0029-local-sign-in-state.md#amendment-unconfirmed-completion-2026-10-14),
changes the save-after-`authenticated` rule in B: a pending automatic choice or popup
pick marked "make default" is saved only on a confirmed completion. An undecided
completion drops the pending choice and saves no default or binding. It still ends
`authenticated`, releases the site to other tabs and counts as a finished login for
D's detection of a later logout. The earlier accepted rules above remain as history.
