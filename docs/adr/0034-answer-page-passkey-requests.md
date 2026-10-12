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
   and only before that click, which is its first submission. A recipe with a
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
   hands it on (`no-login`), unless the tab asks it for an account after a logout
   (ADR 0021 D): a document so asked, or filled by a login that only fills, keeps its
   request while the tab asks, and the login the popup pick starts answers it as in
   rule 3 when the picked item holds a discoverable passkey. A pick that starts no
   login hands it on three seconds later, unless the choice is offered again by then.
   That request is also withheld
   four minutes after it came, since the browser ends the message that carries it after
   five: a pick after that signs in with the password, and an item with only a passkey
   does not sign in until the page is loaded again.
6. **Back to the password when the site refuses.** If no request comes within three
   seconds of the step, the item's passkey cannot answer it, the recipe's rejection
   shows after the answer, or the start page's sign-in form still shows on the start
   path fifteen seconds after the answer, the login takes the `password` route's variant
   recorded at its start and goes on from its first step. The answer's time is kept per
   document in the service worker's memory, so in a new document or after a worker
   restart a form that still shows falls back at once. A rejection still showing from
   the answer does not reject the password in that document until it has gone. It never
   answers twice. Without a variant that fits the item, it ends
   `challenge`, as the button route does.
7. **Signed without the person.** The answer sets UP and UV with no gesture, the policy
   the owner chose for `optional` requests in ADR 0007. A conditional request is meant
   to be answered when the person picks an autofill suggestion; Pateat skips that pick.
   This adds no attack surface: a page that can make a conditional request can already
   make an `optional` one that Pateat answers the same way, and the RP ID and origin
   checks are unchanged.
8. **Logs.** `passkey.request` names the request's `mediation` on every outcome, a new
   outcome `withheld`, the reasons `no-recipe`, `no-login` and `login-ended`, the cause
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
  fallback starts from that click.
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
- If the RC check finds Wise's request is `immediate`, not `conditional`, this ADR is
  revised before the work is called done.
- Verified with unit tests of the attempt machine, the route helpers, the bridge and the
  login runtime. Real-site checks on Wise run in the owner's Chrome.
