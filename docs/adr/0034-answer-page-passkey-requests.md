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
   site it has no recipe for, even with one matching item or a site default.
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
  route between steps; after the `passkey` route's answer, it goes back to the
  `password` route once. The attempt keeps its `password` variant while on the `passkey`
  route, so the fallback needs no new plan, and the fallback adds the answer to the
  password route's submission budget.
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
