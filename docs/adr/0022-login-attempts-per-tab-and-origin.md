# ADR 0022: Login attempt records per tab and origin

Status: accepted by the owner on 2026-10-11 (11:42 UTC) as a bug fix and implemented in
the PR that adds this record. Amends [ADR 0016](0016-recipe-generation-trigger.md)
(which tabs may offer a page) and [ADR 0017](0017-login-forms-in-frames.md) (one attempt
per tab). Tested on synthetic fixtures only; no real site or account has been used.
Amended on 2026-10-13 by [ADR 0036](0036-passkey-after-the-identifier.md) (moves of a
login that stops before its item's missing password; implemented). Amended on 2026-10-13
by [ADR 0021](0021-account-choice-outside-settings.md) (D, after the owner's github.com
report): a top-level password login whose site answers with its sign-in form again, or
that ends `credential-rejected`, is released as after a logout in its page, so other
tabs of the site ask instead of being held; none submits by itself (implemented).
Amended on 2026-10-13 (after the owner's 「全部進めて」 at 06:58 UTC, as a bug fix): a
new page that goes away before its quiet readings does not end a moved login, and a move
that does not complete is logged with why. Evidence: on Oracle Cloud a login whose
passkey second factor Pateat answered at 06:48:12 UTC ended `left-origin` 7 ms after its
sign-in page went away, with no judgement of the console it reached; that a redirect
page caused it is inferred. Amended on 2026-10-13 (owner's choice 「完了扱い」 on a
decision card at 13:54 UTC): a passkey that Pateat answers, with the login's own item,
on a page of another origin of the site that the tab moved to and that asked for it lets
the tab's next page complete the login; see "A move after a passkey answer". Evidence:
in the owner's Chrome on `4deb95d` at 08:51 UTC, an OpenAI Platform login pressed the
remembered account's row on `platform.openai.com`, the tab moved to
`auth.openai.com/auth_challenge/passkey`, which asked for a passkey, and the login ended
`left-origin` there; Pateat then answered that request outside the login, and the tab
came back to `platform.openai.com/auth/callback` signed in. Which item answered was not
recorded.

Amended on 2026-10-23 by [ADR 0062](0062-log-in-again-after-a-logout.md) (accepted
and implemented): a released record is followed by an ordinary login instead of asking,
except after a rejection, a stopped login or an abandoned watch, which ask and fill the
page once without pressing; a third automatic login of a site within 10 minutes asks
(`relogin-limit`).

Date: 2026-10-11

Amended on 2026-10-11 (18:27 UTC, owner's choice in the thread): a finished login in
another tab no longer holds the origin; see "Holding the origin in other tabs" below.
Amended again on 2026-10-12 (02:42 UTC, owner's choice on a decision card): a login
Pateat itself stopped no longer holds the origin either. Evidence: in the owner's Chrome
a `policy-changed` record from a transient vault error kept a new npm tab from logging
in for 8 hours, across an extension reload. Amended again on 2026-10-12 (05:08 UTC,
owner's choice in the thread after a decision card): a record that still holds the
origin stops holding it 5 minutes after it last changed. Evidence: in the owner's Chrome
a github.com login that had succeeded after a passkey step stayed `reconciling` with an
unknown result in one tab, so a pick in another tab was refused `origin-busy` until that
tab would close. Amended on 2026-10-12 (05:41 UTC, owner's request in the project chat):
a tab that moves to another site starts clean there, also for a login form in a frame;
see "A tab still runs one attempt at a time" below. Amended again on 2026-10-12 (bug fix
applying the 02:42 UTC choice to the stopped tab itself): a login Pateat itself stopped
with nothing in flight and before any submission no longer holds its own tab either.
Evidence: in the owner's Chrome, removing github.com's saved default stopped that tab's
login as `policy-changed`; after a reload the page was refused for several matching
accounts, but it had resumed the stopped record, so the toolbar popup offered no account
choice and the tab never logged in again until it was closed. Amended again on
2026-10-12 (08:22 UTC, owner's choice on a decision card, proposal in the project notes
`jal-same-site-completion-proposal.md`): a move to the site of a passkey Pateat has just
answered completes the attempt; see "Leaving the origin after a possible submission ends
the attempt" below. Evidence: in the owner's Chrome, JMB's sign-in page
`jallogin.jal.co.jp` asked for a passkey after the username step, Pateat answered, and
the site moved to `www.jal.co.jp` signed in, but the login ended `left-origin`, so it
held the site for 5 minutes and saved no account choice. Amended again on 2026-10-12
(13:08 UTC, owner's choice on a decision card, recorded in
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)): a top-level
`password` login that ends `challenge` or settles as unknown is watched for 10 minutes.
A `challenge` login then waits as `watching`, which holds the origin like `challenge`
did, for 5 minutes after the record last changed; a page judged during the watch is not
a change. Completing during the watch releases the origin, and the end of the watch
keeps the record's last change time. During the watch, the recipe's first step showing
in a page of another tab of the site, first seen after the watch began, releases the
watched record as a logout (ADR 0021 D), so that tab asks and fills without pressing
anything instead of being refused `origin-busy` (owner's request, 13:49 UTC, after the
person restarted an expired QR approval on 三菱UFJ銀行 and Pateat did nothing until the
old tab closed; on 2026-10-13 this became the end of the watch without a logout, so that
tab logs in as before,
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge); since
2026-10-23 the watched login holds the site for its whole watch instead, and no hold
crosses between incognito and normal windows). Amended again
on 2026-10-12 (21:18 UTC, owner's choice 「AI判定」 on a decision card): a `password`
login whose tab moves to another origin of the same site right after the submission
completes when the new page shows the account's username,
and, as the next change, the judge decides once when it does not; see "Leaving the
origin after a possible submission ends the attempt" below. Evidence: on モッピー at
20:52 UTC Pateat submitted the password on `ssl.pc.moppy.jp`, the site moved the tab to
the signed-in `pc.moppy.jp`, and the login ended `left-origin`, so it saved no account
choice and held the site in other tabs for 5 minutes. The judge for a page without the
username was implemented as that choice's second delivery (2026-10-12). Amended again on
2026-10-13 (01:59 UTC, owner's choice 「コード送信後だけ」 on a decision card; confirmed
in the thread at 02:25 UTC): the same check also completes a move to another site, but
only right after a TOTP code was submitted; see "A move to another site after a second
factor" below. Evidence: in the Grok Bot's browser at 22:05:05 UTC on 2026-10-12, Pateat
submitted a TOTP handler's code on `login.microsoftonline.com`, the site moved the tab
to the signed-in `m365.cloud.microsoft` two seconds later, and the login ended
`left-origin`, so it saved no account choice and held the sign-in page in other tabs for
5 minutes. Amended again on 2026-10-13 (03:13 UTC, owner's choice 「同じ扱い」 on a
decision card; confirmed in the thread at 03:30 UTC): a passkey Pateat answered as the
second factor after the password counts like a TOTP code there. Evidence: on Oracle
Cloud at 02:59 UTC, Pateat answered the security key request that followed the password,
the tab moved to the signed-in `cloud.oracle.com` of another site 3 seconds later, and
the login ended `left-origin`.

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
  - **Nothing submitted** (amended 2026-10-23). A fill whose failure confirmed it
    changed nothing, waiting to be tried again, is no possible submission. A `password`
    login still at its first step that has submitted nothing and has nothing in flight
    that may have, when a new page of its origin shows or the worker restarts, does not
    settle as unknown when the reconcile budget runs out: the page goes on at that step
    as one that does not show it yet, left to the step's own wait and retries. After any
    fill the person may have submitted the values themselves, so such a page still
    settles as unknown and is watched; so does an advance fill waiting to be tried
    again, which this would take past its step, and a login with a stop or on the
    `passkey` route ends as before.
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
    runs), and one that announces during the readings waits for them. A new top page
    that goes away before its quiet readings answer, as a redirect through another page
    does, is not where the move ended (2026-10-13): the attempt is kept, as before any
    new page announced, and the tab's next top page is read instead; it must still come
    within the same 30 seconds of the step or answer. A page that goes away while it is
    judged still ends the attempt as above. Nor is a new top page of another HTTPS
    origin of the attempt's registrable domain (as for a move after a password
    submission, below) that asks for a passkey after the attempt's last effect step, at
    most 30 seconds after it (2026-10-13, owner's 「完了扱い」): the attempt is kept,
    logged as `passkey-request` with `kept`, and that page starts no login of its own;
    its frames leave the move to the tab's top pages. A passkey Pateat answers there, as
    any page's request (ADR 0034), counts as above only when the item that signed it is
    the attempt's own and it came after that page's request: the tab's next top page, at
    most 30 seconds after the answer, then completes the attempt when its host is the
    passkey's RP ID or under it, the attempt's own origin included, and it reads quiet
    as above. That page announcing again keeps the attempt waiting while it shows no
    password field, code input or CAPTCHA, within 30 seconds of its request or of such
    an answer, unless it reads quiet itself after the answer. Once such a page asked,
    nothing else completes the attempt: an answer before its request, with another item
    or none at all, a page after the answer that asks for a passkey again, a later page,
    and the move rules below for a password submission each end it `left-origin` on the
    tab's next page, as do a page of another site and a request more than 30 seconds
    after the step. A page that asked and stays open ends it `left-origin` 61 seconds
    after it last held the attempt, once no next page could complete it. The item is
    kept in memory with the answer only, as the answer is, and so is the waiting: after
    a worker restart, the tab's next page on the attempt's own origin resumes it as the
    page after its last step (ADR 0029), and one on another origin ends it `left-origin`
    (Claude's reading, not confirmed by the owner separately). A page whose request
    comes only after its readings ended is not held. This and every other move that does
    not complete the attempt is logged with why (`login.move`). The completion saves an
    automatic account choice and releases the origin like any other `authenticated`
    attempt; it is the one completion that needs neither a completion check, ADR 0029
    evidence nor the judge, also on the `passkey` route of
    [ADR 0027](0027-per-account-login-routes.md). The answer is kept in memory only, so
    after a worker restart, or with any condition not met, the attempt ends
    `left-origin` as before. A site that rejects the assertion and sends the tab to a
    quiet page of the same site is counted as signed in; other tabs may then log in
    there again.
  - **A move after a password submission** (amended 2026-10-12, owner's choice at 21:18
    UTC). A top-level attempt on the `password` route ends `authenticated` instead when
    all of these hold: its last effect step (a fill or a click that may have submitted,
    not one that asks for a passkey) was sent to the page at most 30 seconds before the
    move, and no passkey answer after it decides the move as above; the new top page is
    HTTPS and on the attempt's registrable domain (as Bitwarden's Domain match compares
    it, each name under a private suffix such as `github.io` being its own domain), so
    `ssl.pc.moppy.jp` may move to `pc.moppy.jp`; and that page shows no password field,
    code input or CAPTCHA, makes no passkey request at or after that step, and shows the
    account's username in its header or navigation (E2 of
    [ADR 0029](0029-local-sign-in-state.md)), in two readings a second apart once it has
    loaded (at most 5 readings; a loaded page that does not show the username yet, as a
    single-page site may render its header late, is read again).
    The username goes to the new page's content script for that comparison only, as for
    E2 after an effect step; it is read with the settings the login started with, so
    after a settings change the attempt ends `left-origin`. The recipe's sign-in fields
    (S1) and the return target (E3) are not read on the other host. Pateat fills and
    clicks nothing there and never reopens the login URL. Frames of the new page wait
    for or leave the move to the top page as above, and the completion saves an
    automatic account choice and releases the origin like any other `authenticated`
    attempt. The step's time is kept in memory only, so after a worker restart, or with
    any condition not met, the attempt ends `left-origin` as before. Generic signs only;
    no site is named in the code ([ADR 0033](0033-no-site-specific-features.md)).
  - **The judge for such a move** (owner's choice at 21:18 UTC, implemented in its
    second delivery). When the new page shows none of those signs in its last two loaded
    readings but never the username in two, a signed-in marker learned on that origin
    (below) that shows on it completes the attempt as the readings would. Otherwise the
    page is described and sent once to the sign-in judge of ADR 0029, with the account's
    username and those of the items matching the page hidden as for any judged page, and
    `signed-in`, or the service's `judged-signed-in` for a page of that origin and path
    the judge answered `signed-in` before in the revision, completes the attempt once
    the page, read again after the answer, has loaded and still shows none of those
    signs, with no passkey request since the step. Any other answer, including one the
    judge could not decide (`unclear`, `already-judged`), `challenge`, `rejected` or a
    refusal, a page that cannot be described or sent, and a recipe revision no longer at
    hand, ends the attempt `left-origin` as before, each logged as a `recipe.judge`
    entry marked `moved` with the new page's origin. The page's announcement, and frames
    of it, wait for the answer; the same document announcing again meanwhile waits for
    that answer instead of sending the page again. The service judges a page of another
    HTTPS origin of the recipe's registrable domain, for the `password` route only, as
    one of the recipe's own (one rule, `loginMoveFits` in the contracts, for the
    extension's check, the service and the markers, so a later widening changes it in
    one place), except that the recipe's paths are not compared with it, its markers
    there are only those learned on that origin, a `challenge` there adds no handler,
    since no login runs on that origin, and a `signed-in` verdict whose marker cannot be
    learned still answers `signed-in`, as a later request for the page would. Each
    judged page is kept per recipe revision, origin and path (D1 migration 0015; earlier
    rows were dropped, as Pateat is unreleased), so a second login on the recipe's own
    origin and on the other one are judged apart. A `signed-in` page there learns its
    marker with that origin (`completion[].origin`), which proves a sign-in only on a
    page of that origin a login's tab moved to, never on the recipe's own origin, and
    markers of the recipe's own origin are never read on the other one. The page is
    judged at the path it shows when it is described, which may differ from the URL it
    announced: a signed-in single-page app can change its own URL while it loads, as
    Microsoft's did in the Grok Bot's browser on 2026-10-13 at 04:33 UTC, where the
    judgement was dropped as `page-changed`. Pateat still fills and clicks nothing on
    that page and never reopens the login URL.
  - **A move to another site after a second factor** (owner's choices at 01:59 UTC and
    03:13 UTC on 2026-10-13). The same two checks, the username in the header or
    navigation and otherwise one judgement, also complete a move to an HTTPS origin of
    another registrable domain, but only when the attempt's second factor came at most
    30 seconds before the move. That is a TOTP code it submitted: the click on a `totp`
    handler's or a route's code button, or a code fill that the page may submit by
    itself ([ADR 0027](0027-per-account-login-routes.md)). Or it is a passkey Pateat
    answered for the login's page after the attempt's last effect step, once a
    submitting step had followed the attempt's fill of the item's password; a passkey
    answered without a submitted password, as the sign-in itself, is still decided by
    the passkey's own site only, as above. The later of the two counts. The passkey
    request and the readings count from it, and the page must show no password field,
    code input or CAPTCHA, as above. Such a second factor also lets a move to another
    origin of the site count when the last effect step was earlier. A move to another
    site right after the password step, or later than 30 seconds after the second
    factor, still ends `left-origin`, as does any answer but `signed-in` or
    `judged-signed-in`. The service judges a page of another site for the `password`
    route only; a site may ask for a passkey without any recipe step, so it cannot tell
    from the recipe whether a second factor came, nor see when, and the extension's
    30-second check is the one that limits it. Its judgement row and any marker learned
    there are keyed by that page's origin, as on another host of the site. The page's
    text goes to the judge although Pateat was not set up for that site, with its header
    and navigation and with the usernames, email addresses and numbers hidden as on any
    judged page; the owner accepted that, and that a rare error page that shows the
    username may complete the attempt, because the code page showing at all means the
    password was accepted, as does a passkey request after it. No site is named in the
    code ([ADR 0033](0033-no-site-specific-features.md)).
- **Holding the origin in other tabs** (amended 2026-10-11 and three times on
  2026-10-12). Cookies can be shared across tabs, so another tab's record of the origin
  refuses a new attempt with `origin-busy` until that tab closes or the record has not
  changed for 5 minutes (`changedAt`, written when the login's progress changes: a new
  page of its tab or a page sent to be judged does not count, nor does a restarted
  worker finding it; a record without it does not hold), unless it is `authenticated`,
  ended `interrupted` without any submission, or ended `blocked` because Pateat itself
  stopped it with nothing in flight: `policy-changed`, `value-mismatch`,
  `wrong-account`, `account-switched`, `retry-limit` (its retries spent on failures that
  changed nothing on the page; owner, 2026-10-12), or `cancelled` before any submission
  (a frame login whose page went away also ends `cancelled`), without a pending mutation
  intent, a click the page may have received, or a result settled as unknown. A
  withdrawn authorization before the page received the prepared fill or click takes back
  that operation's reserved effect, so such a record shows nothing in flight; a record a
  restarted worker finds with an intent pending keeps holding. Such a record does not
  hold: the login form showing in a new tab means the site's session has ended, as when
  the first tab is closed, and a stop by Pateat says nothing about the password. This
  includes a stop on a second-factor handler step after the password was accepted. The
  tab then logs in as a new tab would, with the saved default or by asking when several
  items match. While an automatic account choice is being saved, or if one was saved
  after the tab read its settings, the new login waits for the save and is checked again
  with the new settings, because the save bumps the policy revision it would otherwise
  be stopped by. A record in any other state keeps holding, for example one that is
  running, `retryable` (it is tried again from the same step at once, or, after a
  restart, once a new page of its tab shows, until its retries are spent), still
  reconciling, settled as unknown, watched after a `challenge` (`watching`, ADR 0027),
  ended `interrupted` after a submission, stopped by Pateat while a fill or click may
  have reached the page, or ended `credential-rejected`, `challenge`, `submission-limit`
  or `left-origin`. A watched login, settled or `watching`, stops holding once its first
  step shows in another tab's page first seen after the watch began (ADR 0027). A
  top-level password login whose page shows its sign-in form again right after the
  submission, or that ends `credential-rejected`, is released as after a logout once
  that page announces, so other tabs ask instead of being held (ADR 0021 D, 2026-10-13).
  So a password is not submitted again while a first submission may still be in flight
  or was refused, or while the user may be answering a challenge Pateat does not handle.
  Releasing `account-switched` lets another tab start between the switch click and the
  first tab's fresh attempt, which then waits as `origin-busy`. A refused tab's tooltip
  says that another tab's login holds the site and that closing that tab, or waiting 5
  minutes and reloading, lets it log in, and is reset when the tab logs in
  ([Background execution](../architecture.md#background-execution)). A refused page does
  not announce again when the hold ends; reloading it starts the login, as does a pick
  in the toolbar popup while the page waits for an account choice
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
  also return there after a cancel or failure. For a password submission the owner later
  chose the username on the new page, with the judge as its fallback (21:18 UTC, above).
- **Treat a move to another site after any submission like one to the same site**
  (「同じ扱い」, 2026-10-13). Not chosen: right after the password step, an error page
  or an identity provider of another site could complete the login, while after a TOTP
  code the password is known to have been accepted.
- **Keep ending a move to another site `left-origin`** (「今のまま」, the rule before
  2026-10-13). Not chosen: on Microsoft the signed-in page is on another site, so the
  login never completed, saved no account choice and held the site in other tabs.
- **After a passkey second factor, keep ending a move to another site `left-origin`
  unless it is the passkey's own site** (「今のまま」 on the 03:13 UTC card). Not
  chosen: on Oracle Cloud the signed-in page after the security key is on another site,
  and the password was accepted before the passkey was asked for, as before a TOTP code.
- **After a password submission, keep ending such a move `left-origin`** (the rule
  before 21:18 UTC on 2026-10-12). Not chosen: on モッピー the signed-in page is on
  another host, so the login never completed and held the site in other tabs.
- **After a password submission, complete when the new page shows no password field,
  code input or CAPTCHA.** Rejected by the owner (21:18 UTC): a page that waits for an
  approval in an app, or an error page, shows none of them and would complete.
- **After a password submission, watch the new page for 10 minutes** (「10分見守る」 on
  the owner's card): read the new page for 10 minutes, as a login is watched after a
  `challenge` ([ADR 0027](0027-per-account-login-routes.md)), and complete on evidence
  or the judge. The card noted that it could also complete after a second factor on the
  new page, and that it was the largest change. The owner chose 「AI判定」 instead.
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
