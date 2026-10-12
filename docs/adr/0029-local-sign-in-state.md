# ADR 0029: Local sign-in state after an effect step, with the judge as a fallback

Status: accepted by the owner on 2026-10-12 (04:54 UTC). Delivery 1 (the local check,
logged only, as `login.state`) is implemented. The owner started delivery 2 (acting on
it) on 2026-10-12 at 06:58 UTC; its first part, completing on evidence, is implemented.
Amends [ADR 0018](0018-recipe-generation-route.md) (how success is decided after a
generated recipe's submission) and [ADR 0027](0027-per-account-login-routes.md) (when a
page is judged).

Date: 2026-10-12

## Context

After a step with an effect, the login runtime checks, in order: the recipe's
`completion` marker on its path, its `rejection` element, the plan's next step
(including an `advance` that continues on the same path), a held click while a passkey
prompt or chooser is open, and a learned handler (`totp`, `passkey`) on the page. When
none explains the page, it is sent to the sign-in judge (ADR 0018, ADR 0027), at most
two pages per step, once per recipe revision and path, and 20 times per recipe a day.
Until the judge says `signed-in`, a generated recipe has no `completion`, and an
unexplained page leaves the attempt `unknown`, so the tab keeps holding the site.

Logins in the owner's Chrome on 2026-10-12 showed the limits of that:

