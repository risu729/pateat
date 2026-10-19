# ADR 0012: Inference request log and evaluation data

Status: accepted by the owner on 2026-10-10. The retention period was 90 days (one year
since 2026-10-18), chosen with the service route in
[ADR 0018](0018-recipe-generation-route.md). The service logs every request its
generation routes receive (since 2026-10-18; before, every request they sent); the
delete-all action comes with the web UI. Amended on
2026-10-12 by [ADR 0035](0035-page-kinds-per-site.md) (not implemented): rows of
`confirm` or `unclear` pages, or sent with `signedIn` true, are kept past 90 days until
labelled, for at most one year, and rows gain the recipe ID and revision. Amended on
2026-10-18 by the owner (06:08 UTC):
[rows for a real-page corpus](#amendment-2026-10-18-rows-for-a-real-page-corpus) gain
the recipe, branch and revisions, the build, an observation hash and the model's own
answer; every row is kept one year; and the web UI deletes them all. Implemented.
Amended on 2026-10-18 by the same decision
([login result codes](#amendment-2026-10-18-login-result-codes), with
[ADR 0019](0019-local-diagnostics-and-logs.md)): the service keeps the result code of
each recipe revision's first login beside the log. Implemented.
Amended on 2026-10-18 by the owner (08:04 UTC):
[requests answered without a model call](#amendment-2026-10-18-requests-answered-without-a-model-call)
are kept too, which amends [ADR 0018](0018-recipe-generation-route.md); invalid bodies
and requests answered 400 or 404 are not. Implemented.
Amended on 2026-10-18 by the owner (08:38 UTC):
[request timings](#amendment-2026-10-18-request-timings) record how long each logged
request took before, in and after the model call. Implemented. Amended on 2026-10-18 by
[ADR 0055](0055-login-records-sent-to-the-service.md) (owner, 08:38 UTC): the service
also keeps [a record of every login](#amendment-2026-10-18-login-records) beside the
log. Implemented. Amended on 2026-10-18 by
[ADR 0029](0029-local-sign-in-state.md#amendment-signed-in-page-samples-2026-10-18)
(owner, 08:05 UTC): the log also keeps a repeat login's signed-in page as a `sampled`
row, see [below](#amendment-2026-10-18-signed-in-page-samples). Implemented. On
2026-10-18 (owner, 08:58 UTC) the
[earlier rows were filled in](#amendment-2026-10-18-earlier-rows-filled-in) where the
stored records decide each value. Since
[ADR 0027](0027-per-account-login-routes.md#amendment-2026-10-18-slot-names-from-the-page)
was amended on 2026-10-18 (owner, 08:58:31 UTC), the model gives no slot names, so no
answer has a name to become `name-N`. Since
[ADR 0027](0027-per-account-login-routes.md#amendment-2026-10-19-slot-names-from-the-bindings)
was amended on 2026-10-19 (owner, 01:22 UTC), an accepted plan's `result` may hold a
slot name carried from the owner's saved bindings that the logged page does not show,
such as an earlier page's wording or a name the model gave before 2026-10-18.

Date: 2026-10-10

## Context

The offline harness in `packages/inference` scores roles on a 16-page synthetic
corpus. Improving prompts and choosing a provider needs real pages, and the owner
expects a hand-built corpus to lean Japanese. Inference already goes through the
service ([ADR 0003](0003-service-and-ai.md)), so every request passes the server.

## Decision

The service stores each inference request it sends and the provider's structured
response, for later evaluation and prompt improvement:

- Stored: role, provider and model ID, the instructions, the sanitized observation and
  slots exactly as sent (including [ADR 0010](0010-inference-field-hints.md) hints),
  the structured output or failure code, the local outcome code, usage and timestamp.
  Vault values are never in a request, so they are never logged. A local check result
  is logged only as its outcome code (`value-mismatch` or the post-fill stop), never
  with the slot or the reason, because "password too long for `maxLength: 4`" would
  disclose a secret's length.
- Stored in the user's service data with a retention period and a delete-all action.
  The log is private settings-class data, not diagnostics; outcome codes and service
  diagnostics stay value- and page-text-free as before.

Evaluation data:

- The synthetic corpus stays as unit-test fixtures for traps (label injection,
  decoy forms, abstention cases).
- A real-page corpus is public by default. Before publishing, review each page for
  personal data and hold back anything that looks private. A corpus entry keeps only the
  derived observation and its labeled mapping; logged field names and value shapes come
  from the user's vault and are replaced with synthetic ones. Japanese pages, including
  banks and securities, are captured from the request log and from the owner's Chrome.
- Third-party data enters the repository only as derived observations with labels and
  attribution, never as raw HTML or screenshots. Research-only datasets are used for
  private evaluation and never committed. The candidates and their terms are listed in
  [AI evaluation harness progress](../plan.md#ai-evaluation-harness-progress).
- Reusing existing per-site recipes (for example Bitwarden map-the-web) is later scope.

## Amendment 2026-10-18: rows for a real-page corpus

The owner chose on decision cards at 06:08 UTC that the log keeps what a real-page
evaluation corpus needs later, without waiting for phase 1 to finish ("今入れる"):

- Each row records the recipe it is for, the chooser branch (empty without one), the
  head revision when the call was made, the revision the call wrote (set after that
  write succeeds; none when it wrote nothing), for generation whether the page starts
  its recipe (`first`) or continues one (`continuation`), the service build, and the
  first 12 hex digits of the SHA-256 of the observation sent. `request` stays the
  instructions and input as sent.
- `answer` keeps the model's own answer next to `result`, for both roles and every
  decision, `unclear` and output the local checks refused included ("残す"): a
  generated plan before local changes, so a dropped passkey button still shows. Output
  the response format itself refused has none. Any ID that is not a candidate or slot
  of the request becomes `?` and each generated name `name-N`, so no page text quoted
  by the model and no vault field name is kept.
- Every row is kept one year instead of 90 days ("全部 1 年"), which covers ADR 0035's
  year for `confirm`, `unclear` and `signedIn` rows. Since rows hold custom field names
  and username shapes for longer, the delete-all action is built now: the web UI's
  Request log page deletes all of the owner's rows after a confirmation; recipes,
  settings and the spend the limits count stay.

Not part of this amendment: sending the extension's login outcome codes to the service
(see the next amendment), filling in earlier rows (see the amendment after it), and
exporting the corpus. The column
names (`recipe_page` and the others in `services/api/src/db/schema.ts`) and the Request
log tab at `/manage/request-log` (the web UI has no settings page for it) were the
agent's choice, not confirmed by the owner.

## Amendment 2026-10-18: login result codes

With the same decision cards (06:08 UTC, "送る"), devices send how the first login of
each recipe revision ended, as codes only
([ADR 0019](0019-local-diagnostics-and-logs.md#amendment-2026-10-18-first-login-results-for-evaluation)),
so a corpus entry joins the generation row with its result without the device's 14-day
local log:

- A new owner-scoped table `login_outcomes` keeps the recipe ID, branch (empty without
  one), revision, `outcome`, `cause` (null without one), step index and the service's
  own time, one row per revision: the first report is kept and later ones are ignored.
  The route accepts only a recipe the owner holds, at a revision up to its head that is
  not a tombstone.
- Its rows are kept one year like the log's and deleted with expired log rows. The
  Request log page counts them beside the requests, and Delete all deletes them too.
- A row is the first report the service received for its revision, not always the
  revision's first login: a revision that ran before the build that sends these codes
  reports its next login instead. The corpus builder drops outcome rows whose revision's
  generation row (the `inference_log` row with that `revision`) has no `build`, or a
  `build` that is not a descendant of the first service commit that accepts these
  reports. That commit also builds the extension that sends them. A revision whose
  first login ran on an extension older than that commit is not caught, as no row
  records the extension's build.

## Amendment 2026-10-18: earlier rows filled in

The owner chose on a decision card at 08:58 UTC to write the new columns of the 154 rows
logged before them ("書く"). The values come from the stored records: each row's own
`request` and `result`, the recipe revisions and tombstones, the recipe heads, the page
judgements, and when each row and revision was written. A value was written only where
those records decide it, one row per statement by `id`, and only into an empty column of
a row with no `build` from before the columns were added.

- `observation_hash` and `recipe_id` are set on every earlier row.
- `revision` stays empty where the recipe was revoked later and the revision the row
  wrote is gone, and on rows that wrote none.
- `answer` stays empty where the model's own answer cannot be rebuilt exactly: a
  generated plan whose dropped passkey button left no trace, or a challenge judgement
  whose code source or dropped field was not recorded.
- `build` stays empty on every earlier row and `prompt_version` where it was empty;
  their values at the time are not known.

So on a row with no `build`, an empty column means unknown, not none: a generation row
there may have no `branch`, `recipe_page` or `base_revision` although it had one.
Undoing the fill sets the same columns of those rows back to empty; D1 Time Travel
restores the whole database, recipes and settings included, and is the last resort.

## Amendment 2026-10-18: requests answered without a model call

The owner chose on a decision card at 08:04 UTC that a request answered without calling
the model is logged too ("残す"). The log keeps every generation and judgement request
the service receives, not only each one it sends, replacing ADR 0018's "Requests
refused locally before any model call are not logged". A body that fails validation is
still not logged.

- The row's `outcome` is the code the request was answered with: a spend limit, `busy`,
  a credential code, `recently-tried`, `judgement-limit`, a page judged before
  (`already-judged`, `judged-*`, `judgement-unanswered`), `not-judgeable`,
  `recipe-revoked`, `recipe-conflict`, `recipe-limit`, `incomplete-observation`,
  `invalid-request` or `input-too-large`. It has no provider, model, usage, result or
  answer and costs nothing, so the spend limits never count it.
- `request` is what the model would have received, and the recipe columns, build and
  observation hash are kept as for a call, with `base_revision` the head read when the
  request arrived. A judgement refused before its route is found in the stored revision
  (`recipe-revoked`, `recipe-conflict`) has no `loginPaths`.

The agent's choices, not confirmed by the owner:

- A request answered with a recipe another request already stored is logged with the
  outcome `recipe`.
- A request the route refuses with 400 or 404 is not logged: a `base` ID not in the
  `gen-…` form, a page of an origin no move reaches, a missing recipe. A `gen-` ID of
  another origin answers `recipe-conflict` and is logged.
- The same request answered the same way within ten minutes (the whole `request`, with
  the role, outcome, prompt version, origin, path, recipe, branch and base revision)
  adds no row, so a client repeating a page refused as `busy` or over a limit cannot
  fill the log. The check and the insert are not atomic, so two identical requests at
  once can both be logged.
- At most 500 such rows are logged per owner and UTC day, since spend no longer bounds
  them; past that a request is answered as before and logged nowhere but the Worker log.
- A failed row write never changes the answer.

Consequences: page descriptions are now kept even when no model is called, including
those of an owner without Claude credentials (`credentials-not-configured`) and of
requests at a spend limit or answered `busy`.

## Amendment 2026-10-18: request timings

The owner asked at 07:28 UTC for speed to be recorded:
「速度を重視したいので、速度、通信にどれだけかかってるか、LLM
APIがどれくらいで返してるか、とか記録するようにしておいてほしい」. At 08:38 UTC the
owner approved the plan, whose service part needed no further choice:

- Each row records `pre_model_ms` (from the Worker receiving the request to just before
  the model call), `token_ms` (the part of it spent resolving the credential: its read,
  the signed assertion and the token exchange, done anew on every call), `model_ms` (the
  model call) and `server_ms` (from the Worker receiving the request to its response,
  the recipe write included). The first three are written with the row; `server_ms` is
  set once the response is out, without delaying it, on every logged row, including
  those whose answer wrote no recipe. A request answered without a model call has
  `server_ms` alone: its other three are null. Earlier rows keep null.
- Device responses carry the standard `Server-Timing` header with `total`, and a
  generation or judgement that called the model adds `token` and `model`, so the
  extension can tell network time from service time. No `Timing-Allow-Origin` is sent.

Agent choices not confirmed by the owner: the times start before device authentication
and the request limit, `model_ms` includes the role's local output checks, a request
refused at the credential step or by the role's local checks reports `token` alone, and
a failed `server_ms` update leaves it null.

## Amendment 2026-10-18: login records

With [ADR 0055](0055-login-records-sent-to-the-service.md) (owner, 08:38 UTC), devices
send a record of every login on a recipe revision that ends. A new owner-scoped table
`login_timings` keeps one row per report: the recipe ID, branch, revision, the recipe's
`origin` as the service reads it from the revision, `outcome`, `cause`, the extension
build, `total_ms`, `service_ms`, `network_ms`, `person_ms` and the service's own time.
Its rows are kept one year like the log's and deleted with expired log rows, and the
Request log page counts them and deletes them with Delete all. They are for the owner
dashboard, not the corpus, whose result comes from `login_outcomes`.

## Amendment 2026-10-18: signed-in page samples

By the owner's decision of 08:05 UTC
([ADR 0029](0029-local-sign-in-state.md#amendment-signed-in-page-samples-2026-10-18)),
the service also receives, at most once in 30 days per recipe and branch, the signed-in
page of a login its marker completed, described as for the judge. It is logged as a
`judge` row with the outcome `sampled`, `request` built as the judge's would be (with
`loginPaths`), `base_revision` the sampled revision, no provider, model, usage, result
or answer, and cost 0. No model is called. Like a request answered without a model
call, it records `server_ms` alone of the
[request timings](#amendment-2026-10-18-request-timings). The year's retention and
Delete all cover it. These rows neither count toward nor are stopped by the daily cap
of 500 rows answered without a model call, since the 30-day rule bounds them, and the
owner dashboard leaves them out, as neither requests nor failures (agent's choices, not
confirmed by the owner).

## Consequences

The service holds which sites a user signs in to and their page labels and field
names. Deleting the log does not affect recipes or settings. Raw page HTML stays out
of the repository, so a public corpus depends on the observation extractor.

## Alternatives

- Extension-local log with manual export: keeps data on the device, but inference
  requests already reach the server and per-device logs would need merging.
- No log: leaves only synthetic and third-party pages, with little Japanese coverage.
