# ADR 0088: A one-time login from the popup

Status: requested by the owner on 2026-11-11 UTC (recorded at 15:07 UTC),
「あと、UIでポップアップからforce login(条件などで止まっているもの)できるようにして」.
This change implements the request. The scope and lifecycle details below are the
implementation's interpretation of that request, not separately confirmed choices.
Amends [ADR 0022](0022-login-attempts-per-tab-and-origin.md),
[ADR 0035](0035-page-kinds-per-site.md) and
[ADR 0062](0062-log-in-again-after-a-logout.md) for this new explicit action;
ordinary automatic logins and the existing account-choice action keep their behavior.
Verification is synthetic; no real account or paid model request was used.

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
  settled record may still have a passive result watch; that watch does not block this
  explicit retry. It does not alter another tab's record. Active operations, challenge
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
- Pending permission is bounded and stays in memory. Page replacement, a changed URL,
  tab removal, expiry, a failed evaluation or a worker restart ends it. Another frame's
  announcement does not gain or cancel the selected frame's permission. After an
  attempt starts, its existing account and attempt scope govern continuation.
- Success does not save a default, retain a session account, clear an ask-every-time
  choice or resume a timed pause. The original account-choice and account-switch
  controls keep their existing setting changes.

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
