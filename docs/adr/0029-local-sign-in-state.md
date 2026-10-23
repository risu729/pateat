# ADR 0029: Local sign-in state after an effect step, with the judge as a fallback

Status: accepted by the owner on 2026-10-12 (04:54 UTC). Delivery 1 (the local check,
logged only, as `login.state`) is implemented. The owner started delivery 2 (acting on
it) on 2026-10-12 at 06:58 UTC; its outcome table is implemented (completing on evidence
first, the other rows on 2026-10-12 after 14:22 UTC), and so are the header and
navigation text for the judge, the list of learned markers, and sendable pages with a
token-like path or a field no locator names (owner, 19:23 UTC). Amended on 2026-10-16 by
[ADR 0039](0039-redacted-token-path-segments.md) (owner, 14:10 UTC, implemented): the
`[id]` path rule below applies to every observed page, and a handler may be learned on a
path with `[id]`; see "Pages that could not be sent". Amended on 2026-10-12
(13:08 UTC, owner's choice) by
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge): the pages of a
login watched after `challenge` or an unknown result; see the end of the implementation
notes. Amended on 2026-10-12 by the owner's choice at 20:23 UTC (「入力だけ」, fill
only): a click that would run while S4 shows is left to the person, after Q-move's login
page showed a CAPTCHA before its submission; see S4 below. Amended on 2026-10-12 by the
owner's choice at 21:18 UTC (「AI判定」,
[ADR 0022](0022-login-attempts-per-tab-and-origin.md)): E2 is also read on a page of
another origin of the same site that a `password` login's tab moves to right after the
submission; see the end of the implementation notes. Amended again on 2026-10-13 by the
owner's choice at 01:59 UTC (「コード送信後だけ」, ADR 0022): the same applies to a move
to another site within 30 seconds of a TOTP code, and, by the owner's choice at 03:13
UTC (「同じ扱い」), of a passkey Pateat answered after the password. Amended on
2026-10-13 by the owner's choice at 05:17 UTC (「リンク先で見分ける」): a marker may
name a link by its path; see "Markers that name a link by its path" below. Amended on
2026-10-12 by the owner's choice at 22:03 UTC (「除いて慎重に」, leave out with care): a
disabled field that does not look like a sign-in field is left out of a judged page, and
such a page completes only on `signed-in`, after Q-move's signed-in page was never
judged; see "Disabled fields" in the implementation notes. Amended on 2026-10-12 by the
owner's choice at 22:03 UTC (「誤り表示時」, when it shows an error): a sign-in form
that comes back as the first new document after the submission is rejected when it marks
a failure next to it; see "Signs of a failure" below. Amends
[ADR 0018](0018-recipe-generation-route.md) (how success is decided after a generated
recipe's submission) and [ADR 0027](0027-per-account-login-routes.md) (when a page is
judged). Amended on 2026-10-13 by [ADR 0036](0036-passkey-after-the-identifier.md): for
a login that stops before its item's missing password, E2 is no sign-in, also while
watched and on a move, and an undecided answer ends it `challenge`, watched
(implemented).
Amended on 2026-10-13 by [ADR 0021](0021-account-choice-outside-settings.md) (D, after
the owner's github.com report): the decision is unchanged, but such a form shown again
with its password input and no other sign (no S3, S4, S5 or E sign) stops being watched
once it is confirmed unknown; the tab asks for an account at once (implemented).

Amended on 2026-10-14 (07:24 UTC, owner's decision in
[issue #546](https://github.com/risu729/pateat/issues/546)): an undecided page still
ends the login, but only a confirmed completion counts as success (implemented); see the
amendment below. This also amends ADR 0013, ADR 0021, ADR 0038 and ADR 0007.

Amended on 2026-10-18 (08:05 UTC, owner's decision): the signed-in page of a login its
marker completed is sent as a sample, once in 30 days per recipe and branch; see
[the amendment below](#amendment-signed-in-page-samples-2026-10-18) (implemented, local
tests only). This also amends [ADR 0012](0012-inference-request-log.md) and
[ADR 0016](0016-recipe-generation-trigger.md).

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
  - In the first new top document of the tab after Pateat's own password submission,
    announced within 30 seconds of it, that shows S1 again (the site answered with its
    sign-in page), there is nothing to compare with, so F1 is one of the recipe's
    sign-in fields shown with `aria-invalid="true"`, and F2 is any text of such an
    element next to the sign-in form: inside it, named by one of its fields, or sharing
    a container with it that holds no page header, navigation, footer, dialog or other
    form (owner, 22:03 UTC: an error text, 「エラー文」). A site-wide banner does not
    count. Without F1 or F2 the page stays `unknown`, as before. A message that the
    session expired counts as F2 too (owner's acceptance). Such a page with a recognised
    CAPTCHA (S4: reCAPTCHA, hCaptcha, Turnstile) is never rejected: the site may be
    asking for the CAPTCHA rather than refusing the password. This holds also when the
    login is already watched after the submitted document's own reading; a later
    document, such as the person's own retry, and a page after an `advance` or a passkey
    step are never read this way. Evidence: on GitHub at 21:16:51 UTC the wrong account
    was chosen, Pateat filled and submitted it, and GitHub answered with its sign-in
    page as a new document; Pateat read failures only in the submitted document, so the
    login settled unknown and was watched for 10 minutes instead of ending
    `credential-rejected` (no resubmission, no watch, other tabs held for 5 minutes).
- **Evidence of a sign-in**, any one of:
  - E1: a learned signed-in marker is visible on any path. `completion` becomes a list
    of up to four markers without a path; the judge's markers are added to it.
  - E2: the selected item's username is shown in the page header or navigation
    (`header`, `nav`, `role="banner"`, `role="navigation"`). The username is sent to the
    page's content script for the comparison only and cleared after it, as the
    other-account check does; neither it nor the page text leaves the device. The body
    is excluded because "we sent a link to x@y" or "account locked" pages show it too.
    The username must be a whole word; as ADR 0028 names do, one with a Latin letter
    may touch a letter of another script, such as kana or kanji, at a Latin or digit
    edge (`taro_yさん`). An all-digit one,
    such as a member number, may touch kana or kanji only with 8 digits or more
    (`会員番号12345678さん`); a shorter one there (`会員番号12345さん`, `2026年10月`,
    `残り123件`) is no evidence, so the page goes to the judge (owner, 2026-10-23).
  - E3: the sign-in page's URL had a query value that is a same-origin URL or path
    (any parameter name, such as `return_to=/settings`), and the page after the
    submission is that URL. Values that are `/`, a sign-in path or the page the login
    started from do not count. The query is kept in the attempt on the device only.
- **Outcome**, once the document has finished loading and a short re-check shows the
  same state (so a "redirecting" page or a late second-factor page is not settled):

  | Page | Result |
  | --- | --- |
  | S1 with F1 or F2 | `credential-rejected`; in the first new document after the submission only without S4 |
  | S1 only, or in that new document with S4 | `unknown`, as today; never complete |
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

A sign-in form shown again in a new document (owner, 2026-10-12 22:03 UTC): the
background keeps, with the attempt's last effect step, whether that step submits (a
`submit` fill or click, not an `advance`, not a passkey step) and the first other top
document of the tab announced after it within 30 seconds, the window of a move to
another origin of the site (`SITE_MOVE_MS`, ADR 0022). A document announced later is
never that answer, so a person's own retry minutes after a login settled in place, as on
a code page, never rejects it. When S1 holds in that document after a
submitting step, the background names the route's sign-in elements in its
`login.state` request. The content script reads F1 on those of them that each name one
shown writable input, and F2 on the alerts and status regions inside one of their
forms, named by one of them, or whose nearest common container with a form (or the
input outside any form) is not the body or the root and holds no `header`, `nav`,
`footer`, banner, navigation or content-information landmark, dialog or other form, as
GitHub's flash message beside its sign-in form's body (refined on 2026-10-13, below).
Any mark and any text count. The entry is logged with `reshown`, and the decision is
`rejected` only without S4, then confirmed and acted on as every other row. This also
applies when the submitted document's own reading settled the login as unknown first
(a slow answer: a click's
result settles 3 seconds after it), and when it was watched after `challenge`: a
confirmed rejection there ends the watched login `credential-rejected`. The first new
document alone counts, once per submission. The step and that document are kept in the
background's memory with S5's time, so after a worker restart the form shown again is
read as before and stays unknown. A recipe's learned `rejection` element is checked
before the sign-in state, in any document, as before. While a login is watched, a new
document that shows the recipe's first step on its own path still releases it as after
a logout (ADR 0027) before it is read, so this applies where the site answers on
another path, as GitHub's `/session`. Which ordering GitHub's 21:16:51 UTC login took
cannot be told from the code: within 3 seconds the new document settled it and was the
watch's own page, later the submitted document did; both are covered now.

The neighbourhood of a form shown again, refined (2026-10-13): on GitHub at 03:53 UTC,
on a build with [#436](https://github.com/risu729/pateat/pull/436), a wrong password
showed "Incorrect username or password." beside the form shown again, but `login.state`
logged `unknown` with `reshown` and neither F1 nor F2, and the login ended
`unknown-submit`. The message and the form share the sign-in box, which, as recalled and
not captured, also holds a passkey form and possibly social sign-in forms of buttons and
hidden inputs only, so the rule against another form refused the box. Now another form
keeps a container from counting only when it holds a shown, enabled control to enter a
value in or pick from (any input but a button, check box or hidden one, read-only date
pickers included, a text area, a select or an editable region); a form of buttons,
hidden inputs or check boxes, as a passkey, social sign-in, language or sign-out form,
does not. A container that holds the page's main area (`main` or `role="main"`) does not
count either, so a single-page site's root wrapper around a banner and the page is not
taken for the form's box now that fewer forms rule it out. The body, page chrome and the
CAPTCHA rule are unchanged. That GitHub's page now ends `credential-rejected` has not
been checked on the site.

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

The page behind an open modal dialog (2026-10-13): after a login on 2026-10-13 at 01:57
UTC, the signed-in page (`/`) showed a promotional modal. Its description held only the
title, the modal's heading and the modal's two buttons, with no `headerText` and no
marker, though the person saw the account's name in the page header. The judge
abstained (`insufficient-evidence`), so the login completed with a warning and learned
no marker. Modal libraries (Radix, React Aria, Headless UI, MUI) mark everything beside
the open dialog `aria-hidden="true"` or `inert`, and the extractor's visibility check
read that as hidden; that this site's modal did so is inferred from the code, not read
from the page. Now, while the page has an open modal dialog (a shown element with
`aria-modal="true"` and the role `dialog` or `alertdialog`, or a `<dialog>` opened with
`showModal()`), the signed-in description and E2 do not let such an attribute on an
element beside the dialog, or beside one of its ancestors, hide what it holds. The same
attribute inside the page or inside the dialog still hides, and the page behind must
still render (`checkVisibility`). So E2 can now settle `authenticated` behind an open
modal without the judge, as on the same page without one. The description then carries
the page's header text, headings, fields and possible markers besides the modal's own
controls, which rank right after the header's so the candidate limit never drops them.
The other sign-in signs, the fill checks and the executor are unchanged; S1 to S4 and
E1's `shown` requirement never read these attributes. Known risk: an element the site
itself hid at that level for another reason, such as a closed drawer beside the page's
root, is read too while a modal is open, so its links can become possible markers and
its text header text. A marker learned on such a page is read later as every marker is:
a text locator names no element while the modal is still open, because text locators
compare only shown text, so E1 does not hold there, while an `id`, `name` or
`data-testid` locator does. That matters little: the judge's own `signed-in` completes
the login that learned it, and later logins see the page without the modal or once it is
closed; a modal shown on every visit sends the path to the judge again, which answers
`judged-signed-in`.

The list of learned markers (since 2026-10-12): a recipe's `completion` is a list of up
to four markers, each a locator with up to four `absent` elements and no path. After
every effect step, in a watched login and in E1, a marker that shows once, visible, on
any path while each of its `absent` elements is missing, even hidden, proves the
sign-in, so the completion check and E1 read the same markers. A page the judge answers
`signed-in` for adds its marker after the learned ones in the recipe's next revision,
which a running login takes over; when the recipe has four, or the judge names one it
has, nothing changes and the login completes. A marker is never an element the recipe's
steps, passkey route or handlers use on any path, nor its account switch or rejection
(2026-10-23), since it would then prove a sign-in on their pages. A marker learned on a
step's own path keeps that path's fill fields as `absent` elements, which must now be
missing on every path, so a site that keeps a hidden sign-in form on its signed-in pages
does not complete on that marker. The recipes already stored when this shipped keep
working: on 2026-10-12 at 18:07 UTC the owner chose to rewrite them once, so D1
migration 0013 turns each stored completion into a one-marker list, and leaves out one
whose locator another element of the recipe also uses.

Markers that name a link by its path (owner's choice 「リンク先で見分ける」 on a
decision card, 2026-10-13 05:17 UTC): on the signed-in page's description, a link to the
page's own origin is located by its path (`{ "by": "href", "value": "/my" }`) before its
text, when no other link of the page goes there and the path holds only letters, `-`,
`.`, `_`, `~` and `/`, so it never carries a number, a numeric or random ID or a
percent-encoded name, and no segment may be a token. No segment, with or without what
may be a file extension, may fold (letters and numbers only, lower-cased) to the link's
text, or to a word or two neighbouring words of the page's header either, so a handle or
name the page shows, as in `/taro_y/likes` beside "@taro_y" or `/taro-y` beside "Taro
Y", falls back to the link's text. A generic header word blocks a path too (`/account`
beside "Account security"); such a word usually gives its own link a text marker. A
handle the page never shows can still pass; the judge is told never to pick a path that
names the person. A link with an empty or fragment-only `href` (`#top`) and a script
link have no path. Its query and fragment are not
compared. Like a text marker such as "マイページ", a path marker is only as good as the
judge's choice: a site that shows the same link to `/my` signed out would match it
there too, unless an `absent` element was learned. The judge may
name such a link as the marker, and the executor's E1 and completion checks find it as
the one link to that path. Only markers take it: a recipe's steps, handlers, `absent`
elements, rejection and account switch never do, and a step's plan, an account list's
controls, a sign-in entry and a judged code page's button refuse a candidate located
that way. Evidence: on ニコニコ at 04:57 UTC the page a TOTP login moved to,
`www.nicovideo.jp/`, was signed in, but the judge answered `unclear` and the login ended
`left-origin`. The only signed-in control the RC's probe found at 05:13 UTC was the
header link to `/my`, whose text is the person's nickname, which no marker may hold; its
header is plain `div`s, and it has no sign-out link. The judge's instructions now say
that a link by `href` is stored with its path, which must read the same for every
account, so the prompt version changed and pages judged before are judged again.

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
inferred from its path. Amended on 2026-10-16 by
[ADR 0039](0039-redacted-token-path-segments.md): every observed page now carries `[id]`
the same way, a login page with such a path is no longer refused, and since the
extension compares a live page through the same redacted path, a page on a path with
`[id]` may get a handler.

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
included, ends it `left-origin` as before (ADR 0022). The same reading and judgement
apply to a move to an HTTPS origin of another site within 30 seconds of a TOTP code the
login submitted (owner, 2026-10-13 01:59 UTC) or of a passkey Pateat answered after the
password (03:13 UTC), never right after the password step. The
service keeps such a page's
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

## Amendment: unconfirmed completion (2026-10-14)

The owner chose on 2026-10-14 at 07:24 UTC: "the login still ends as today, but it is
not counted as a success"
([issue #546](https://github.com/risu729/pateat/issues/546)). This replaces the success
consequences of the earlier no-S-no-E decision; the accepted text above is retained
as history.

The current outcome table replaces the no-S-no-E row with:

| Page | Result | Confirmed |
| --- | --- | --- |
| No S, no E; judge `signed-in` | `authenticated`, adding its marker | Yes |
| No S, no E; `unclear` with `judged-signed-in` | `authenticated`, after the existing re-reading and omission guards | Yes |
| No S, no E; `unclear` with no reason, `already-judged`, `judgement-limit`, `daily-limit` or `monthly-limit` | `authenticated`, with `unconfirmed: true`, after the same guards | No |
| No S, no E; `rejected`, `challenge`, other `unclear`, or `retry` | The existing rejection, challenge, unknown or retry outcome | No completion |

The other rows and the move and missing-password stop rules are unchanged. A move
still completes only on `signed-in` or `judged-signed-in`, both confirmed.

The first Consequences paragraph now applies as follows: every completion still stops
automation, releases the site to other tabs and treats the sign-in page showing again
as a logout. Only confirmed completion saves the pending account choice
([ADR 0021](0021-account-choice-outside-settings.md)). An unconfirmed completion drops
that choice, shows the yellow unsettled badge and says in the popup that the sign-in
could not be confirmed ([ADR 0038](0038-login-status-badge.md)); it does not record
"Pateat signed in here" for registration refusal
([ADR 0007](0007-existing-passkey-assertions.md)). The warn-level `recipe.judge` entry
stays, and `login.attempt` carries `unconfirmed`. The attempt and popup status retain
that flag across a worker restart. Synthetic tests verify these distinctions; no new
real-account verification is claimed.

## Amendment: signed-in page samples (2026-10-18)

Context: E2 and the page text never left the device for a page that was not judged, so
the request log ([ADR 0012](0012-inference-request-log.md)) held only pages the model
found hard. An evaluation corpus also needs pages that are easy for it.

The owner chose on a decision card on 2026-10-18 at 08:05 UTC, asked "2
回目以降のログインのページも送って残しますか?", the option "絞って入れる", whose stated
consequence was "レシピのパスごとに 30 日に 1
回だけ、サインイン後のページを抽き出して送ります。ADR 0029 を改めます。" (once in 30
days per recipe path, the page after the sign-in is extracted and sent; ADR 0029 is
amended).

What leaves the device, and how often:

- After a login whose recipe's signed-in marker completed it (the completion check after
  an effect step), the page it ended on is described exactly as for the judge: the same
  extractor and redaction, `headerText`, the account's usernames hidden as `[account]`
  ([ADR 0016](0016-recipe-generation-trigger.md#username-shape)), complete descriptions
  only. A page the judge would not get (`username-shown`, `username-unread`, an
  incomplete description) is not sent. E2's username comparison itself still never
  leaves the device.
- At most once in 30 days (`PAGE_SAMPLE_INTERVAL_MS`) per service, device, recipe and
  chooser branch, recorded on the device before the request; the service keeps at most
  one per owner, recipe and branch in 30 days and answers a later one 204 without a row.
- It goes in the background after the login ended and never changes the login, its
  badge or its timing. The service logs it as a `judge` row with the outcome `sampled`,
  the request built as the judge's would be (the judge route answers such a page
  `not-judgeable` and never sends it), no model call and no cost.

The agent's choices, not confirmed by the owner: "per recipe path" is read as per recipe
and chooser branch; the route `POST /v1/recipes/:recipeId/page-sample` (with `route`, as
the judge is told it, so the logged request has its login paths); the device key
`pateat.page-samples.v1`, capped at 200 entries; the `recipe.sample` log event; and, to
stay conservative, no sample for a login that sent a page to the judge or for
continuation, was watched or settled as unknown before, ended through E1 to E3 rather
than the completion check, ran in a frame, filled only, stops at a missing password
(ADR 0036), ended on another origin, or whose page left out a disabled field, nor for a
site excluded since the login started (checked when the page is described and again
after the sample is recorded, just before it is sent; a sample stopped then stays
recorded), an unpaired device, or a page that changed before it was described. The
service refuses (400, no row) a page that still shows one of the password route's fill
fields, as the judge does, so a sign-in page never holds off the recipe's next sample.
The sampled rows do not count toward the service's daily cap of 500 rows answered
without a model call, and that cap does not stop them: the 30-day rule already bounds
them to one per recipe and branch.
