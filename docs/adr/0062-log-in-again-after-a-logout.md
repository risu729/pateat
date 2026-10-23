# ADR 0062: Log in again after a logout, and pause automatic login

Status: accepted by the owner on 2026-10-23 and implemented in
[PR #866](https://github.com/risu729/pateat/pull/866). On 2026-10-22 (11:37 UTC, 20:37
JST) the owner asked to drop the rule that Pateat does not log in by itself after a
logout (「バグの温床なのでやめたい」), to log in automatically whenever a login page is
entered, and to add a button that pauses automatic login for a while, designed together
with account switching ([ADR 0063](0063-switch-accounts-from-the-popup.md)). A reviewed
proposal asked its questions by decision card; before they were answered, the owner
asked on 2026-10-23 (05:28 UTC, 14:28 JST) to build on the likely answers and decide
later (「フェーズは一旦無視して、ある程度決め打ちで進め、後から 判断」). Then, on
2026-10-23:

- 11:54 UTC (20:54 JST), A and C, by a card tap: log in again after a logout, with the
  repeat guard (「自動ログイン + 歯止め」, over asking when a later step starts and
  keeping the current rule).
- 11:55 UTC (20:55 JST), B: the remaining asks fill the page once without pressing, as
  before (「追加認証は入力だけするんじゃないの？それと同じではないですか？」, the same
  as [ADR 0035](0035-page-kinds-per-site.md)'s `confirm` pages); the recommended option,
  asking without filling, was not taken.
- 11:56 UTC (20:56 JST), D: on a paused site, a passkey request the person starts opens
  the account chooser, with the site default treated as unset, and nothing logs in
  automatically
  (「これはアカウント選択画面を出すようにしましょう。既定がunsetされたという扱いでいい
  し、あと自動ログインは基本的に一切しない」).
- 11:56–11:57 UTC (20:56–20:57 JST), E: a setting for private windows, off by default
  (「incognitoで一括して自動ログインを永久に止める設定は作っておきましょうか」
  「incognitoでも入力するか、既定オフみたいなことね」).
- 12:00 UTC (21:00 JST), D, by a card: the pause covers the whole site, and its length
  is chosen when pressing it (「サイト全体・押すとき選ぶ」). At 12:01 UTC (21:01 JST):
  「ブラウザを閉じるまで、は、オンにもどすまで、にしましょう。既存の対象外にする設定と一緒にして。細かい挙動の差分は基本的に不要なのでいいです。」,
  so the lengths are 10 minutes, 1 hour and "Until turned back on", which is the
  existing site exclusion. By a card at 12:14 UTC (21:14 JST), the exclusion now pauses
  instead of turning Pateat off on the site (「対象外も一時停止の動きに」), and the
  popup's "Pateat on this site" switch and the pause button become one control whose
  rule is the registrable site with its subdomains.

Replaces
[ADR 0021 D](0021-account-choice-outside-settings.md#d-after-a-logout-choose-again-detection-l1)
except its rejected-password, stopped-login and abandoned-watch asks, which stay. Amends
what an exclusion rule stops in [ADR 0007](0007-existing-passkey-assertions.md),
[ADR 0009](0009-install-time-https-site-access.md),
[ADR 0016](0016-recipe-generation-trigger.md),
[ADR 0017](0017-login-forms-in-frames.md),
[ADR 0021](0021-account-choice-outside-settings.md),
[ADR 0024](0024-settings-profiles.md) (which also gains E's profile part) and
[ADR 0035](0035-page-kinds-per-site.md), and amends
[ADR 0022](0022-login-attempts-per-tab-and-origin.md),
[ADR 0031](0031-sign-in-entry-pages.md),
[ADR 0034](0034-answer-page-passkey-requests.md),
[ADR 0038](0038-login-status-badge.md), [ADR 0049](0049-start-at-a-later-step.md) and
[ADR 0052](0052-immediate-ui-stored-passkeys.md).

Date: 2026-10-23

## Context

ADR 0021 D made a tab ask for an account instead of logging in once its own login had
finished and the site's first step showed again. Since 2026-10-12 it filled the form
without pressing anything when one account was to be used. Around it grew other tabs
asking because of a logout, logout clicks (2026-10-16), a passkey chooser after Pateat
signed in the tab, a sign-in entry check, a parked passkey request rule in
[ADR 0034](0034-answer-page-passkey-requests.md) and six `chrome.storage.session` keys.

On 2026-10-20 the Grok Bot logged out of MyJCB
([#833](https://github.com/risu729/pateat/issues/833)). The site default's route was
the passkey, so the fill-only login had nothing to fill, and the page stayed as it was
(`login.refused` `logged-out` `this-tab`). The same default logged in with its passkey
the next day in a new tab.

The official Bitwarden extension never presses a button, but its "Autofill on page
load" fills on every load and does not tell a logout apart
([Bitwarden help](https://bitwarden.com/help/auto-fill-browser/)). With account
switching ([ADR 0063](0063-switch-accounts-from-the-popup.md)), a person rarely needs
to stay logged out; the pause covers that case. Until now a site exclusion
(`excludedSites`) turned Pateat off on its hosts, popup picks and passkey answers
included.

## Decision

### A. A logout is followed by an ordinary login

- When a Pateat login in a tab has finished and a recipe's first step (or a later step a
  login may start at, [ADR 0049](0049-start-at-a-later-step.md)) shows again, the tab's
  [ADR 0022](0022-login-attempts-per-tab-and-origin.md) record is released as before,
  and an ordinary login starts with the account an automatic login would use: an account
  switch's pick ([ADR 0063](0063-switch-accounts-from-the-popup.md)), else the saved
  default, else the only match. A site that asks every time after a one-time pick (ADR
  0063) asks instead. The passkey route is taken when chosen. Other tabs of the site log
  in as usual.
- Removed: the logout state (`pateat.login-logouts.v1`), other tabs asking because of
  a logout, the fill-only login after a logout (`pateat.login-logout-fills.v1`), logout
  clicks (`pateat.login-logout-clicks.v1`, `login.document.logout-clicked`, the entry
  refusals `logged-out` and `logout-clicked`, the passkey mark `logoutClicked`), the
  passkey chooser in a tab Pateat signed in from (`pateat.passkey-signed.v1`, the mark
  `signedBefore`), and the log entries `login.logout` and `login.refused` `logged-out`.
  A username-less passkey request is signed with the site's account without a window
  when one is to be used; the chooser opens for several matches without a usable
  default, as C of ADR 0021 says, or where D, E or ADR 0063 treats the default as unset.
- [ADR 0031](0031-sign-in-entry-pages.md) no longer reads a logout state. Its
  `site-record` check still keeps a tab where Pateat logged in from pressing an entry.

### B. The asks that remain fill once without pressing

Three cases still ask for an account, because logging in would submit again what just
failed:

- a rejected password (`credential-rejected`, or the sign-in form shown again after the
  password): every tab of the site asks and none offers a pick
  (`rejectedElsewhere`), as the owner chose on 2026-10-13 (「他のタブも聞く」); kept in
  `pateat.login-rejected-asks.v1`;
- a login stopped after a submission (`pateat.login-stopped-asks.v1`, ADR 0021 D,
  2026-10-12);
- a watched login abandoned (`challenge-abandoned`, `watch-abandoned`,
  [ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)), kept as a
  stopped login.

The document is refused `account-asked` with detail `rejected`, `rejected-elsewhere` or
`stopped-login`, and the badge and popup list the accounts, the saved default first; a
pick logs in. As before this ADR, and as ADR 0035 fills `confirm` pages, when one
account is to be used (the usable saved default, or the only match without one) each
such document is first filled once on each path without pressing anything: a fill-only
login (`fillOnly` on its attempt record, `login.attempt` with reason `fill-only`) that
ends before its first step with an effect, after which the page asks. Filled pages, and
the document a rejected login is kept off, are kept in `pateat.login-ask-fills.v1` in
`chrome.storage.session`, so a restarted worker does not fill them again; the page the
site rejected a login on is not filled again. The passkey route has nothing to fill.
The asks of C and of ADR 0063's one-time pick fill nothing. `login.ask-ended` is logged
when the tab of a rejected or stopped login closes. A rejection no longer keeps
[ADR 0031](0031-sign-in-entry-pages.md) entries unpressed; the login page an entry
leads to asks. The page's own passkey request still waits while the tab asks, as
[ADR 0034](0034-answer-page-passkey-requests.md) rule 5 describes.

### C. A guard against repeated logins

Logging in after every logout could loop on a site whose form stays after login, a site
that logs out right after a login, or two tabs of a site that allows one session.

- When two automatic logins of a registrable site, in any of its tabs, ended
  `authenticated` within 10 minutes (an ADR 0029 undecided completion counts), the
  next automatic login of the site does not start: its document is refused
  `relogin-limit` and asks, filling nothing. A popup pick or a switch's login logs in
  and is not counted.
- A passkey sign-in Pateat answered by itself outside a login (one match or the site
  default, with no chooser) counts as such a login, so a login page that calls
  `navigator.credentials.get()` on load after each logout is held too. While the guard
  holds the site, its default counts as unset for the page's own passkey request
  ([ADR 0063](0063-switch-accounts-from-the-popup.md)): the chooser opens, or the
  request is handed on where it cannot.
- The count includes the first login: a login, a logout and a login again pass, and the
  next logout's login asks. The popup says Pateat logged in to the site twice in the
  last 10 minutes.
- The completion times are kept per site, separately for incognito, in
  `pateat.login-relogins.v1` in `chrome.storage.session`, so the guard survives a
  worker restart and a replaced tab.
- The ask ends with a popup pick, once 10 minutes have passed since the first counted
  completion (the next announcement logs in), or when the site's tabs have all closed.

### D. Pausing automatic login

- The toolbar popup's pause row replaces the "Pateat on this site" switch. On a page of
  a site Pateat runs on where a vault item matches or the site has a recipe, "Pause
  automatic login" offers 10 minutes, 1 hour and "Until turned back on". Each covers the
  tab's registrable site in every tab.
- A pause of 10 minutes or an hour is kept on the device in `pateat.login-pauses.v1` in
  `chrome.storage.session` (site, incognito, length, end; at most 256 sites), separately
  for normal and incognito windows (the extension runs in spanning mode, so
  `chrome.storage.session` is shared while cookies are not). Nothing reaches the service
  or other devices; closing the browser ends it, and closing the last incognito window
  ends the incognito ones. While it runs the popup shows "Paused until 12:40" and
  "Resume". A pause store that cannot be read counts every site as paused.
- "Until turned back on" is the site exclusion (`excludedSites`). The popup adds
  `{hostname: <registrable site>, includeSubdomains: true}`, replacing a rule of the
  same hostname, and its Resume removes the rules that cover the tab's hostname and lie
  within the site. A covering rule for a parent of the site, such as a public suffix,
  also covers other sites: the popup says "Paused by a rule for other sites too" and
  links it to the settings page. The extension's settings page and `/manage` edit the
  rules as before, now named Pause and Resume; their per-origin Pause, and the switch on
  a `/manage` site page, add the same registrable-site rule as the popup. A rule is
  synced, applies in both window kinds on every device of the profile, and shows over a
  timed pause.
- An exclusion used to turn Pateat off on its hosts: no document was admitted, the popup
  listed no account and offered no choice ("No logins or passkey answers on this site"),
  a waiting choice was dropped, and every passkey request was handed on. Now the
  document is admitted and paused as below. Hostnames Pateat does not run on are still
  refused (`unsupported-host`), and an ADR 0031 entry whose link leads to an excluded
  host is still refused `destination-excluded`.
- While paused, Pateat starts nothing by itself on the site: no automatic login and no
  fill, no [ADR 0031](0031-sign-in-entry-pages.md) entry press, no page sent for a
  recipe or a signed-in sample (`recipe.generate` and `recipe.sample` skip `paused`),
  and a conditional passkey request of
  [ADR 0034](0034-answer-page-passkey-requests.md) is handed on to the browser at once
  (`paused`). A frame's login is paused when the top page's site or the frame's site is.
- Pressing a timed pause also stops the site's running automatic logins in that window
  kind before their next step, as a policy change does (`policy-changed`, cause
  `paused`); their tabs ask as paused pages. A login started by a popup pick goes on.
  The pause is read again right before a login starts or a page is sent, and after a
  page's passkey request is parked. A rule saved or synced stops running logins as any
  settings change does, and the tabs of a site a rule no longer pauses announce again.
- What the person starts still runs. A paused document is refused `paused` and offers
  every matching account, the saved default first, also a single one (`login.refused`
  `paused`); a pick logs in once with the password route, and an item with no password
  is refused (`paused-no-password`), the popup pointing to the page's own passkey
  button. A modal or Immediate UI passkey request
  ([ADR 0007](0007-existing-passkey-assertions.md),
  [ADR 0052](0052-immediate-ui-stored-passkeys.md)) opens the chooser with the site
  default treated as unset: every passkey that fits is listed, also a single one, none
  is preselected, "Make default" starts unticked, and the window says automatic login is
  paused. Where the window cannot open, the request is handed on as `paused`; nothing is
  signed without a choice (`passkey.request` marks `defaultUnset` and `paused`). An
  account switch, being the person's pick, still runs (ADR 0063).
- The badge shows a gray `II` on the site's tabs, with the end time, or "until turned
  back on", in its title; a waiting choice's amber count and the model request's spinner
  win ([ADR 0038](0038-login-status-badge.md)).
- "Resume" ends the pause and asks the site's tabs to announce again, so they log in at
  once. At a timed pause's end nothing is re-announced; the next page load logs in. A
  popup pick whose login is confirmed signed in ends its site's timed pause; an
  undecided completion ([ADR 0029](0029-local-sign-in-state.md)) does not, and a rule
  stays. The log shows `login.pause` with `paused` (and its length), `resumed` or
  `picked` for timed pauses; a rule change is a `settings.changed` entry.

### E. Automatic login in private windows

- The extension's settings page has "Log in automatically in private windows", off by
  default (`loginInPrivateWindows`, absent while off). It is synced with the site rules
  as a profile part ([ADR 0024](0024-settings-profiles.md)) and does not change normal
  windows.
- While it is off, every site in a private (incognito) window is paused as in D: nothing
  logs in, fills, presses an entry or is sent by itself, conditional passkey requests
  are handed on, and a popup pick still runs. The popup says "Automatic login is off in
  private windows" with "Change in settings", which opens that section, and offers no
  timed pause; the badge, the popup's reason and page lines say automatic login is off
  in private windows rather than that the site is paused. A tab whose window kind is not
  known is not treated as private.
- The person's own modal or Immediate UI passkey request is answered as before this
  ADR, not as D's paused request: one match or the site default signs, and several
  matches are handed on, as the chooser cannot open in a private window (Immediate UI
  stays handed on in incognito, `immediate-incognito`). This setting alone does not
  treat the default as unset; a timed pause, a rule, the guard of C or "Ask every time"
  (ADR 0063) still does. Coordinator's choice on 2026-10-23, since under D's rule every
  such request in a private window would be handed on. A pick of an item with no
  password (`paused-no-password`) points to the page's own passkey button, not to
  Pateat's window.
- Turned on, private windows log in as other windows do, with their own timed pauses
  and repeat counts. A pause until turned back on is a synced rule that pauses normal
  windows too, so the popup offers only 10 minutes and 1 hour there. Chrome's Immediate
  UI is still handed on in incognito (`immediate-incognito`, ADR 0052).
- Closing the last incognito window clears the incognito timed pauses, repeat counts
  and "Ask every time" picks.

## Considered alternatives

- Keep ADR 0021 D and fill the password route when the passkey route has nothing to
  fill (the #833 card's option A). Keeps the mechanism the owner wants gone.
- Ask when a later step (ADR 0049) starts in a tab Pateat logged in from, so a
  re-verification page shaped like a password step is not submitted. Keeps part of the
  logout state; [ADR 0035](0035-page-kinds-per-site.md) is the rule for such pages.
- A guard by time alone (ask when the first step shows within 60 seconds of a login).
  It also stops a person who logs out and in again at once.
- Pause per tab: another tab's automatic login enters the same cookie session.
- Ask without filling in the remaining asks (the proposal's recommendation): the person
  types the account again where Pateat already knows the one to use.
- A fixed one-hour pause beside the "Pateat on this site" switch (the proposal): two
  controls that both stop Pateat on a site, the switch also stopping picks and passkey
  answers, and a rule for one hostname while the pause covered the site.
- Keep exclusions as a full stop and add a separate indefinite pause: two settings that
  differ only in whether a pick may log in.
- Private windows logging in like normal ones, as before: an incognito window is often
  used to stay out of an account.

## Consequences

- [#833](https://github.com/risu729/pateat/issues/833) logs in with the passkey after a
  logout.
- A re-verification page that matches a recipe's step on the same path is submitted in a
  tab Pateat logged in from, as it already is in other tabs, until ADR 0035 is built.
- A login that left for an identity provider (`left-origin`) and comes back to the
  site's form logs in again; such a loop is not counted by the guard, which counts only
  `authenticated` endings.
- A person who wants to stay logged out pauses the site first, or logs out and leaves
  the login page; leaving the site and coming back to its login page logs in again.
- No setting keeps the vault away from a site any more: on a paused site a popup pick
  and the person's own passkey request still use it. Only hostnames Pateat does not run
  on stay untouched.
- In a private window nothing logs in by itself until the setting is turned on; a pick
  and an account switch still log in.
- The plan's real-site rows for choosing again after a logout (Wise, アパホテル) are
  replaced by a check that the login after a logout runs, and that a pause holds it.
