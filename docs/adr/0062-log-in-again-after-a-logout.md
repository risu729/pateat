# ADR 0062: Log in again after a logout, and pause automatic login

Status: A and C accepted by the owner; B and D proposed, not accepted. On 2026-10-22
(11:37 UTC) the owner asked to drop the rule that Pateat does not log in by itself after
a logout (「バグの温床なのでやめたい」), to log in automatically whenever a login page
is entered, and to add a button that pauses automatic login for a while, designed
together with account switching ([ADR 0063](0063-switch-accounts-from-the-popup.md)). A
reviewed proposal asked three questions by decision card; before they were answered, the
owner asked on 2026-10-23 (05:28 UTC) to build on the likely answers and decide later,
like the pull requests built ahead of their phases
(「フェーズは一旦無視して、ある程度決め打ちで進め、後から 判断」). The owner accepted A
and C (log in again after a logout, with the repeat guard) on 2026-10-23 at 11:54 UTC by
a card tap (「自動ログイン + 歯止め」, over asking when a later step starts and keeping
the current rule). B and D are still the recommended options of their cards, not the
owner's answers. Replaces
[ADR 0021 D](0021-account-choice-outside-settings.md#d-after-a-logout-choose-again-detection-l1)
except its rejected-password, stopped-login and abandoned-watch asks, which stay
without filling.

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
to stay logged out; the pause covers that case.

## Decision

### A. A logout is followed by an ordinary login

- When a Pateat login in a tab has finished and a recipe's first step (or a later step a
  login may start at, [ADR 0049](0049-start-at-a-later-step.md)) shows again, the
  tab's [ADR 0022](0022-login-attempts-per-tab-and-origin.md) record is released as
  before, and an ordinary login starts with the account an automatic login would use:
  the session pick of [ADR 0063](0063-switch-accounts-from-the-popup.md), else the site
  default, else the only match. The passkey route is taken when chosen. Other tabs of
  the site log in as usual.
- Removed: the logout state (`pateat.login-logouts.v1`), other tabs asking because of
  a logout, the fill-only login (`fillOnly` on attempt records,
  `pateat.login-logout-fills.v1`), logout clicks (`pateat.login-logout-clicks.v1`,
  `login.document.logout-clicked`, the entry refusal `logout-clicked`, the passkey
  mark `logoutClicked`), the passkey chooser in a tab Pateat signed in from
  (`pateat.passkey-signed.v1`), and the log entries `login.logout` and
  `login.refused` `logged-out`. Attempt records move to `pateat.login-attempts.v6`
  (no `fillOnly`); older records are not read. A username-less passkey request is signed
  with the site's account without a window when one is to be used; the chooser opens
  only for several matches without a usable default, as C of ADR 0021 says.
- [ADR 0031](0031-sign-in-entry-pages.md) no longer reads a logout state. Its
  `site-record` check still keeps a tab where Pateat logged in from pressing an entry.

### B. The asks that remain do not fill

Three cases still ask for an account, because each would otherwise submit again what
just failed:

- a rejected password (`credential-rejected`, or the sign-in form shown again after the
  password): every tab of the site asks and none offers a pick
  (`rejectedElsewhere`), as the owner chose on 2026-10-13 (「他のタブも聞く」); kept in
  `pateat.login-rejected-asks.v1`;
- a login stopped after a submission (`pateat.login-stopped-asks.v1`, ADR 0021 D,
  2026-10-12);
- a watched login abandoned (`challenge-abandoned`, `watch-abandoned`,
  [ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)).

They no longer fill without pressing: the document is refused `account-asked` with
detail `rejected`, `rejected-elsewhere` or `stopped-login`, and the badge and popup list
the accounts; a pick logs in. `login.ask-ended` is logged for these asks only. A
rejection no longer keeps [ADR 0031](0031-sign-in-entry-pages.md) entries unpressed; the
login page an entry leads to asks. The page's own passkey request still waits while the
tab asks, as [ADR 0034](0034-answer-page-passkey-requests.md) rule 5 describes.

### C. A guard against repeated logins

Logging in after every logout could loop on a site whose form stays after login, a site
that logs out right after a login, or two tabs of a site that allows one session.

- When two automatic logins of a registrable site, in any of its tabs, ended
  `authenticated` within 10 minutes (an ADR 0029 undecided completion counts), the
  next automatic login of the site does not start: its document is refused
  `relogin-limit` and asks. A popup pick logs in and is not counted.
