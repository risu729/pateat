# ADR 0022: Login attempt records per tab and origin

Status: accepted by the owner on 2026-10-11 (11:42 UTC) as a bug fix and implemented in
the PR that adds this record. Amends [ADR 0016](0016-recipe-generation-trigger.md)
(which tabs may offer a page) and [ADR 0017](0017-login-forms-in-frames.md) (one attempt
per tab). Tested on synthetic fixtures only; no real site or account has been used.

Date: 2026-10-11

Amended on 2026-10-11 (18:27 UTC, owner's choice in the thread): a finished login in
another tab no longer holds the origin; see "Holding the origin in other tabs" below.
Amended again on 2026-10-12 (02:42 UTC, owner's choice on a decision card): a login
Pateat itself stopped no longer holds the origin either. Evidence: in the owner's Chrome
a `policy-changed` record from a transient vault error kept a new npm tab from logging
in for 8 hours, across an extension reload.
Amended again on 2026-10-12 (05:08 UTC, owner's choice in the thread after a decision
card): a record that still holds the origin stops holding it 5 minutes after it last
changed. Evidence: in the owner's Chrome a github.com login that had succeeded after a
passkey step stayed `reconciling` with an unknown result in one tab, so a pick in
another tab was refused `origin-busy` until that tab would close.
Amended on 2026-10-12 (05:41 UTC, owner's request in the project chat): a tab that moves
to another site starts clean there, also for a login form in a frame; see "A tab still
runs one attempt at a time" below.
Amended again on 2026-10-12 (bug fix applying the 02:42 UTC choice to the stopped tab
itself): a login Pateat itself stopped with nothing in flight and before any submission
no longer holds its own tab either. Evidence: in the owner's Chrome, removing
github.com's saved default stopped that tab's login as `policy-changed`; after a reload
the page was refused for several matching accounts, but it had resumed the stopped
record, so the toolbar popup offered no account choice and the tab never logged in again
until it was closed.
Amended again on 2026-10-12 (08:22 UTC, owner's choice on a decision card, proposal in
the project notes `jal-same-site-completion-proposal.md`): a move to the site of a
passkey Pateat has just answered completes the attempt; see "Leaving the origin after a
possible submission ends the attempt" below. Evidence: in the owner's Chrome, JMB's
sign-in page `jallogin.jal.co.jp` asked for a passkey after the username step, Pateat
answered, and the site moved to `www.jal.co.jp` signed in, but the login ended
`left-origin`, so it held the site for 5 minutes and saved no account choice.

## Context

The executor kept one attempt record per tab in `pateat.login-attempts.v1`, terminal
or not, until the tab closed. A new page in the tab always resumed that record, so:

- After any attempt on `https://login.example` (even `authenticated`), a page of
  `https://idp.example` in the same tab was refused `recipe-not-found`: the runtime
  looked up the old recipe's ID on the new origin. A site that sends the tab to an
  identity provider after its email step, and ordinary browsing (log in to one site,
  then to another in the same tab), never logged in on the second origin.
- After a submission on one origin, a move to another origin left the attempt
  `reconciling` with outcome `unknown-submit` until the tab closed. `login.active()`
  stayed true, so settings sync was deferred for up to two minutes per run.

These came up while discussing sign-in through identity providers. The owner chose to
fix them now; the SSO policy itself is recorded separately.

## Decision

- **One record per tab and origin.** A record is keyed by its tab and its
  `account.origin` (the attempt document's origin; a frame's own origin for a frame
  attempt). A tab may hold records for several origins; all are deleted when the tab
  closes.
- **A page resumes only its own origin's record**, also an ended one. A new attempt
  starts only when the tab has no record for that origin. A record Pateat itself stopped
  with nothing in flight, as described under "Holding the origin in other tabs" below,
  before any submission is the exception (amended 2026-10-12; `wrong-account` stays with
  logout detection and `account-switched` with its own exception below): a new document
  of that origin in the tab that the one-attempt rule below lets start releases it and
  is handled like one in a new tab, with the saved default or by asking when several
  items match. The same document announcing again, as after a restarted worker, still
  resumes it. A stop after a submission is resumed, unlike in another tab: this tab's
  new pages arrive without the user, so a site that sends the tab back to its first step
  would otherwise get the credentials again each time. Once such a top-level record no
  longer holds the site against other tabs, its login form's first step showing on a
  later top-level document of the tab releases it, and that tab asks and only fills,
  never submitting (ADR 0021 D, amended 2026-10-12). A finished top-level record whose
  login form's first step shows again is released by the logout detection of ADR 0021
  (part D), which then asks for an account instead of submitting. Returning to an origin
  the tab already tried therefore never submits again, which keeps a loop such as site →
  identity provider error → site → identity provider from resubmitting credentials. The
  `account-switched` exception of ADR 0016 stays.
- **A tab still runs one attempt at a time.** When a new top-level page of another
  origin arrives while the tab's top-level attempt has not ended, that attempt ends
  first (`NAVIGATED`) and keeps its record; then the new top-level page is handled like
  one in a fresh tab. Frames of that page are too (amended 2026-10-12). A record belongs
  to the site of the tab's page when its login started: the record's own origin for a
  top-level login, and the page around it (stored as `pageOrigin`) for a frame's login.
  An ended record of another site than the tab's page never holds the page or its
  frames, also after a worker restart. A top-level one that has not ended ends
  `NAVIGATED` first, also when a frame announces before its page; a frame's one ends
  when the new page arrives, as below. Before, a frame of a later page got
  `tab-busy` while the tab held any earlier record, so a site whose login form is in a
  frame never logged in in a tab used for another site's login, and after a restart the
  next site's page did not either. A document of the left site's own origin, such as a
  frame of it on the new page, still resumes that origin's ended record and never
  submits there again, unless Pateat stopped that record before any submission, which
  releases it as above. While the tab's latest record belongs to the page's site, it
  still holds the page's other frames with `tab-busy`. Frame attempts keep ADR 0017's
  rule: a whole-tab navigation ends them `blocked` with outcome `cancelled`. A frame
  that itself moves to another origin does not end its attempt; it ends with the next
  whole-tab navigation or when the tab closes, as before.
- **Leaving the origin after a possible submission ends the attempt.** A top-level
  attempt that may have submitted (any fill or a click that submitted) and sees the
  tab's page move to another origin ends `blocked` with the new outcome `left-origin`.
  Without a possible submission it ends `interrupted`. Neither is `authenticated`, so no
  account choice is saved, and neither is retried. For the logout detection of
  [ADR 0021](0021-account-choice-outside-settings.md) (part D), both count as finished,
  like unknown outcomes.
  - **A move after a passkey answer** (amended 2026-10-12). Such an attempt ends
    `authenticated` instead when all of these hold: after its last effect step and at
    most 30 seconds before the move, Pateat returned an assertion to a passkey request
    of the attempt's page (its tab and origin); the new top page is HTTPS and its host
    is the passkey's RP ID or a subdomain of it, so `jallogin.jal.co.jp` may move to
    `www.jal.co.jp` for RP ID `jal.co.jp`; and that page, read when it announces itself,
    shows no password field, code input or CAPTCHA and makes no passkey request of its
    own, in two readings a second apart once it has loaded (at most 5 readings). The
    readings are the page signs of [ADR 0029](0029-local-sign-in-state.md); Pateat fills
    and clicks nothing there. A username-only form is not among those signs, and the
    failure signs next to the sign-in fields cannot apply to a new page. The page's
    announcement waits for the readings. A frame of the new page that announces first
    leaves the move to the top page (it is refused `tab-busy` while the attempt still
    runs), and one that announces during the readings waits for them. The completion
    saves an automatic account choice and releases the origin like any other
    `authenticated` attempt; it is the one completion that needs neither a completion
    check, ADR 0029 evidence nor the judge, also on the `passkey` route of
    [ADR 0027](0027-per-account-login-routes.md). The answer is kept in memory only, so
    after a worker restart, or with any condition not met, the attempt ends
    `left-origin` as before. A site that rejects the assertion and sends the tab to a
    quiet page of the same site is counted as signed in; other tabs may then log in
    there again.
- **Holding the origin in other tabs** (amended 2026-10-11 and twice on 2026-10-12).
  Cookies can be shared across tabs, so another tab's record of the origin refuses a new
  attempt with `origin-busy` until that tab closes or the record has not changed for 5
  minutes (`changedAt`, written when the login's progress changes: a new page of its tab
  or a page sent to be judged does not count, nor does a restarted worker finding it; a
  record without it does not hold), unless it is `authenticated`, ended `interrupted`
  without any submission, or ended `blocked` because Pateat itself stopped it with
  nothing in flight: `policy-changed`, `value-mismatch`, `wrong-account`,
  `account-switched`, or `cancelled` before any submission (a frame login whose page
  went away also ends `cancelled`), without a pending mutation intent, a click the page
  may have received, or a result settled as unknown. A withdrawn authorization before
  the page received the prepared fill or click takes back that operation's reserved
  effect, so such a record shows nothing in flight; a record a restarted worker finds
  with an intent pending keeps holding. Such a record does not hold: the login form
  showing in a new tab means the site's session has ended, as when the first tab is
  closed, and a stop by Pateat says nothing about the password. This includes a stop on
  a second-factor handler step after the password was accepted. The tab then logs in as
  a new tab would, with the saved default or by asking when several items match. While
  an automatic account choice is being saved, or if one was saved after the tab read its
  settings, the new login waits for the save and is checked again with the new settings,
  because the save bumps the policy revision it would otherwise be stopped by. A record
  in any other state keeps holding, for example one that is running, `retryable` (a
  restarted worker resumes it), still reconciling, settled as unknown, ended
  `interrupted` after a submission, stopped by Pateat while a fill or click may have
  reached the page, or ended `credential-rejected`, `challenge`, `submission-limit` or
  `left-origin`. So a password is not submitted again while a first submission may still
  be in flight or was refused, or while the user may be answering a challenge Pateat
  does not handle. Releasing `account-switched` lets another tab start between the
  switch click and the first tab's fresh attempt, which then waits as `origin-busy`. A
  refused tab's tooltip says that another tab's login holds the site and that closing
  that tab, or waiting 5 minutes and reloading, lets it log in, and is reset when the
  tab logs in ([Background execution](../architecture.md#background-execution)). A
  refused page does not announce again when the hold ends; reloading it starts the
  login, as does a pick in the toolbar popup while the page waits for an account choice
  ([ADR 0021](0021-account-choice-outside-settings.md)).
- **Generation offers.** ADR 0016's "a page is not offered while its tab holds an
  attempt record" now means a record for the page's own origin.
- The move is noticed only when the new page announces itself, which needs HTTPS, a site
  that is not excluded and site access (ADR 0009). Elsewhere the old attempt keeps
  today's behaviour.

## Alternatives

- **Release a hold once its tab moves to another page of the site.** Not chosen
  (2026-10-12): a second-factor page is such a move while the login is still running,
  so telling it from the page after a login needs the login-completion judge, which
  already releases a record it judges `authenticated`. A tab opened before an extension
  update has no content script, so its moves are not seen at all.
- **Release a hold after 10 minutes.** The owner chose 5 minutes instead.
- **Keep every record holding the origin until its tab closes** (the original rule).
  Replaced on 2026-10-11: after a logout that does not show the login form again in
  the same tab (npmjs.com's logout lands on its home page), a login form opened in a
  new tab did nothing, and nothing said why, until the first tab was closed.
- **Ask for an account in the new tab instead of logging in.** Not chosen: the owner
  preferred the same behaviour as a new tab after the first tab is closed. A page that
  shows a login form while the site is still signed in, such as an add-account page
  (`accounts.google.com/AddSession`), is therefore logged in to with the saved default
  even while the first tab is open, as it already was with no other tab. Telling such
  pages apart is later work with low priority.
- **Complete any move to the same site after a submission.** Not chosen (2026-10-12):
  a second-factor or error page on another origin of the site is such a move. The owner
  chose the passkey case only, where Pateat's own answer and the quiet new page tell it
  from one; the same for a return URL the sign-in page names was not chosen, as sites
  also return there after a cancel or failure.
- **Release the origin hold on `left-origin`.** Rejected: moving to another origin is
  not proof of success (an identity provider can forward to a second factor on another
  origin, or to an error page). Another tab could then submit the same password again,
  adding second-factor prompts or locking the account.
- **Start a new attempt for every new page of another origin, even one the tab already
  tried.** Rejected: an identity provider that sends the tab back to the site with an
  error would make both origins submit again in turn.

## Consequences

- A sign-in that briefly shows a page on another origin before returning to the same
  site (a JavaScript or meta-refresh bounce) now ends `left-origin` instead of being
  resumed on its return, so it is not counted `authenticated` and its automatic account
  choice is not saved. HTTP redirects do not load a page and are not affected.
- The stored format changes without migration; Pateat is unreleased.
- Each origin a tab visited with an attempt counts towards the 100-record limit until
  the tab closes.
