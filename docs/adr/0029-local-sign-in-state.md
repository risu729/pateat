# ADR 0029: Local sign-in state after an effect step, with the judge as a fallback

Status: accepted by the owner on 2026-10-12 (04:54 UTC). Delivery 1 (the local check,
logged only, as `login.state`) is implemented. The owner started delivery 2 (acting on
it) on 2026-10-12 at 06:58 UTC; its outcome table is implemented (completing on
evidence first, the other rows on 2026-10-12 after 14:22 UTC), and so are the header and
navigation text for the judge, the list of learned markers, and sendable pages with a
token-like path or a field no locator names (owner, 19:23 UTC).
Amended on 2026-10-12 (13:08 UTC, owner's choice) by
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge): the pages of a
login watched after `challenge` or an unknown result; see the end of the implementation
notes.
Amended on 2026-10-12 by the owner's choice at 20:23 UTC (「入力だけ」, fill only): a
click that would run while S4 shows is left to the person, after Q-move's login page
showed a CAPTCHA before its submission; see S4 below.
Amended on 2026-10-12 by the owner's choice at 21:18 UTC (「AI判定」,
[ADR 0022](0022-login-attempts-per-tab-and-origin.md)): E2 is also read on a page of
another origin of the same site that a `password` login's tab moves to right after the
submission; see the end of the implementation notes.
Amended on 2026-10-12 by the owner's choice at 22:03 UTC (「除いて慎重に」, leave out
with care): a disabled field that does not look like a sign-in field is left out of a
judged page, and such a page completes only on `signed-in`, after Q-move's signed-in
page was never judged; see "Disabled fields" in the implementation notes.
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
two pages per step, once per recipe revision, path and judge prompt version, and 20
times per recipe a day.
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
  - S1: one of the recipe's sign-in fields is visible. Only an input of a kind Pateat
    fills counts as a field: on 2026-10-12 Wise's signed-in page gave the password
    field's React ID to an empty `div`, which was read as the field. The passkey route's
    button counts when visible, as before.
  - S2: a visible password field, except one with `autocomplete="new-password"` and the
    password fields of a form with two or more of them (a password change or
    registration form, where the current password must never go).
  - S3: a code field (`isCodeField`: `one-time-code`, or a group of one-digit boxes).
  - S4: a visible CAPTCHA widget, recognised by the reCAPTCHA, hCaptcha or Turnstile
    frame origin; invisible ones do not count. Pateat does not solve CAPTCHAs
    ([plan](../plan.md)). When S4 shows in the document as a click step is about to run,
    and no token field of those services (`g-recaptcha-response`, `h-captcha-response`,
    `cf-turnstile-response`) holds a token yet, the form stays filled and the button is
    not pressed (owner, 20:23 UTC): the person
    solves the CAPTCHA and presses it. The login then waits as for a held click
    ([ADR 0027](0027-per-account-login-routes.md)): while the button shows, the page is
    neither judged nor settled for up to two minutes, then the login ends `challenge`,
    watched as below; once the person's press moves the page on, it is read as after
    Pateat's own click. A rejection already shown is not taken as the person's. A
    chooser's click on its list is not held.
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
  addresses and every number hidden as on the rest of that page (owner, 2026-10-12).
  The owner allowed this while Pateat is for their own use (04:51 UTC); what is sent is
  decided again before the public release (phase 3).
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
unknown today (3 seconds after a submission, 10 after an advance; after an answer to the
page's own passkey request, not before 15 seconds pass while the page is on its start
path, or two minutes while it shows nothing to describe there:
[ADR 0034](0034-answer-page-passkey-requests.md)), just before the judge
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
to the unknown attempt and Pateat signed in again. Now a `signed-in` reading is read
again a second later in the same document, and again a second apart while the document
is still loading, at most ten times; the login completes as `authenticated`, with no
model call, once such a reading is `signed-in` in a document that has finished loading
(`document.readyState` is `complete`). Otherwise the last reading is logged and the page
goes on as before (to the judge, or unknown). Only one `login.state` entry is logged,
from the last reading. It applies to a later page of an attempt that already settled as
unknown too. On the `passkey` route the reading is still only logged, since the decision
above keeps that route's rule that anything its checks do not prove ends `challenge`. E1
does not count on the completion's own path while one of the completion's `absent`
elements is there, even hidden, as the completion check counts it: a sign-in form that
hides itself again after a failure on that path is not a sign-in.