- The count includes the first login: a login, a logout and a login again pass, and the
  next logout's login asks. The popup says Pateat logged in to the site twice in the
  last 10 minutes.
- The completion times are kept per site, separately for incognito, in
  `pateat.login-relogins.v1` in `chrome.storage.session`, so the guard survives a
  worker restart and a replaced tab.
- The ask ends with a popup pick, once 10 minutes have passed since the first counted
  completion (the next announcement logs in), or when the site's tabs have all closed.

### D. Pausing automatic login

- The toolbar popup shows "Pause automatic login" under the "Pateat on this site" row.
  It pauses the tab's registrable site for one hour in every tab, separately for
  normal and incognito windows (the extension runs in spanning mode, so
  `chrome.storage.session` is shared while cookies are not). While paused the popup
  shows "Paused until 12:40" and "Resume".
- Kept in `pateat.login-pauses.v1` in `chrome.storage.session` (site, incognito, end
  time; at most 256 sites). Nothing reaches the service or other devices; closing the
  browser ends it.
- While paused, Pateat starts nothing by itself on the site: no automatic login and no
  fill, no [ADR 0031](0031-sign-in-entry-pages.md) entry press, no page sent for a
  recipe, and a conditional passkey request of
  [ADR 0034](0034-answer-page-passkey-requests.md) is handed on to the browser at once.
  A frame's login is paused when the top page's site or the frame's site is.
- Pressing Pause also stops the site's running automatic logins in that window kind
  before their next step, as a policy change does (`policy-changed`, cause `paused`);
  their tabs ask as paused pages. A login started by a popup pick goes on. The pause is
  read again right before a login starts or a page is sent, and after a page's passkey
  request is parked.
- What the person starts still runs: a paused document is refused `paused` and offers
  the account list (`login.refused` `paused`, the saved default first), and a pick logs
  in once with the password route; an item with no password is refused
  (`paused-no-password`); modal and
  Immediate UI passkey requests ([ADR 0007](0007-existing-passkey-assertions.md),
  [ADR 0052](0052-immediate-ui-stored-passkeys.md)) are answered as before.
- The badge shows a gray `II` on the site's tabs, with the end time in its title; a
  waiting choice's amber count wins ([ADR 0038](0038-login-status-badge.md)).
- "Resume" ends the pause and asks the site's tabs to announce again, so they log in at
  once. At the end time nothing is re-announced; the next page load logs in. A popup
  pick whose login is confirmed signed in ends its site's pause; an undecided completion
  ([ADR 0029](0029-local-sign-in-state.md)) does not. The log shows `login.pause` with
  `paused`, `resumed` or `picked`.
- This is not a timed form of the "Pateat on this site" switch, which excludes one host
  name and syncs. The official Bitwarden extension has no timed pause; its blocked
  domains are permanent, like that switch.

## Considered alternatives

- Keep ADR 0021 D and fill the password route when the passkey route has nothing to
  fill (the #833 card's option A). Keeps the mechanism the owner wants gone.
- Ask when a later step (ADR 0049) starts in a tab Pateat logged in from, so a
  re-verification page shaped like a password step is not submitted. Keeps part of the
  logout state; [ADR 0035](0035-page-kinds-per-site.md) is the rule for such pages.
- A guard by time alone (ask when the first step shows within 60 seconds of a login).
  It also stops a person who logs out and in again at once.
- Pause per tab: another tab's automatic login enters the same cookie session.
- Fill without pressing in the remaining asks, as before.

## Consequences

- [#833](https://github.com/risu729/pateat/issues/833) logs in with the passkey after a
  logout.
- A re-verification page that matches a recipe's step on the same path is submitted in a
  tab Pateat logged in from, as it already is in other tabs, until ADR 0035 is built.
- A login that left for an identity provider (`left-origin`) and comes back to the
  site's form logs in again; such a loop is not counted by the guard, which counts only
  `authenticated` endings.
- A person who wants to stay logged out presses Pause first, or logs out and leaves the
  login page; leaving the site and coming back to its login page logs in again.
- The plan's real-site rows for choosing again after a logout (Wise, アパホテル) are
  replaced by a check that the login after a logout runs, and that Pause holds it.
