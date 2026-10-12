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
  starts only when the tab has no record for that origin. A finished top-level record
  whose login form's first step shows again is released by the logout detection of ADR
  0021 (part D), which then asks for an account instead of submitting. Returning to an
  origin the tab already tried therefore never submits again, which keeps a loop such as
  site → identity provider error → site → identity provider from resubmitting
  credentials. The `account-switched` exception of ADR 0016 stays.
- **A tab still runs one attempt at a time.** When a new top-level page of another
  origin arrives while the tab's top-level attempt has not ended, that attempt ends
  first (`NAVIGATED`) and keeps its record; then the new top-level page is handled like
  one in a fresh tab. Frames are not: as before, a frame of a later page gets `tab-busy`
  while the tab holds an earlier record. Frame attempts keep ADR 0017's rule: a
  whole-tab navigation ends them `blocked` with outcome `cancelled`. A frame that itself
  moves to another origin does not end its attempt; it ends with the next whole-tab
  navigation or when the tab closes, as before.
- **Leaving the origin after a possible submission ends the attempt.** A top-level
  attempt that may have submitted (any fill or a click that submitted) and sees the
  tab's page move to another origin ends `blocked` with the new outcome `left-origin`.
  Without a possible submission it ends `interrupted`. Neither is `authenticated`, so no
  account choice is saved, and neither is retried. For the logout detection of
  [ADR 0021](0021-account-choice-outside-settings.md) (part D), both count as finished,
  like unknown outcomes.
- **Holding the origin in other tabs** (amended 2026-10-11 and 2026-10-12). Cookies can
  be shared across tabs, so another tab's record of the origin refuses a new attempt
  with `origin-busy` until that tab closes, unless it is `authenticated`, ended
  `interrupted` without any submission, or ended `blocked` because Pateat itself stopped
  it with nothing in flight: `policy-changed`, `value-mismatch`, `wrong-account`,
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
  refused tab's tooltip says that another tab's login holds the site, and is reset when
  the tab logs in ([Background execution](../architecture.md#background-execution)).
- **Generation offers.** ADR 0016's "a page is not offered while its tab holds an
  attempt record" now means a record for the page's own origin.
- The move is noticed only when the new page announces itself, which needs HTTPS, a site
  that is not excluded and site access (ADR 0009). Elsewhere the old attempt keeps
  today's behaviour.

## Alternatives

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