The other rows act since 2026-10-12, on the `password` route only (the `passkey` route
still logs them). Every decision but S1 alone is acted on only once a reading a second
later agrees in the fully loaded document, read again while it loads as for evidence;
otherwise the page is judged and settles as before. S1 with F1 or F2 ends the login
`credential-rejected` without a model call. A page with S2 to S5 and no S1 is judged as
before; when the judge does not decide, the login ends `challenge`, and when the page is
not sent it stays unknown. A page with no sign and no evidence is judged, and the login
completes when the judge cannot decide: the model abstains (`unclear` with no reason),
the path was judged before (`already-judged`, `judged-signed-in`), or a limit applies
(`judgement-limit`, `daily-limit`, `monthly-limit`), and the page still shows no sign
and no evidence once the answer is back in the loaded document, unless its description
left out a disabled field (below). Its `recipe.judge` entry is then a warning marked
`completed`. A failed request, a conflict, a missing service or a page that cannot be
described or was not sent leaves the login unknown, as before. The service keeps the
model's verdict on the path's judgement row (`page_judgements.verdict`, `unclear` when
it abstained) and answers a later request for that revision, origin and path
`judged-signed-in` after `signed-in` and `already-judged` after `unclear`; both complete
the login here. After `challenge` or `rejected` it
answers `judged-challenge` or `judged-rejected`: the login then ends `challenge`, or
stays unknown after `judged-rejected`, since an earlier rejection does not prove this
one. A row with no verdict, after the request failed or while it is still being judged
once the owner's lock has expired (until then a second request is answered `busy`),
answers `judgement-unanswered`, and the login stays unknown. A watched login (below)
never completes on an undecided answer.

The header and navigation text (since 2026-10-12): the signed-in description carries
`headerText`, the visible text of each outermost `header`, `nav`, banner and navigation
landmark in document order, with email addresses, masked runs and every number hidden as
on the rest of that page, the account's own usernames hidden as `[account]`, and cut at
1,000 characters. The judge's instructions name it as untrusted page text. Login pages,
lists of accounts and sign-in entry pages never carry it.

The list of learned markers (since 2026-10-12): a recipe's `completion` is a list of up
to four markers, each a locator with up to four `absent` elements and no path. After
every effect step, in a watched login and in E1, a marker that shows once, visible, on
any path while each of its `absent` elements is missing, even hidden, proves the
sign-in, so the completion check and E1 read the same markers. A page the judge answers
`signed-in` for adds its marker after the learned ones in the recipe's next revision,
which a running login takes over; when the recipe has four, or the judge names one it
has, nothing changes and the login completes. A marker is never an element the recipe's
steps, passkey route or handlers use on any path, since it would then prove a sign-in on
their pages. A marker learned on a step's own path keeps that path's fill fields as
`absent` elements, which must now be missing on every path, so a site that keeps a
hidden sign-in form on its signed-in pages does not complete on that marker. The recipes
already stored when this shipped keep working: on 2026-10-12 at 18:07 UTC the owner
chose to rewrite them once, so D1 migration 0013 turns each stored completion into a
one-marker list, and leaves out one whose locator another element of the recipe also
uses.

Pages that could not be sent (owner, 2026-10-12 19:23 UTC): logins on Cloudflare,
Grafana Cloud and Wise really signed in on build `a8350f5`, and on JP BANKカードWEB on
`206f2a0` (an optional password change page), but every page after the submission was
logged `recipe.judge not-sent` (`unsupported-page` on Cloudflare's `/<account ID>/home`,
`unlocated-field` on the others), so each login stayed unknown. The owner chose to make
such pages sendable rather than complete without the judge: the judged page's path
carries `[id]` in place of each segment that may hold a token (the rule that refuses
such a path on a login page), and a field that no locator can name is left out unless it
may be a sign-in field, as a read-only one is. A password field counts as one unless S2
would skip it (a new password, or a form with two or more password fields). A page on a
path with `[id]` never gets a handler, since the handler's path would match no page; its
signed-in markers have no path and are learned as on any page. Pages that differ only in
such a segment share one judgement row, and a locator on a judged page never uses an
attribute value that may be a token. Since a sign-in field left out of the description
could no longer be seen by the service, a page where S1 holds, on any path, is not sent
to the judge. Which field was unlocated on each site is inferred; Cloudflare's reason is
inferred from its path.

