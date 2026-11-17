# ADR 0034: Pateat answers a login page's own passkey request

Status: accepted by the owner on 2026-10-12: the policy at 13:58 UTC ("when the item has
a passkey, Pateat uses it and prefers it over the password"), the proposal at 14:19 UTC
and again in its thread at 14:41 UTC. The second decision of the proposal, pages without
a recipe, takes its recommended default: they keep delegating. Amends
[ADR 0007](0007-existing-passkey-assertions.md) (conditional mediation is no longer
always delegated), [ADR 0027](0027-per-account-login-routes.md) (the `passkey` route on
a recipe without a passkey button, and its fallback to the password) and
[ADR 0025](0025-automatic-vault-sync.md) (a waiting conditional request does not hold
the vault).

Amended on 2026-10-23 by [ADR 0062](0062-log-in-again-after-a-logout.md) (accepted
and implemented): rule 5's case after a logout is gone, since a logout is followed by an
ordinary login; the remaining asks keep the request as before, and a conditional request
on a paused site (a timed pause, an exclusion rule, or a private window while automatic
login is off there) is handed on at once as `paused`.

Amended on 2026-10-12 by the owner's choice at 17:56 UTC: while the tab asks for an
account after a logout (ADR 0021 D), the asked document's request waits for the pick in
the popup and is answered with the picked item's passkey, instead of being handed on
(rule 5).

Amended on 2026-10-12 under the owner's policy of 13:58 UTC, after logs from the owner's
Chrome (18:30 and 18:43 UTC) showed Wise's sign-in runs as a chooser login
([ADR 0028](0028-account-chooser-login-pages.md)) that this ADR had left on the
password: a chooser login takes the `passkey` route too, before its click on the list
(rule 3).

Amended on 2026-10-12 under the same policy, after logs from the owner's Chrome (20:30
and 20:33 UTC) showed Wise's page judged on the start path before the site moved on,
and one at 20:42 UTC showed it on the start path with only a loader for more than 26
seconds: the hold of rule 6 also keeps a page on the start path from being judged, and
a page there that shows nothing to describe waits up to two minutes.

Amended on 2026-10-12 by the owner's choice at 22:04 UTC (implemented, local tests
only): outside a logout too, while the tab offers a page a choice of accounts in the
popup and an offered item holds a discoverable passkey, that page's request waits for
the pick on a recipe without a passkey button, so a picked item with a passkey signs in
with it. It is handed on three seconds after the choice goes away, and four minutes
after it came instead of being withheld (rule 5). Evidence from the owner's Chrome on
build `cdfa420`: at 21:12:36 UTC GitHub's sign-in page matched three items without a
site default and asked in the popup (`account-ambiguous`); at 21:12:38 its conditional
request was handed on (`no-login`); the pick at 21:16:51 started the login on the
`password` route; after a reload at 21:17:15, the saved default's login took the
`passkey` route and Pateat answered the page's request.
Amended on 2026-10-13 by [ADR 0036](0036-passkey-after-the-identifier.md): for a login
that stops before its item's missing password, a `conditional` request made after the
first submission waits until the login reaches its stop and is answered there (rules 3
and 5; implemented).

