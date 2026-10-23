# ADR 0066: Warning and error log lines are sent to the service

Status: accepted by the owner on 2026-10-23 at 12:28 UTC. Of the options in the Japanese
proposal (`designs/error-log-upload-proposal-ja.md` in the project files), the owner
chose option A: the extension sends its `warn` and `error` lines automatically. A
setting to turn the sending off waits for the
[pre-release list](../plan.md#phase-3-public-release), as the revisit of
[ADR 0055](0055-login-records-sent-to-the-service.md) does. Earlier that day the owner
had asked for work to go ahead on the most likely answer and be judged later
(「フェーズは一旦無視して、ある程度決め打ちで進め、後から判断」). The other answers
below (only `warn` and `error`, 30 days on the service, the limits and the redaction)
are Claude's choices, not confirmed by the owner; open questions 1 and 2 stay open.
Implemented (local tests only; not deployed). Amends
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
  and dropped log lines.

Passkey failures (`passkey.request`, `passkey.create`) and fill-only logins are logged
at `info`, so this decision does not send them either.

The owner approved sending the first-login codes (2026-10-18 06:08 UTC) and every
login's record (08:38 UTC: client to server is fine, server to client is not), both on
condition that no value leaves.

## Decision

- The worker sends the local log's `warn` and `error` entries to
  `POST /v1/device/problems`, oldest first, each once. `debug` and `info` entries never
  leave.
- What leaves (`problemLine` in `apps/extension/src/diagnostics/log.ts`): the event,
  level and device time, and the fields a log download carries with sites shown that
  the contract lists for the event, which is the log's allowlist less the item and
  connection pseudonyms. A page URL leaves as its path alone, without the query's and
  fragment's parameter names, with each segment that may carry a token replaced by
  `[id]` as in an observation ([ADR 0039](0039-redacted-token-path-segments.md)), each
  segment holding `@` (an email address, also percent-encoded up to three times) too,
  and a last segment the log's 512-character cut may have left partial. A page after a
  submit, likely signed in and so likely to show the account's own name in its path,
  sends no path: a `login.attempt` watched for its result or settled, `recipe.judge`
  and `recipe.sample`. The log cannot read the vault, so unlike an observation a plain
  username in the path of another page of a configured site (a sign-in page under
  `/u/<name>/login`) still leaves. Origins of sites not set up stay pseudonyms the
  service cannot reverse. Exception messages stay limited to Pateat's own error codes;
  a value the log cut leaves out. The report adds the extension build; the service adds
  the device from its credential and its own time.
- The contract (`problemReportSchema`, `packages/contracts/src/problems.ts`) takes at
  most 100 lines, and checks each line's fields against the event's own list
  (`PROBLEM_EVENT_FIELDS`) by kind: codes, error names, counts, flags, builds, recipe
  IDs, origins (a configured site's or an `origin:` pseudonym), RP IDs, script
  positions and page paths. No string but a stack holds whitespace, none `@`, `?` or
  `#`, and only an origin `://`, so free text, a URL with a query or an email address is
  refused even if the extension ever let one through. The extension's test holds the
  list equal to its log's events. The service checks each line on its own
  (`problemReportEnvelopeSchema`): a line it refuses is left out and the others in the
  report are kept, so a newer extension whose new events or fields an older service does
  not know yet loses only those lines, not the good ones beside them, which the device
  never sends again. Only a report with no line that passes is refused whole.
- Sending (`apps/extension/src/service/problems.ts`): 5 seconds after a `warn` or
  `error` entry is stored, at worker start and after a successful recipe sync. At most
  50 lines and 32 KiB a request and 4 requests a run. A line identical to the last one
  sent (event, level and fields) less than an hour before it is left out, as a stuck
  vault state each new worker logs again. A cursor in the diagnostics database's `meta`
  store, per service and device, records the last key sent or passed over, the failures
  in a row, when the next run may send and the last line sent, so all of it survives a
  worker restart; pairing starts it after the newest entry, so no backlog from before it
  is sent. A failed request keeps the lines and holds off runs for 1 minute, doubling to
  at most an hour, or as long as a 429's `Retry-After` asks (at most an hour); a batch
  the service refuses (4xx) is skipped; a rejected credential sends nothing.
  Each request logs a `service.problems` line, `debug` when kept and `info` otherwise,
  never `warn`, so a failed send is not itself a line to send.
- Service: one `problem_log` row per line (migration 0028), keyed by device and `seq`,
  so a retry changes nothing and is not counted. At most 2,000 new lines per owner in
  any 24 hours (429 with `Retry-After: 3600` past it, the whole report refused; read
  before the insert, so two reports at once may pass it by one report) beside the
  existing per-owner request limit. Rows are kept 30 days, purged with the request log,
  counted and deleted by the Request log page's Delete all, and listed (newest 200) on a
  new `/manage/problems` page. Claude sessions read them through the read-only D1 query
  tool.
- No setting turns the sending off yet. Before Pateat has other users, a setting turns
  off both this and the login records of ADR 0055, and this decision is revisited with
  ADR 0055 ([plan](../plan.md#phase-3-public-release)). Logs still never go from the
  service to a device.

Open for the owner (Claude's answers above stand until the owner decides):

1. Whether `info` reasons for doing nothing (`login.refused` and the like) should be
   sent too, to find sites where Pateat silently did nothing. That is a few hundred
   lines a day and close to a history of login-related pages.
2. Whether 30 days is the right service retention, or a year like the other logs.

## Consequences

- The service learns, for sites set up in Pateat, when and at which step a login stopped
  and why, the redacted path of that page unless it came after a submit, Bitwarden and
  service failures, and extension exception names and script positions. It does not
  learn sites that are not set up, values, page text, queries, fragments or email
  addresses. A plain username can still reach it in the path of a configured site's
  page before a submit, which an observation would refuse; the redaction does not catch
  it because the log cannot read the vault.
- Claude can query the failures of every device for 30 days without the owner's report,
  and join them with `login_timings`, `login_outcomes` and the request log by recipe and
  revision.
- Each run costs at most 4 requests against the owner's request limit; an outage costs
  about one request an hour once backed off.
- No permission is added: the service origin is already allowed.

## Alternatives

- **B: a "Send logs" button on the diagnostics page.** The same lines, sent only when
  the owner presses it. Failures the owner does not notice still go unreported, which is
  the problem this solves.
- **C: none.** The local log and the bug report stay the only source; failures older
  than 14 days or never reported stay unseen.
- **Send the whole log, `info` included.** Rejected for now: more than the failures,
  close to a browsing history of login pages; left as open question 1.
