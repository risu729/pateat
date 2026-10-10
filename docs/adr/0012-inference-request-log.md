# ADR 0012: Inference request log and evaluation data

Status: accepted by the owner on 2026-10-10; not implemented. The retention default is
chosen with the service route.

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

## Consequences

The service holds which sites a user signs in to and their page labels and field
names. Deleting the log does not affect recipes or settings. Raw page HTML stays out
of the repository, so a public corpus depends on the observation extractor.

## Alternatives

- Extension-local log with manual export: keeps data on the device, but inference
  requests already reach the server and per-device logs would need merging.
- No log: leaves only synthetic and third-party pages, with little Japanese coverage.
