# ADR 0012: Inference request log and evaluation data

Status: accepted by the owner on 2026-10-10. The retention period is 90 days, chosen
with the service route in [ADR 0018](0018-recipe-generation-route.md). The service logs
every request its generation routes send; the delete-all action comes with the web UI.
Amended on 2026-10-12 by [ADR 0035](0035-page-kinds-per-site.md) (not implemented):
rows of `confirm` or `unclear` pages, or sent with `signedIn` true, are kept past 90
days until labelled, for at most one year, and rows gain the recipe ID and revision.
Amended on 2026-10-18 by the owner (06:08 UTC):
[rows for a real-page corpus](#amendment-2026-10-18-rows-for-a-real-page-corpus) gain
the recipe, branch and revisions, the build, an observation hash and the model's own
answer; every row is kept one year; and the web UI deletes them all. Implemented.

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
  decision, `unclear` and refused output included ("残す"): a generated plan before
  local changes, so a dropped passkey button still shows. Any ID that is not a candidate
  or slot of the request becomes `?` and each generated name `name-N`, so no page text
  quoted by the model and no vault field name is kept.
- Every row is kept one year instead of 90 days ("全部 1 年"), which covers ADR 0035's
  year for `confirm`, `unclear` and `signedIn` rows. Since rows hold custom field names
  and username shapes for longer, the delete-all action is built now: the web UI's
  Request log page deletes all of the owner's rows after a confirmation; recipes,
  settings and the spend the limits count stay.

Not part of this amendment: sending the extension's login outcome codes to the service,
filling in earlier rows, and exporting the corpus. The column names (`recipe_page` and
the others in `services/api/src/db/schema.ts`) were the agent's choice, not confirmed by
the owner.

## Consequences

The service holds which sites a user signs in to and their page labels and field
names. Deleting the log does not affect recipes or settings. Raw page HTML stays out
of the repository, so a public corpus depends on the observation extractor.

## Alternatives

- Extension-local log with manual export: keeps data on the device, but inference
  requests already reach the server and per-device logs would need merging.
- No log: leaves only synthetic and third-party pages, with little Japanese coverage.