- ポイントインカム: the judge answered `unclear` because the description held no account
  link (fixed in [#258](https://github.com/risu729/pateat/pull/258)); its path is now
  judged and is never judged again for that revision.
- アパホテル: the page after the login was never sent because it could not be described
  completely (the reason is now logged,
  [#264](https://github.com/risu729/pateat/pull/264)).
- GitHub: the optional "Verify your two-factor authentication settings" page was
  judged `challenge`, though the person was signed in.

The owner proposed (2026-10-12 03:33 and 04:40 UTC) to ask whether authentication is
still going on, and whether the page shows a failure, rather than whether the page
proves a sign-in; to keep the judge as a fallback for cost; and, when nothing can
decide, to treat the login as complete. Reopening the login URL to check for a redirect
was rejected (03:35 UTC): it disturbs the person using the site.

## Decision

The owner chose these on 2026-10-12 (proposal reviewed against the code by a subagent,
then answered 04:51 and 04:54 UTC):

- **Only the unexplained page changes.** The checks above, the passkey route (anything
  unproven ends `challenge`) and frames ([ADR 0017](0017-login-forms-in-frames.md))
  keep their behaviour. The new check replaces the step that sends an unexplained page
  to the judge.
- **Signs that authentication goes on**, read from the top document, in any language:
  - S1: one of the recipe's sign-in fields is visible.
  - S2: a visible password field, except one with `autocomplete="new-password"` and the
    password fields of a form with two or more of them (a password change or
    registration form, where the current password must never go).
  - S3: a code field (`isCodeField`: `one-time-code`, or a group of one-digit boxes).
  - S4: a visible CAPTCHA widget, recognised by the reCAPTCHA, hCaptcha or Turnstile
    frame origin; invisible ones do not count.
  - S5: the page requested a passkey after the submission, outside conditional
    mediation, in the top frame.
- **Signs of a failure**, only while S1 holds and the document is the one that was
  submitted: F1, a sign-in field gained `aria-invalid="true"`; F2, an element with
  `role="alert"` or `aria-live` shows new text. Text is compared inside the page only,
  as the fill check (`rejectsFill` in `apps/extension/src/page/fill-checks.ts`) does,
  and never leaves the device.
- **Evidence of a sign-in**, any one of:
  - E1: a learned signed-in marker is visible on any path. `completion` becomes a list
    of up to four markers without a path; the judge's markers are added to it.
  - E2: the selected item's username is shown in the page header or navigation
    (`header`, `nav`, `role="banner"`, `role="navigation"`). The username is sent to the
    page's content script for the comparison only and cleared after it, as the
    other-account check does; neither it nor the page text leaves the device. The body
    is excluded because "we sent a link to x@y" or "account locked" pages show it too.
  - E3: the sign-in page's URL had a query value that is a same-origin URL or path
    (any parameter name, such as `return_to=/settings`), and the page after the
    submission is that URL. Values that are `/`, a sign-in path or the page the login
    started from do not count. The query is kept in the attempt on the device only.
- **Outcome**, once the document has finished loading and a short re-check shows the
  same state (so a "redirecting" page or a late second-factor page is not settled):

  | Page | Result |
  | --- | --- |
  | S1 with F1 or F2 | `credential-rejected` |
  | S1 only | `unknown`, as today; never complete |
  | S2 to S5, no S1 | authentication goes on: the judge is asked so a handler can be learned, as today; undecided goes to the person (`challenge`) |
  | No S, any E | `authenticated`, without a model call |
  | No S, no E | the judge is asked once for the path; `signed-in` completes and adds its marker, `rejected` rejects; `unclear`, `already-judged` and the daily limits complete with a warn-level log; `retry` (busy, transport) asks again on the next page as today |

- **More page text for the judge.** The signed-in description gains the visible text of
  the header and navigation, up to 1,000 characters, as a new field, with email
  addresses and long numbers still redacted. The owner allowed this while Pateat is for
  their own use (04:51 UTC); what is sent is decided again before the public release
  (phase 3).
- **Failure markers are not stored yet.** The judge returns no element for `rejected`,
  and error text is not among the observed candidates, so learning one needs other
  changes. If sites that fail silently back to their top page show up in the warn logs,
  this is proposed again.
- **Delivery 1 logs only.** The extension computes the result and logs it next to what
  happens today (the judge's verdict when it is asked), and nothing changes in
  behaviour. The owner reviews the logs from the daily-site passes, then delivery 2
  switches the runtime to this order.

## Implementation notes

Delivery 1 (2026-10-12) reads the page once, when the attempt's result would settle as
unknown today (3 seconds after a submission, 10 after an advance), just before the judge
is asked; the re-check comes with delivery 2. It writes one `login.state` entry with the
signs that show and the ADR's outcome ([architecture](../architecture.md)). A login in a
frame is not read. The sign-in page's URL for E3 is the URL of the document the
attempt's first fill ran in, compared with the document's current path, so a single-page
site's route change after the submission counts. It and S5's times are kept in the
background's memory, so a worker restart during the login leaves E3 and S5 unread; a
login with no fill, as on the `passkey` route, has no E3. For S5 the passkey bridge
tells the login of each request of a top document that is not for conditional mediation,
whether Pateat answers it or leaves it to the browser; one at or after the time the step
was sent to the page counts, except after a step that asks for a passkey itself (the
`passkey` route, or a `passkey` handler's click). S2 counts only shown password inputs
for the two-or-more rule, and inputs outside any form as one form. F1 reads the step's
sign-in inputs (the ones it filled, or those of the form it clicked in); F2 reads alerts
anywhere and status regions inside a sign-in input's form or named by one, as the fill
check does, skipping a region around a sign-in input and the text of buttons inside a
region.

Delivery 2, first part (2026-10-12): the owner chose, after reading the delivery 1 logs
of アパホテル, to complete a login whose `login.state` decision is `signed-in`. There,
at 06:29:50 UTC, the learned marker showed (E1) but the recipe's completion check did
not pass (`recipe.judge not-sent marker-shown`), so the attempt stayed unknown; when the
sign-in form showed again after a sign-out, the sign-out check of ADR 0021 did not apply
to the unknown attempt and Pateat signed in again. Now a `signed-in` reading is read a
second time one second later in the same document; the login completes as
`authenticated`, with no model call, only when that reading is `signed-in` too and the
document has finished loading (`document.readyState` is `complete`). Otherwise the
second reading is logged and the page goes on as before (to the judge, or unknown). Only
one `login.state` entry is logged, from the last reading. This applies on both routes
and to a later page of an attempt that already settled as unknown. The other rows of the
outcome table still only log.

## Consequences

- Completing a login saves the account the person picked in this attempt as the site's
  default, releases the site to other tabs, and treats the sign-in page showing again
  as a sign-out. A false completion therefore lets other tabs repeat a failed login.
  The no-S-no-E row keeps the judge for exactly that case, and its undecided outcomes
  are logged as warnings so such sites can be found.
- A page after the sign-in that shows a password or short numeric field the rules count
  costs a judge call instead of completing.
- Sites that redirect to the page the person came from need no per-path marker.
- The judge is asked mostly on the first logins of a site; once a marker is learned it
  applies on every path.

## Alternatives

- Judge every unexplained page (today): pages the judge cannot decide stay `unknown`,
  and an optional prompt such as GitHub's 2FA check stops the login.
- Decide locally first and treat any page without a sign-in field as complete: no model
  calls, but a silent failure to the top page would complete.
- Compare with the page the person was on before the login: rejected, because a login
  that started on the top page cannot tell success from a failure that returns there.
- Reopen the login URL to see whether it redirects: rejected by the owner.
