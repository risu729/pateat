# ADR 0088: A one-time login from the popup

Status: requested by the owner on 2026-11-11 UTC (recorded at 15:07 UTC),
「あと、UIでポップアップからforce login(条件などで止まっているもの)できるようにして」.
This change implements the request. The scope and lifecycle details below began as the
implementation's interpretation of that request; the owner approved merging the change
with them on 2026-11-15.
Amends [ADR 0022](0022-login-attempts-per-tab-and-origin.md),
[ADR 0035](0035-page-kinds-per-site.md) and
[ADR 0062](0062-log-in-again-after-a-logout.md) for this new explicit action;
ordinary automatic logins and the existing account-choice action keep their behavior.
Testing is synthetic; no real account or paid model request was used.
Amended on 2026-11-17 by the owner (13:15 UTC,
[below](#amendment-2026-11-17-fill-on-verification-pages)): a verification page with a
`confirm` or `unclear` recipe offers **Fill** instead of **Log in now**.

Date: 2026-11-11

## Context

The existing popup account choice is offered only after a document reaches a refused
login with candidates. A single account, an earlier attempt record, a page without a
recipe, or a cached page-kind decision can therefore leave no way to ask Pateat to try
now. Changing the default or resuming a site also changes later automatic behavior,
which is unnecessary for one requested login.

## Decision

- The popup offers **Log in now** for an eligible account on a currently tracked
  HTTP(S) document. It includes a single matching account. Where several embedded
  login documents are available, the person chooses the target as well as the account.
  The action remains available when the optional **This page** section is hidden.
- The request applies only to the selected tab, frame, document, URL and, for an
  embedded document, its current top page. Eligibility is checked again on execution;
  the popup's list is not authority to use a removed or no-longer-matching item.
- This action overrides automatic pause, private-window and allowed-site suppression,
  repeated-login asks, and safely ended or settled attempt records for this one login. A
  settled record can be retried only while no operation is running. Active
  reconciliation still blocks the request. It does not alter another tab's record.
  An SSO flow that only waits on its relying party's page is not active
  reconciliation: once its entry was spent and the tab came back, or its IdP login
  finished, with nothing written, pressed or admitted in flight, the tab's top RP
  page is offered and the request ends the flow as stopped before its login starts
  there ([ADR 0026](0026-sign-in-through-identity-providers.md)). While the tab is at
  the IdP, or an entry or the flow's own step is in flight, the request is refused.
  Active operations, challenge
  watches and account switches remain protected from concurrent logins.
- A missing recipe or an earlier non-login judgement is evaluated through the normal
  generation or start-page repair path. A `confirm` or `unclear` recipe is never made
  executable by relabelling it. A first-page generation request may carry `manual: true`
  to pass the local sent-page cooldown and the shared ten-minute attempted-page gate.
  It still rechecks the current recipe head and records the attempt. This flag is
  rejected on continuation and repair requests. In-flight request deduplication,
  normal schemas, model-output validation, repair limits and spending limits remain.
- The action starts on a sign-in form, account chooser or supported passkey page. A
  page that only offers an entry link asks the person to open its sign-in page first;
  pending permission is not carried across that navigation before an attempt starts.
- The selected account's normal URI matches, vault availability, host permission,
  item and field policy, master-password checks and form-destination checks remain
  required. The action cannot supply missing credentials, solve a challenge or make a
  missing target appear.
- The popup distinguishes preparation or generation from an actually started login
  and from a refusal. A second click cannot create another pending request for the tab.
  A stale or unavailable page is reported rather than silently choosing another page.
  A web page where no document reported a sign-in form says so, without asking the
  person to reload it.
- Pending permission is bounded and stays in memory. Page replacement, a changed URL,
  tab removal, expiry, a failed evaluation, the popup's **Cancel this login** or a
  worker restart ends it. A changed top-level URL ends it as soon as the tab reports
  the navigation, so a page restored from the back/forward cache with its old document
  and URL does not revive it. Cancel ends only the named pending request; it does not
  stop a login that already started. Another frame's announcement does not gain or
  cancel the selected frame's permission. After an attempt starts, its existing account
  and attempt scope govern continuation.
- Starting the login clears the tab's ask for an account after a rejected or stopped
  login of the origin (ADR 0062 B), as an ordinary popup pick does.
- Success does not save a default, retain a session account, clear an ask-every-time
  choice or resume a timed pause. The original account-choice and account-switch
  controls keep their existing setting changes.

## Interaction with page permissions

Delivery 2 of ADR 0035 adds a passive sign-in attempt. **Log in now** may take over that
attempt only while it is parked on its read-only page-change wait, with no input,
acknowledgement, generation or passkey request in flight. A conditional passkey request
of the document that only waits for that document's login does not count: the login
answers it ([ADR 0034](0034-answer-page-passkey-requests.md)); once the login
hands it an item to sign, it counts again. A restored passive record with
no running operation can also yield. A passive attempt that ended, because it filled its
last safe field (`fillDone`) or its watch ran out, holds no page and is retried like any
other ended record. Planning, active field reads, mutation intents, challenge watches
and account switches keep their existing refusal rules.

The request is an explicit popup pick for the selected document, so ADR 0035's pick
rule makes this one login press as an `auto` page would, also when the document's own
site or its tab's site sets `sign-in` to `fill`. Once that login has started, its later
pages keep pressing while it runs as a normal login; the next passive attempt on the
site follows the setting again.

The final authorization checks and removal of the old run occur without an intervening
await. Existing run identity, operation and document checks then fence its late wait
response or acknowledgement before storage yields; a new manual attempt gets its own
identity and the selected pick's authority. Another tab's idle passive wait does not
block the request, but a wake of that old wait cannot act beside the manual login. This
changes no site or profile setting and grants no account remembering or default save.

A valid request may also reach normal start-page repair when a cached `confirm` or
`unclear` page is set to `off`. It does not execute the cached recipe or change its kind
locally. A page still classified as a confirmation is left untouched; normal repair,
inference, spending, scope and output-validation limits apply. These are integration
details of the existing explicit action, not a new permission to submit confirmations.

## Consequences

The person can retry a stopped login without changing future automatic behavior.
An explicit retry may ask the configured model again and incur its normal cost, or
submit credentials again after a failure; the action does not promise a successful
login. Existing limits and current authorization still decide what can run.

A page can change during preparation, so the request may be refused and need a new
click. Pending preparation is deliberately not resumed after a worker restart. The
feature adds a bounded per-tab pending state rather than a permanent force setting.

## Alternatives

- Only show the existing account-choice button more often: insufficient where no
  choice is recorded or generation was suppressed.
- Resume the site or change its default before retrying: changes future behavior and
  other tabs for a one-time request.
- Ignore every guard or execute a cached non-login recipe as a login: would broaden
  credential release and could press a confirmation action instead of logging in.

## Amendment 2026-11-17: Fill on verification pages

The owner decided on 2026-11-17 at 13:15 UTC that a page whose path has a `confirm` or
`unclear` recipe offers **Fill** (「入力」) in the popup instead of **Log in now**
([ADR 0035](0035-page-kinds-per-site.md#amendment-2026-11-17-fill-from-the-popup)). It
fills the picked account's password into that recipe's fields once and presses
nothing, and it never asks the model to classify the page again.

The following are the agent's choices, not confirmed by the owner:

- **Fill** uses this action's offer: the same targets, account list, page fingerprint
  and recheck before the account is used. A target is offered **Fill** only when
  `confirm` is `fill` for the page; with `off`, the page keeps **Log in now** and its
  re-evaluation through start-page repair described
  [above](#interaction-with-page-permissions). A secret-answer page without a recipe is
  offered **Fill** too, and a sign-in page keeps **Log in now**.
- A pending **Fill** is held in memory per tab, as a pending login is, and ends on the
  same events. While either is pending, the tab offers neither action again. The
  worker does not refuse a **Log in now** request for a verification page; the popup
  only stops offering it there.
- **Fill** is not a login: it starts no attempt, clears no ask for an account and
  changes no setting, default or record.
- After a worker restart, the offer gets a top verification page the worker does not
  know yet to announce again, with a bounded wait, so **Fill** shows there; other pages
  are not asked
  ([ADR 0035](0035-page-kinds-per-site.md#amendment-2026-11-17-fill-after-a-worker-restart)).