Disabled fields (owner, 2026-10-12 22:03 UTC, 「除いて慎重に」): on 2026-10-12 at 21:29
UTC, after the owner solved Q-move's CAPTCHA and signed in, its history page had a
disabled field that does not look like a sign-in field. The page was logged
`recipe.judge not-sent` `disabled-field`, never judged, and the login recorded no
completion; which field it was is inferred. The owner chose to leave such a field out of
the description and judge the page, but such a page then completes only when the judge
answers `signed-in`. `unclear` with no reason, `already-judged` or a limit leaves the
login unknown there, as a page that was not sent would, since a code page whose code
field stays disabled until the code is sent could otherwise complete.
`rejected` and `challenge` act as on any page. A disabled field that may be a sign-in
field, by the rule for read-only ones (a password or email input, one with any
autocomplete token the description carries other than `off`, such as `username`,
`one-time-code` or a personal-data token such as `tel`, or a short numeric field), still
keeps the page from the judge (`unfillable-field`). The description itself is unchanged;
the request says that a field was left out (`partial`). The service keeps a `signed-in`,
`challenge` or `rejected` verdict for such a page as for any page, but stores an
abstention as `partial` rather than `unclear`: a later login whose page leaves the field
out again gets `already-judged`, which never completes it, and a page of the path
described in full is judged again, within the daily limits, so that page cannot complete
on the earlier abstention once the code field is enabled. Each `recipe.judge` entry of
such a page carries `disabledLeftOut`, and an undecided answer that would otherwise have
completed the login is a warning marked `notCompleted` `disabled-left-out`. Not chosen:
leaving such fields out and letting an undecided answer complete (the code page above),
showing them to the judge marked disabled (a larger change of the description and the
judge's instructions, and pages judged again), and keeping such pages from the judge.

Watched logins (owner, 2026-10-12 13:08 UTC,
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)): Evidence: on
三菱UFJ銀行 the app-approval QR page after the password shows none of S1 to S5, so it
falls in the "No S, no E" row, and the judge answered `challenge`. The pages after such
a `challenge`, and after a result settled as unknown, are read for 10 minutes. A watched
`challenge` login's page is judged only in the "No S, no E" row, and there `unclear`,
`already-judged` and the limits never complete it, unlike the row above. A path the
judge answered `challenge` for in a recipe revision is never completed by a later
request for it (`judged-challenge`, above), so the second login on 三菱UFJ銀行 does not
complete on its QR page.

Moves to another origin of the site (owner, 2026-10-12 21:18 UTC,
[ADR 0022](0022-login-attempts-per-tab-and-origin.md)): on モッピー the page after the
password is on another host of the site, which ended the login `left-origin` before
these signs were read. When a top-level `password` login's tab moves to another HTTPS
origin of its registrable domain within 30 seconds of its last effect step, the new top
page is read for S2 to S5 and E2 only, with the username sent as above, and the login
completes when two readings a second apart in the loaded document show E2 and none of
those signs. S1, F1, F2 and E3 are not read there, and no `login.state` entry is
logged. A page that shows none of those signs but not E2 is checked for E1 with the
markers learned on its origin only, and otherwise judged once; `signed-in` completes the
login and learns a marker for that origin, and anything else, an undecided answer
included, ends it `left-origin` as before (ADR 0022). The service keeps such a page's
judgement row under its own origin, and answers a later request for a row judged
`signed-in` with `judged-signed-in` instead of `already-judged`, which the "No S, no E"
row above treats as before.

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