Amended on 2026-10-25 (agent change under the owner's policy of 2026-10-12 13:58 UTC,
not yet confirmed by the owner;
[the amendment below](#amendment-a-request-after-a-refused-start-2026-10-25)): a request
that comes after its document's login was refused for want of the `passkey` route starts
that login again (rule 5).

Amended on 2026-11-17 (agent fix under the owner's policy of 2026-10-12 13:58 UTC, not
yet confirmed by the owner;
[the amendment below](#amendment-a-request-its-page-moved-away-from-2026-11-17)): a
request is answered only while its tab still shows the path it came on, checked again
right before its assertion leaves, and is handed on as `page-moved` otherwise, or as
`page-unknown` when a path could not be read; Pateat's page script also drops an
assertion that comes back after its page's path changed. This narrows ADR 0036 rule 4.

Amended on 2026-11-17 by two owner decisions on requests that wait for no autofill
choice; `conditional` requests stay as above. Option D (13:50 UTC,
[ADR 0036 amendment](0036-passkey-after-the-identifier.md#amendment-a-login-that-moved-answers-the-passkey-request-there-2026-11-17)):
a running login answers the request of a page its tab moved to, of its site or a related
origin, with its item. Option A (13:51 UTC,
[ADR 0028 amendment](0028-account-chooser-login-pages.md#amendment-2026-11-17-a-passkey-request-on-a-page-that-shows-another-account)):
a click's discoverable request on a page that shows another matching account than the
site default opens the chooser with that account first.

Amended on 2026-11-17 by the owner's decision at 18:22 UTC
([the amendment below](#amendment-a-request-that-names-its-credentials-2026-11-17)):
rule 2 gets an exception. A `conditional` request that names its credentials, on a path
where no recipe starts and with no login of the tab to answer it, is answered with the
one vault item that holds one of the named passkeys.

Date: 2026-10-12

## Context

On 2026-10-12 at 13:49 UTC Pateat logged the owner in to `https://wise.com` with the
password, although the Wise item holds a passkey for the site and a TOTP field. The
official Bitwarden extension showed its passkey window during that login, which closed
when the login finished.

The recipe's `passkey` route exists only when the start page has a "sign in with a
passkey" button (ADR 0027). Wise has none: its page asks for a passkey by itself with
`navigator.credentials.get({ mediation: "conditional" })`, which lists passkeys among
the browser's autofill suggestions. Pateat handed every conditional request to the
browser and later providers (ADR 0007), so the Bitwarden extension answered it. The
logs from the owner's Chrome (14:41 UTC relay) show such a request before the login
started on Wise, and one handed on during a login on the `passkey` route on SBI証券.
Whether Wise's request is `conditional` rather than `immediate` is to be confirmed from
the `mediation` field that [#350](https://github.com/risu729/pateat/pull/350) added to
`passkey.request`.

The owner's policy (13:58 UTC): Pateat handles the passkey, and prefers it over the
password when the item has one. The proposal reviewed with the owner is
`notes/passkey-conditional-proposal-ja.md` in the project files (second version).

## Decision

1. **The login decides.** A top document's `conditional` request no longer goes to the
   browser at once. The passkey bridge passes it to the login runtime, which answers it
   only through a login of that document, so the account choice is the login's: the
   site default, the popup choice, asking again after a logout (ADR 0021 D) and waiting
   for another tab's login (ADR 0022) apply unchanged. Requests on pages where Pateat
   starts no login, such as a home, registration or payment page, are handed on as
   before; Pateat never signs in just because a page was visited.
2. **Pages without a recipe keep delegating** (`no-recipe`). Pateat does not answer a
   site it has no recipe for, even with one matching item or a site default. (Since the
   [amendment of 2026-11-17](#amendment-a-request-that-names-its-credentials-2026-11-17),
   a request that names its credentials is answered when exactly one vault item holds
   them.)
3. **The passkey goes first.** When the page has asked and the login's item holds a
   discoverable passkey, a login on a recipe without a passkey button takes the
   `passkey` route. That route's one step answers the waiting request with the login's
   item and fills nothing. A login that started on the `password` route switches to it
   while nothing has been submitted, keeping any fields it filled. A login on a
   chooser's list (ADR 0028) does so too: it answers instead of clicking on the list,
   and only before that click, which is its first submission; a list where no account
   fits and no button leads elsewhere still ends `account-not-listed`. A recipe with a
   passkey button keeps clicking the button (ADR 0027); its page's conditional request
   then waits as in rule 5, so the two never overlap.
4. **It is a login like any other.** `login.attempt` records the route, the attempt's
   record holds the origin as ADR 0022 says, the sign-in checks and the judge of
   ADR 0029 and ADR 0027 apply, and ADR 0021 D asks before signing in again after a
   logout. The answer counts as the route's submission.
5. **Requests after a submission wait.** A conditional request of a document whose login
   runs, or starts within three seconds, waits without an answer until that login ends.
   It is then withheld if the login signed in, so the page's promise stays pending until
   the page aborts it, as the specification allows for conditional mediation, and handed
   on otherwise (`login-ended`); a login watched after a `challenge` or an unknown
   result (ADR 0027) has ended for this. One that waits four minutes is withheld. A
   waiting request is not cancelled when settings are saved and does not hold the vault
   replacement of ADR 0025; the item it is answered with is looked up under the settings
   current at that time. A document whose login does not start within three seconds
   hands it on (`no-login`), unless the tab asks it for an account: after a logout (ADR
   0021 D), or, on a recipe without a passkey button, in a popup choice (ADR 0021 B) in
   which an offered item holds a discoverable passkey. A document so asked, or filled by
   a login that only fills, keeps its request while the tab asks, and the login the
   popup pick starts answers it as in rule 3 when the picked item holds a discoverable
   passkey; with any other item that login takes the password, and the request follows
   its end as above. Pateat answers only through the login the person's pick starts and
   never signs in on its own. A pick that starts no login hands it on three seconds
   later, unless the choice is offered again by then. After a logout, that request is
   also withheld four minutes after it came, since the browser ends the message that
   carries it after five: a pick after that signs in with the password, and an item with
   only a passkey does not sign in until the page is loaded again. In a popup choice
   outside a logout:
   - Whether an offered item holds a passkey is read as at a login's start (a
     discoverable passkey that can sign), with one vault search per RP ID the site may
     use, matched against the offered items; no secret value is read. An item the search
     could not reach, as in a locked vault, counts as holding none; when no offered item
     holds one, the request is handed on as without a choice. While the search runs,
     whether the request or the choice came first, the request is not handed on.
   - The request is handed on three seconds after the choice goes away, unless it is
     offered again by then: the document navigates, a site default is saved for the
     origin (in the settings, by sync, by a pick in another tab or by Pateat's passkey
     chooser), another frame's
     choice replaces it, or the choice could not be restored after a worker restart.
     When the document announces again and that starts a login instead of being
     refused, the login decides the request as above, as for any login of its document.
   - Four minutes after it came, unless a login of its document runs by then, it is
     handed on (`no-pick`), not withheld: the browser
     ends the message after five, so there is still time to. A pick after that signs in
     with the password, and an item with only a passkey does not sign in until the page
     is loaded again. A worker restart hands it on as well, and a later pick signs in
     with the password, as after a logout.
6. **Back to the password when the site refuses.** If no request comes within three
   seconds of the step, the item's passkey cannot answer it, the recipe's rejection
   shows after the answer, or the start page's sign-in form still shows on the start
   path fifteen seconds after the answer, the login takes the `password` route's variant
   recorded at its start and goes on from its first step. The answer's time is kept per
   document in the service worker's memory, so in a new document or after a worker
   restart a form that still shows falls back at once. A rejection still showing from
   the answer does not reject the password in that document until it has gone. Until
   those fifteen seconds pass, a page still on the start path with its form gone is not
   judged either, since the site may still be exchanging the assertion before it moves
   on; one that shows nothing the judge's description could carry, as a loader, is not
   judged for up to two minutes after the answer, the wait of a held click (ADR 0027),
   and then ends `challenge`. It never answers twice. Without a variant that fits the
   item, it ends `challenge`, as the button route does.
7. **Signed without the person.** The answer sets UP and UV with no gesture, the policy
   the owner chose for `optional` requests in ADR 0007. A conditional request is meant
   to be answered when the person picks an autofill suggestion; Pateat skips that pick.
   This adds no attack surface: a page that can make a conditional request can already
   make an `optional` one that Pateat answers the same way, and the RP ID and origin
   checks are unchanged.
8. **Logs.** `passkey.request` names the request's `mediation` on every outcome, a new
   outcome `withheld`, the reasons `no-recipe`, `no-login`, `login-ended` and `no-pick`
   (no pick within four minutes in a popup choice outside a logout), the cause
   `login-wait` when waiting for the login failed (a page that cancels a waiting request
   logs the `cancelled` outcome and `page-cancelled`), and
   `answerFailed` when the item could not answer. `login.attempt` names a route change
   as `routeChange`, logged at info: `page-request` (switched to the passkey), or
   `request-missing`, `answer-failed`, `sign-in-rejected` or `sign-in-shown` (back to
   the password).

### Implementation choices

- The `passkey` route on a recipe without a passkey button has one synthetic step, a
  `submit` click on the target of the recipe's first step. It is never sent to the page:
  the runtime answers the request in its place. Start detection is unchanged, so the
  route is chosen at the start only when the request already waits; otherwise the
  `password` route starts and switches as rule 3 says, also once its first step's
  elements are ready. On a chooser login the first step is its click on the list, so the
  synthetic step stands on the click's target and the fallback starts from that click;
  whether the list still shows after the answer is read as the click's wait for the list
  reads it, since an account entry's target names no element.
- The attempt machine has a `ROUTE` event. Before any submission or handler, it changes
  route between steps, once each way (amendment of 2026-11-04); after the `passkey`
  route's answer, it goes back to the `password` route once. The attempt keeps its
  `password` variant while on the `passkey` route, so the fallback needs no new plan,
  and the fallback adds the answer to the password route's submission budget.
- The judge request names the `password` route for this route, since the service accepts
  the `passkey` route only for a recipe that has the button. The extension still never
  sends a page that shows the sign-in form.
- The page's bridge keeps no time limit for conditional requests, which may wait for the
  whole login; an answer has the usual budget once the login gives it.
- The background's vault hold for passkey requests moved into the passkey runtime, which
  takes it while it reads the vault and signs, not while a request waits for a login.
- Whether a popup choice offers an item with a passkey (rule 5) is checked once per
  choice, and only while a request of its document waits: the login runtime asks the
  passkey source for each RP ID the origin may use, holding vault replacement off only
  during that search, and keeps the result in the service worker's memory; a choice
  offered again is searched again unless a passkey was found. A site default saved,
  synced, saved by a pick or saved by the passkey chooser since the choice was offered
  ends it for this.

## Alternatives

- **A recipe route for conditional requests.** Generation cannot see whether a page
  makes a conditional request, and the request comes before a route is chosen, so the
  waiting of rule 5 would be needed anyway.
- **Answer every conditional request at once.** Simpler, but Pateat would sign in on
  every visit to a page of the site, sign in again right after a logout, and race the
  password login.
- **Keep delegating and only log.** Against the owner's policy.
- **Answer pages without a recipe when one item matches or a default exists.** Offered
  to the owner as the second choice; the recommended default, delegating, was taken.
- **Keep the request during every popup choice, without checking for a passkey.**
  Offered to the owner on 2026-10-12 with the amendment of rule 5
  (`designs/github-passkey-pick-proposal.md` in the project files, option B); simpler,
  but a site whose accounts hold no passkey would lose other providers' suggestions too,
  so the owner chose the check.
- **Hand on during an ordinary popup choice, as before.** A pick then signed in with the
  password even when the picked item held a passkey, as on GitHub. Rejected by the
  owner's choice at 22:04 UTC.

## Consequences

- On a page like Wise's, Pateat signs in with the passkey, types no password, and the
  Bitwarden extension's window does not open. Its TOTP handler is not needed.
- A page whose request comes after the login started on the `password` route switches
  only if nothing was submitted; a page that asks only after the password was sent
  keeps the password login, and its request waits as rule 5 says.
- A conditional request on a page where Pateat logs in no longer reaches another
  provider while the login runs; after a failed login it does. While the tab asks for an
  account after a logout, the Bitwarden extension's suggestions do not show on that
  page, and an account picked in the popup that holds a passkey signs in with it.
- Since the amendment of 2026-10-12 (22:04 UTC), the same holds while the tab offers a
  page a popup choice in which an item holds a passkey, on a recipe without a passkey
  button: on a site with several accounts and no site default, the Bitwarden
  extension's and Chrome's passkey suggestions do not show on that page until the person
  picks, the choice goes away, or four minutes pass, also for a person who does not use
  the popup. A pick after those four minutes signs in with the password. A choice whose
  items hold no passkey, or whose vault could not be searched, hands the request on as
  before.
- If the RC check finds Wise's request is `immediate`, not `conditional`, this ADR is
  revised before the work is called done.
- Verified with unit tests of the attempt machine, the route helpers, the bridge and the
  login runtime. Real-site checks on Wise run in the owner's Chrome. The wait for a pick
  outside a logout has local tests only; it is next checked on GitHub in the owner's
  Chrome.

## Amendment: a request after a refused start (2026-10-25)

On 2026-10-25 at 00:20 UTC, on build `557cdf9` in the owner's Chrome, Money Forward's
sign-in page (`https://id.moneyforward.com/sign_in`, recipe
`gen-9985d5176d1a9e9e5a7e6eb96a021ef5`, an email step and a submit, no passkey button)
started no login for an item with a discoverable passkey and no password. The login
started before the page's own `conditional` request came: without the request, the
`password` route had no step to stop at (`password-empty:no-password-step`) and the
recipe lacked the `passkey` route, so the page was sent for repair (ADR 0058 A). The
request came during the repair and was handed on three seconds later (`no-login`); the
start after the repair was refused (`no-route`). On 2026-10-24 at 01:37 UTC the same
recipe had signed in on the `passkey` route, as the request came first.

An agent change, as a general rule (ADR 0033), under the owner's policy that Pateat
uses the item's passkey when it has one:

- A new login of a top document refused, or sent for repair, because the recipe lacks
  the `passkey` route while the item holds a discoverable passkey (and the recipe has no
  passkey button, so a page request would give the route), outside an ask, a pause, an
  account switch and a resumed login, marks its document.
- A conditional request of a marked document waits while its repair runs, up to the four
  minutes of rule 5, and is then handed on (`no-login`) as before; a repair that fails
  or ends without a new announcement leaves it three more seconds.
- Once the document is refused and its request waits, the document is asked to announce
  again, once for that refusal (the announcement clears the mark); the new login sees
  the request and takes the `passkey` route (rule 3). It has three more seconds to
  start, as rule 5 gives any document. A document whose own login is still in the
  tab's record, even one that ended, is not asked; its request follows that login as
  rule 5 says.
- Nothing else changes: a document that was not marked hands the request on after three
  seconds as before, and an item without a discoverable passkey is never restarted.

## Amendment: once each way (2026-11-04)

The walk over every order of a login attempt's events found that a login that had
submitted nothing could switch from the `password` route to the `passkey` route and
back again each time the page's own request came and went, each time starting over at
its first step. The runtime already took the `passkey` route only once per login (its
fallback marks the passkey as failed), but only in the worker's memory, and the attempt
machine allowed the loop until its cap of 96 operation IDs.

The owner chose on 2026-11-04 at 14:52 UTC to allow each way once before a submission:

- The attempt records `passkeyLeft` when it goes to the `password` route. A login with
  it never takes the `passkey` route again: the machine refuses the `ROUTE` event, and
  the runtime does not send it. A login that started on the `password` route switches at
  most to the `passkey` route and back; one that started on the `passkey` route goes
  back once and stays.
- The fallback after the passkey answer is unchanged: it comes after a submission and
  was already once.

## Amendment: a request its page moved away from (2026-11-17)

[#1670](https://github.com/risu729/pateat/issues/1670): in the owner's Chrome on build
`92fdd25` (2026-11-17, about 12:38 to 12:42 UTC), OpenAI's sign-in on `auth.openai.com`
moved to its "Select a method to continue" page (`/auth_challenge`, buttons for a
passkey and a recovery key, no input), and before anyone clicked, the page turned into
its own 405 error: `Route "AUTH_CHALLENGE_SELECTION" does not have an action`, "but you
are trying to submit to it". That text is the client-side router's, so the page itself
submitted its current route from script. No recipe step or handler names that path, and
Pateat's clicks stop when the page leaves the step's path; the one thing Pateat does
there without a click is answer a passkey request. A single-page site that moves in
place from its email page to another route can leave the email page's `conditional`
request waiting: its autofill field is gone, so no browser would answer it, but rule 3
(the `passkey` route) and ADR 0036 rule 3 (the stop) answered the newest waiting request
of the document wherever the page then was, so the page could act on the answer on the
route it showed. A synthetic login runtime test reproduced both answers before this
change. Which request OpenAI's page made is not proven: the uploaded logs hold no
`auth.openai.com` lines, and the device's own `passkey.request` lines tell it.

An agent change, as a general rule (ADR 0033), not confirmed by the owner:

- The path stands in for the autofill field the request was made for, which Pateat
  cannot see: a conditional request records the path its page showed when it first came.
  Pateat's page script sends `location.pathname` with the request, and the background
  redacts it as observations carry a path (`observedPath`); when the page sent none, or
  one that is not a path, the tab's committed URL stands in, which follows a
  same-document move (`history.pushState`) where a sender's URL does not, but can lag a
  move made just before the request. A request that waits again after a failed answer
  keeps that first path. One trailing `/` does not count.
- A new login takes the `passkey` route for the page's own request (rule 3) only when a
  request came on the path the login starts on. The `passkey` route, the switch to it,
  and a stop of ADR 0036 take only a waiting request whose tab still shows its path, and
  check again just before the answer is recorded; a stop that finds the move then goes
  on as without a request, its submission unspent. A request whose page moved to
  another path is handed on as `page-moved`, and one whose path, or whose tab's path,
  could not be read (a failed tab read, or another origin) as `page-unknown`; neither
  is ever answered. The login goes on as when no request waits: the `password` route
  stays, the `passkey` route falls back as `request-missing`, and a stop ends
  `challenge` as `password-empty`. A request the page makes on the route it moved to is
  answered as before.
- The vault is read and the assertion signed after that check, so the background reads
  the tab's path once more right before the assertion leaves, as it reads the page's
  permission again then: a request whose page moved meanwhile is handed on as
  `page-moved`, and its login is told it was not answered: on the `passkey` route it
  falls back as `answer-failed`, and at a stop of ADR 0036, whose answer was already
  recorded, it ends `challenge` with the cause `answer-failed`. What remains after
  that, the trip to the page, the page itself closes: Pateat's page script drops an
  assertion for a conditional request that comes back after its path changed, compared
  redacted as observations carry it (a rewrite of a token segment alone is no move) and
  one trailing `/` aside, handing the request to the browser instead. The background
  does not learn of that drop.
- A site whose route after the email keeps the email page's request and offers it in a
  field of its own is not answered there any more; the browser or another provider gets
  the request. Rule 7's case for answering, a request a person could pick from an
  autofill suggestion, does not hold once that field is gone.
- This narrows ADR 0036 rule 4, which counts at the stop "one that was already
  waiting": an identifier-first site that keeps the same autofill field across a
  `history.pushState` to its next step now has that request handed on, and the login
  ends `challenge` there unless the page asks again on the new path.
- A router that rewrites the path in place with `history.replaceState` without moving
  the person, such as one that adds a locale or a trailing segment once the form shows,
  also hands its request on, for the same reason: Pateat cannot tell such a rewrite from
  a move to another step. Its passkey then goes to the browser or another provider, as
  on a site Pateat has no recipe for.

## Amendment: a request that names its credentials (2026-11-17)

[#1673](https://github.com/risu729/pateat/issues/1673): Money Forward ID's sign-in
(`id.moneyforward.com`) asks for the email on `/sign_in` and moves to
`/sign_in/password` for any address. That page shows no passkey button, but its script
makes a `conditional` request whose `allowCredentials` names the typed address's
passkeys. No recipe starts on `/sign_in/password`, so rule 2 handed the request to the
browser, which held no passkey for the site. An item with only a passkey and no password
could not sign in there.

The owner's decision of 2026-11-17 at 18:22 UTC, on a decision card: "Money Forward:
メール入力後にサイトが特定のパスキーを求めたら、Pateat が答えますか" ("When the site
asks for a specific passkey after the email is entered, does Pateat answer?"), choosing
"答える(おすすめ)" ("Answer (recommended)"): "求められたパスキーを持つ項目が1つなら、
Pateatのログイン中でなくてもその項目で答えます。打ったメールのアカウントで入ります。"
("If one item holds the requested passkey, Pateat answers with that item even when no
Pateat login runs. It signs in to the account whose email was typed.")

Rule 2 gets one exception: a `conditional` request whose `allowCredentials` is not empty
is answered with the one vault item that holds a passkey it names, even without a login.

The details are the agent's choices, not confirmed by the owner:

- **Only where no recipe starts.** The exception covers a request on a path where no
  login recipe or chooser starts, no later step a login may start at (ADR 0049), no
  sign-in entry (ADR 0031) and no first page of a recipe generated as `confirm` or
  `unclear` (ADR 0035). A path that cannot be read, or recipes that cannot be read,
  count as a recipe's. Everywhere else rules 1 to 7 decide as before.
- **A login comes first.** The request waits as a request without a login does (rule
  5, three seconds), and is answered only if no login of its document ever took it and
  no login of its tab runs then. Otherwise it is handed on as `no-login`, as before.
- **Exactly one passkey.** The vault, read in full, must hold exactly one passkey the
  request names, with a zero counter and no Bitwarden re-prompt. Several named passkeys
  are handed on as `ambiguous-credential`, even when the site default is one of them:
  the page names the typed account, so the default never breaks the tie. None is
  `no-credential`, and an unread item is `vault-incomplete`. A re-prompt item is
  `master-password-reprompt`, since an autofill request never opens the chooser window.
- **Every guard stays.** A paused site (a timed pause, an exclusion rule, or a private
  window while automatic login is off there) hands the request on as `paused`. A site
  that asks every time after a one-time pick (ADR 0063) hands it on as `one-time-pick`.
  A request on a page set to fill only is handed on as `sign-in-fill`, and one of a
  hostname chosen "Always for this site" as `browser-site`. The relogin guard (two
  automatic sign-ins of the site in 10 minutes, ADR 0062) hands it on as
  `default-unset`, as a site that asks every time does where the request itself gets
  past the first check. None of these signs without a person, so none opens a chooser.
- **Re-verification.** After Pateat's login in the tab signed in and no logout was seen
  (ADR 0035), the request is a re-verification on a `confirm` page. It is handed on as
  `confirm-fill`, as a click's request that names its credentials is. This extends
  that check to `conditional` requests, for this path only.
- **The page's path.** The checks of the amendment above apply: the tab's path is read
  again right before the assertion leaves, and a page that moved hands the request on
  as `page-moved`. Pateat's page script drops an assertion whose page's path changed.
- **A sign-in Pateat made.** The answer counts toward the relogin guard, and the tab's
  next page is the page after a sign-in (ADR 0028), as for any answer without a login
  or a choice.
- **Logs.** `passkey.request` carries the flag `namedCredential` on each request this
  path decided, answered or handed on. It records no credential ID, address or
  username.

Consequences:

- On Money Forward ID, an address the person types and submits signs in with that
  account's passkey on the password page, also for an item without a password.
- A site whose page after the identifier names one passkey of the vault in an autofill
  request now signs in without a press, where before the browser or another provider
  showed its suggestion. A site that names passkeys of several vault items still gets
  the browser's suggestion.
- Verified with unit tests of the passkey runtime and the login runtime only; the real
  site is still to be checked in the owner's Chrome.
