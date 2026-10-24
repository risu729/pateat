# ADR 0066: Warning, error and did-nothing log lines are sent to the service

Status: accepted by the owner on 2026-10-23. At 12:28 UTC, of the options in the
Japanese proposal (`designs/error-log-upload-proposal-ja.md` in the project files), the
owner chose option A: the extension sends its `warn` and `error` lines automatically. A
setting to turn the sending off waits for the
[pre-release list](../plan.md#phase-3-public-release), as the revisit of
[ADR 0055](0055-login-records-sent-to-the-service.md) does. At 13:00 UTC, on decision
cards, the owner answered the two remaining questions: the `info` lines that say why
Pateat did nothing are sent too (option B), and the service keeps the lines a year like
its other logs (option A). Earlier that day the owner had asked for work to go ahead on
the most likely answer and be judged later
(「フェーズは一旦無視して、ある程度決め打ちで進め、後から判断」). Which `info` events
count as doing nothing, the limits and the redaction are Claude's choices, not confirmed
by the owner. Implemented (local tests only; not deployed). Amends
[ADR 0019](0019-local-diagnostics-and-logs.md) (logs are not synced) and
[ADR 0055](0055-login-records-sent-to-the-service.md) (what a device sends).

Date: 2026-10-23

## Context

The owner uses Pateat on many sites and wants Claude to find and fix failures without a
report for each ([plan](../plan.md#phase-2-use-it-and-fix-what-comes-up)). The local log
([ADR 0019](0019-local-diagnostics-and-logs.md)) records why each login stopped, but it
stays on the device for 14 days and reaches Claude only when the owner copies the bug
report or downloads the log. The service already receives value-free records: each
recipe revision's first login result (`login_outcomes`), every ended login's result and
times (`login_timings`, ADR 0055), recipe use (ADR 0058), and the generation and
judgement requests it serves (ADR 0012). It does not receive:

- exceptions that stopped a login (`login.exception`) or the worker (`error.unhandled`);
- how a login stopped beyond the outcome and cause: the step, route, reason, stop and
  the page's path, and logins with no record at all, such as a repeat login whose result
  settled as unknown;
- Bitwarden failures (`vault.sync`, `vault.check`, `vault.refresh`, `vault.state`),
  service sync and send failures, generation requests that never reached the service,
  and dropped log lines;
- why Pateat did nothing on a page of a site set up in it, which the log records at
  `info`: a refused start (`login.refused`), a refused sign-in entry press
  (`login.entry`), a page generation skipped or abstained from.

The owner approved sending the first-login codes (2026-10-18 06:08 UTC) and every
login's record (08:38 UTC: client to server is fine, server to client is not), both on
condition that no value leaves.

## Decision

- The worker sends to `POST /v1/device/problems`, oldest first and each once, the local
  log's `warn` and `error` entries, and the `info` entries that say why Pateat did
  nothing (`PROBLEM_INFO_LINES` in `packages/contracts/src/problems.ts`): every
  `login.refused`, a `login.entry` with outcome `refused`, and a `recipe.generate` with
  outcome `skipped`, `abstained` or `unavailable`. `debug` entries and other `info`
  entries never leave. Passkey reports (`passkey.request`, `passkey.create`) and
  fill-only logins stay local, at any level: the events are `LOCAL_ONLY_EVENTS` in
  `packages/contracts/src/problems.ts`, and every line of a fill-only login that may be
  a `warn` (`login.attempt`, `login.exception`), and its `login.start`, carries the
  local log's `fillOnly` flag (`LOCAL_ONLY_FLAG`). Such a login writes no `recipe.judge`
  line: it never takes a step with an effect, and the attempt contract refuses it a
  judgement at its stop. Neither is in
  `PROBLEM_EVENT_FIELDS`, so the service refuses them too. The tab's asking after the
  fill (`login.refused` `logged-out`) is not the login's line and still leaves.
- What leaves (`problemLine` in `apps/extension/src/diagnostics/log.ts`): the event,
  level and device time, and the fields a log download carries with sites shown that
  the contract lists for the event, which is the log's allowlist less the item and
  connection pseudonyms. A page URL leaves as its path alone, without the query's and
  fragment's parameter names, with each segment that may carry a token replaced by
  `[id]` as in an observation ([ADR 0039](0039-redacted-token-path-segments.md)), each
  segment holding `@` (an email address, also percent-encoded up to three times) too,
  and a last segment the log's 512-character cut may have left partial.
- Only a line's own page (`url`) may leave as a path, never another page's, such as the
  tab's previous page (`previousUrl`). It leaves only on an allowlist (`pathAllowed`) of
  event and state, outcome or reason known to come before a login's submit, where the
  path is a recipe's own or one already sent for generation: a login's start
  (`login.start`); a login blocked at a step it neither filled nor clicked, before it
  submitted anything and in the document it began in, outside a handler and not settled
  (`login.attempt` `blocked` with `unsubmitted` and `wrong-account`, `account-switched`,
  `value-mismatch`, `fill-rejected` or `account-not-listed`); an exception under the
  same `unsubmitted` flag (`login.exception`), which the runtime sets when the attempt's
  submissions are 0 and it is still in the document this worker began it in, so never
  for a resumed or recovered login or after a passkey answer fell back; a sign-in entry
  press refused by one of the checks before the press, on the entry recipe's own path
  (`login.entry` `refused`; not `unconfirmed`, `exception` or `page-changed`); a new
  login's page where a recipe starts but its first step is missing (`login.refused`
  `not-started` with `first-step-missing`); a page sent for generation and not read as
  signed in (`recipe.generate` `abstained`, `unavailable`, `failed`, or `skipped` as
  `sending` or `sent`); and a recipe the chosen item cannot run at a new login's first
  page (`recipe.unfit`, which replaced `recipe.revoke` with
  [ADR 0041](0041-repair-stale-recipes.md)). Everything else sends no path: a watched,
  settled, reconciling or awaited login, one blocked by a challenge, an ended watch, a
  cancel, a move to another origin, a rejected or unknown submit or a handler step;
  every other refusal, as one of a resumed login may come from its page after a submit;
  generation skipped on another page, as after a sign-in, while signed in elsewhere or
  when a username shows; every other event; and any event, outcome or reason added to
  the log later until it is listed. The log cannot read the vault, so unlike an
  observation a plain username in the path of a configured site's page before a submit
  (a sign-in page under `/u/<name>/login`) still leaves.
- Origins of sites not set up stay pseudonyms the service cannot reverse. Exception
  messages stay limited to Pateat's own error codes; a value the log cut leaves out.
  Each entry records the build that wrote it, and a request carries only one build's
  lines, so stack positions are read against their own bundle (entries of older logs
  without a build go with the current one). Each request carries the log's random ID
  (`logId`), made once with the diagnostics database and kept in its `meta` store; the
  service adds the device from its credential and its own time.
- The contract (`problemReportSchema`) takes at most 100 lines, and checks each line's
  fields against the event's own list (`PROBLEM_EVENT_FIELDS`) by kind: codes, error
  names, counts, flags, builds, recipe IDs, origins (a configured site's or an `origin:`
  pseudonym), script positions and page paths. No string but a stack holds
  whitespace, none `@`, `?` or `#`, only an origin `://`, and no path `;` or `=`, so
  free text, a URL with a query or parameters or an email address is refused even if the
  extension ever let one through. An `info` line passes only for an event and outcome of
  `PROBLEM_INFO_LINES`. The extension's test holds the list equal to its log's events.
  The service checks each line on its own (`problemReportEnvelopeSchema`): a line it
  refuses is left out and the others in the report are kept, so a newer extension whose
  new events or fields an older service does not know yet loses only those lines, not
  the good ones beside them, which the device never sends again. Only a report with no
  line that passes is refused whole.
- Sending (`apps/extension/src/service/problems.ts`): 5 seconds after an entry that goes
  is stored, at worker start and after a successful recipe sync. At most 50 lines and 32
  KiB a request and 4 requests a run; a read that looks at 2,000 entries without filling
  a batch goes on within the run. A line identical to the last one sent (event, level
  and fields) less than an hour before it is left out, as a stuck vault state each new
  worker logs again. A cursor in the diagnostics database's `meta` store, per service
  and device, records the last key sent or passed over, the failures in a row, when the
  next run may send and the last line sent, so all of it survives a worker restart;
  pairing starts it after the newest entry, so no backlog from before it is sent. A
  failed request keeps the lines and holds off runs for 1 minute, doubling to at most an
  hour, or as long as a 429's `Retry-After` asks (at most an hour). A 404 or 405, as
  from a service not yet deployed with the route, is such a failure. Another refusal
  (4xx) skips the batch; a rejected credential sends nothing. Each request logs a
  `service.problems` line, `debug` when kept and `info` otherwise, never `warn`, and
  never an event that goes, so a failed send is not itself a line to send.
- Service: one `problem_log` row per line (migration 0028), keyed by device, log ID and
  `seq`, so a retry changes nothing and is not counted, and a log made again on the
  device, whose `seq` restarts, never collides with the old one's rows. At most 2,000
  new lines per owner in any 24 hours (429 with `Retry-After: 3600` past it, the whole
  report refused; read before the insert, so two reports at once may pass it by one
  report) beside the existing per-owner request limit. A device keeps at most 1,000
  `warn` and `error` lines over 14 days, and the did-nothing `info` lines are estimated
  at a few hundred a day (each is logged once per reason and page, or once per
  document), so a day's lines fit with room for a backlog after an outage; past the cap
  the device keeps its lines and sends them later. Rows are kept a year, like the
  request log, purged with it, counted and deleted by the Request log page's Delete all,
  and listed (newest 200) on a new `/manage/problems` page. Claude sessions read them
  through the read-only D1 query tool.
- No setting turns the sending off yet. Before Pateat has other users, a setting turns
  off both this and the login records of ADR 0055, and this decision is revisited with
  ADR 0055 ([plan](../plan.md#phase-3-public-release)). Logs still never go from the
  service to a device.

## Consequences

- The service learns, for sites set up in Pateat, when and at which step a login stopped
  and why, why Pateat did nothing on a page of such a site, the redacted path of those
  pages before a submit, Bitwarden and service failures, and extension exception names
  and script positions. With the did-nothing lines this comes close to a history of the
  login-related pages visited on those sites, which the owner accepted. It does not
  learn sites that are not set up, values, page text, queries, fragments or email
  addresses. A plain username can still reach it in the path of a configured site's
  page before a submit, which an observation would refuse; the redaction does not catch
  it because the log cannot read the vault.
- Claude can query the failures and the pages where nothing happened, of every device,
  for a year without the owner's report, and join them with `login_timings`,
  `login_outcomes` and the request log by recipe and revision.
- Each run costs at most 4 requests against the owner's request limit; an outage costs
  about one request an hour once backed off.
- No permission is added: the service origin is already allowed.

## Alternatives

- **B: a "Send logs" button on the diagnostics page.** The same lines, sent only when
  the owner presses it. Failures the owner does not notice still go unreported, which is
  the problem this solves.
- **C: none.** The local log and the bug report stay the only source; failures older
  than 14 days or never reported stay unseen.
- **Only `warn` and `error`.** Fewer lines, but the sites where Pateat silently did
  nothing stay unseen; the owner chose to send the did-nothing lines too.
- **Send the whole log, `info` included.** Rejected: more than failures and did-nothing
  reasons, close to a browsing history of every page a login touches.
- **Keep the lines 30 days.** Enough to fix a failure, but the owner chose a year, the
  same as the other logs.
