# ADR 0022: Login attempt records per tab and origin

Status: accepted by the owner on 2026-10-11 (11:42 UTC) as a bug fix and implemented in
the PR that adds this record. Amends [ADR 0016](0016-recipe-generation-trigger.md)
(which tabs may offer a page) and [ADR 0017](0017-login-forms-in-frames.md) (one attempt
per tab). Tested on synthetic fixtures only; no real site or account has been used.

Date: 2026-10-11

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
  starts only when the tab has no record for that origin. Returning to an origin the tab
  already tried therefore never submits again, which keeps a loop such as site →
  identity provider error → site → identity provider from resubmitting credentials. The
  `account-switched` exception of ADR 0016 stays.
- **A tab still runs one attempt at a time.** When a new top-level page of another
  origin arrives while the tab's top-level attempt has not ended, that attempt ends
  first (`NAVIGATED`) and keeps its record; then the new page is handled like a page in
  a fresh tab. Frame attempts keep ADR 0017's rule: a whole-tab navigation ends them
  `blocked` with outcome `cancelled`.
- **Leaving the origin after a possible submission ends the attempt.** A top-level
  attempt that may have submitted (any fill or a click that submitted) and sees the
  tab's page move to another origin ends `blocked` with the new outcome `left-origin`.
  Without a possible submission it ends `interrupted`. Neither is `authenticated`, so no
  account choice is saved, and neither is retried.
- **The origin hold is unchanged.** A record of an origin in another tab, in any state,
  still refuses a new attempt there with `origin-busy` until that tab closes
  ([Background execution](../architecture.md#background-execution)).
- **Generation offers.** ADR 0016's "a page is not offered while its tab holds an
  attempt record" now means a record for the page's own origin.
- The move is noticed only when the new page announces itself, which needs HTTPS, a site
  that is not excluded and site access (ADR 0009). Elsewhere the old attempt keeps
  today's behaviour.

## Alternatives

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
