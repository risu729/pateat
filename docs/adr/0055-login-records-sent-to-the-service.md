# ADR 0055: Every login's result and times are sent to the service

Status: accepted by the owner on 2026-10-18 at 08:38 UTC. On a decision card for section
2.4 of the speed dashboard proposal, which asked whether each login's times and result
should be sent to the service, the owner chose option A, "毎回送る" (send every time).
At 08:38:40 UTC the owner added:
「ログは同期しない、というのは、サーバー->クライアントはやめたいですが、クライアント->サーバーは別にいいです。リリース前の考慮事項として記録はしておいて。一旦ユーザー私だけなので大丈夫」
(that logs are not synced: server to client should stay off, but client to server is
fine; record it as something to consider before release; for now the owner is the only
user, so it is fine). Implemented (local tests only; not deployed). Amends
[ADR 0019](0019-local-diagnostics-and-logs.md) (logs are not synced) and
[ADR 0012](0012-inference-request-log.md) (what the service keeps beside the request
log). Amended on 2026-10-19 by [ADR 0058](0058-automatic-recipe-removal.md): a device
also tells the service when a login starts on a recipe revision, recipe ID and revision
only (Claude's choice, not confirmed by the owner).

Amended on 2026-10-23 by [ADR 0060](0060-recipe-layouts.md) (layouts accepted by the
owner on 2026-10-23 at 11:41 UTC; implemented on a branch, local tests only): a record
always carries `branch`, which names the layout the login ran (`<key>`, or
`<key>:account` / `<key>:other` for a chooser's branch), and the service marks that
layout used.

Date: 2026-10-18

## Context

The owner asked for speed to be recorded and shown on an owner dashboard (07:28 UTC).
The extension measures each login locally: from its first page until it ended, the time
spent waiting for the service, of that for the network, and the time spent waiting for
the person and for the site
([ADR 0019](0019-local-diagnostics-and-logs.md#amendment-2026-10-18-how-long-requests-and-logins-take)).
That stays on the device. The only login result the service had was the code of each
recipe revision's first login, kept for the evaluation corpus
([ADR 0019](0019-local-diagnostics-and-logs.md#amendment-2026-10-18-first-login-results-for-evaluation)).
Most logins are a revision's second or later and run on the recipe alone, so the service
learned nothing of them, and a dashboard could not show how fast logins are.

## Decision

- When a login on a service recipe revision ends, signed in or blocked (a watched login
  when its watch ends), the extension's worker sends one record to
  `POST /v1/recipes/:recipeId/logins`: the revision, the chooser branch when there is
  one, the `login.attempt` outcome, a cause from the fixed `loginOutcomeCauseSchema`
  list, the extension build (`PATEAT_BUILD_REVISION`), and `totalMs`, `serviceMs`,
  `networkMs`, `personMs` and `pageMs` in whole milliseconds. Every such login sends
  one, not only a revision's first; the first-login result code is sent as before.
- Never sent: a URL, path, origin, page text, reason text, label, value, username, the
  time typing took, or `otherMs` (the service derives the rest from the total).
- The service reads the site, the recipe revision's `origin`, from the revision it holds
  when it writes the row; the device does not send it. Each report is one row of the
  owner-scoped `login_timings` table with the service's own time. Rows are kept one year
  like the request log, purged with it, and counted and deleted by the web UI's Request
  log page.
- The record is sent once, in the background after the login ended. Sending never waits
  on, throws into or changes the login. A failed send is not retried or stored; the
  local log keeps the login's `login.attempt` line with its times, and the send is
  logged as a value-free `service.login` line.
- The dashboard's speed section starts with these logins.
- Logs still never go from the service to a device. Before Pateat has other users, this
  decision is revisited ([plan](../plan.md#phase-3-public-release)).

Not confirmed by the owner (the agent's choices):

- Which logins send nothing, consistent with the first-login result code: a login
  without a service recipe revision, a fill-only login, any login of an item without a
  password, and `policy-changed`, `account-switched` or cause-less `cancelled` ends. A
  result that settled as unknown without a watch has no end and no times, so it sends
  nothing either. A record the contract refuses, such as a time over a day or a build it
  does not accept, is not sent and is logged locally as `failed:invalid-record`.
- The route name `/logins`, the 1 KiB body limit, and the build as a 7 to 40 digit
  commit or `development`.
- A report for a recipe the service keeps no document of, as after its revocation, is
  refused (404), since the service cannot name its site. The site comes from the
  reported revision, or the newest kept one when that revision was pruned.
- The dashboard times only logins that signed in, as their total less the person's time;
  a login waited on the service when its `serviceMs` is above 0.
- `pageMs`, the time the login waited for the site, is sent apart from the rest, so the
  dashboard tells page loads from Pateat's own time (not asked for by the owner)
  ([timing](../architecture.md#request-and-login-timing)): it runs while the login waits
  for the result of a step that may have changed the page, until it read that result in
  the same page or the next one, and from a sign-in entry press until the next page was
  seen. The rest, `otherMs`, is Pateat's own work and waits.
- `networkMs` counts only the time to and from the Pateat service, from the service's
  `Server-Timing` header: a request whose answer did not name the service's time adds
  nothing, so 0 can also mean unknown, as for logins against a service deployed before
  it sent the header. It stays a plain number rather than a nullable one: the service
  sends the header on every device answer before any build sends records, so after that
  only requests that got no answer from the service, whose round trip still counts in
  `serviceMs`, leave it short. The dashboard calls it a lower bound.

## Consequences

- The service now learns when, and on which site, each login with a recipe happened,
  whether it signed in, and how long it took, including how long the person took to
  enter a code. It keeps this for one year unless the owner deletes it. The recipe ID is
  derived from the site's address, so the site was never hidden by the ID alone.
- The dashboard shows login speed for every login, the share that waited on the service,
  and how logins ended, not only the first login of each revision.
- Each ended login costs one more request against the owner's request limit.
- No permission is added: the service origin is already allowed.

## Alternatives

- **B: only logins that reached the service** (whose first page was generated or that
  called the judge). The service already sees their site and time, so it would learn
  only the result and times, including the person's. The dashboard would show only the
  slower logins.
- **C: none.** Times stay on the device's diagnostics page, and the dashboard shows only
  the service's own times.
