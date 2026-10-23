# ADR 0014: Claude Opus 5.5 for recipe generation

Status: accepted by the owner on 2026-10-10. The adapter and the benchmark runner are
implemented in `packages/inference`. The first approved benchmark run on 2026-10-10
had semantic accuracy 0.9375, no false submits and one refusal; after the instruction
change below, the second run had 1.0 with no refusal. Results are in
[the plan](../plan.md#ai-evaluation-harness-progress). Amended by
[ADR 0015](0015-per-owner-claude-credentials.md): the service uses per-owner
credentials instead of one operator key. Amended by
[ADR 0040](0040-running-without-the-service.md): a device may hold its own key and make
the calls itself.

Date: 2026-10-10

## Context

[ADR 0003](0003-service-and-ai.md) prefers Claude structured generation for unknown
recipes once usable API credit is confirmed, and lists Clef-flash, Clef and Jev as
candidates to evaluate for finite candidate decisions. The owner confirmed $200 of
monthly Claude API credit and chose the model. The offline harness in
`packages/inference` already implements the generation/repair role with AI SDK
`generateText` and structured output, and the finite-choice role with
`experimental_decide`.

## Decision

- The generation/repair role uses the Claude API with model `claude-opus-5-5` and
  effort `low`. The owner chose `low` as the tradeoff between speed and accuracy;
  Opus 5.5 always thinks, and effort bounds how much.
- The adapter uses the official AI SDK provider `@ai-sdk/anthropic`, version-matched
  to the pinned `ai` package.
- The API key stays on the server as a Worker secret, as ADR 0003 requires. The
  extension never holds it (until [ADR 0040](0040-running-without-the-service.md), where
  a device may hold its own owner's key).
  [ADR 0015](0015-per-owner-claude-credentials.md) replaces this operator key with
  credentials each owner brings, starting with Workload Identity Federation.
- The default monthly spending limit is $100 against the $200 credit, leaving room
  for the overshoot ADR 0003 allows from in-flight and concurrent requests. The owner
  first set $150 and lowered it to $100 on 2026-10-11. Nothing is reserved before a
  call (owner, 2026-10-23 11:31 UTC): each call checks the stops first and is charged
  after it returns, from reported usage, or at its upper bound (64 KiB of input as
  tokens plus 1,024 output tokens at its rates) when usage is unknown. With one call at
  a time per owner, a stop is overshot by at most the call that crossed it. The calls
  run under the request's `waitUntil`, so a client that disconnects mid-call cannot
  leave a sent call uncharged. The owner may bring the reservation back if overshoot
  becomes a problem (12:16 UTC).
- Anthropic's server-side `fallbacks` parameter is not used. An overload or other
  failure of the configured model ends as an error, with no automatic switch to another
  model, as ADR 0003 requires. A refusal is the one exception (owner, 2026-10-23 11:04
  UTC): the service asks the owner's next choice (below) the same request, as a call of
  its own with its own request log row, unless the refused call reached a spend stop.
  The last choice's refusal ends the request as `refused`. The service retries rather
  than sending `fallbacks`, since Anthropic's server-side fallback does not retry every
  refusal category, such as the `reasoning_extraction` refusals Opus 5.5 gave in the
  2026-10-23 comparison.
- Each owner chooses the models (owner, 2026-10-23 11:11 and 11:31 UTC). For each role
  (`generate`, `judge`) the owner saves an ordered list of up to three choices, each a
  provider (`anthropic`; others such as OpenAI may follow), model, effort and speed
  (`standard` or `fast`), in `inference_model_configs`. Only the web UI's Claude page
  (`/manage/claude`) reads or writes it; device tokens cannot, so a stolen one cannot
  raise the cost per call. Without a saved list both roles ask `claude-opus-5-5` at
  effort `low`, then `claude-sonnet-5-5` at `low` after a refusal
  (`DEFAULT_MODEL_CONFIG`). A choice in fast mode whose call fails `rate-limited`,
  `provider-error` or `timeout` asks the same model at the standard speed; a refusal
  skips that and asks the next choice, and any other failure ends the request. Each call
  is logged with its model, `effort` and `speed`.
- The page lists the models the Models API returns with the owner's own credential,
  read for each request (a new token exchange, no cache) and never needed by a login:
  only the newest of each `line` by `created_at` (and, while that one has no price yet,
  the newest priced one too), plus every model the saved lists name, with the efforts
  its `capabilities` accept. Models without structured output are left out. When that
  call fails the page lists the pricing page's models instead, newest per family, with
  every effort. A model without a published price is shown but cannot be chosen, and is
  written to the Worker log (`Claude model has no price`) so it can be found later; a
  saved choice that loses its price is skipped at call time with the same kind of log
  line, and a role left with none asks the defaults. Fast mode cannot be chosen where
  the pricing page lists no fast price, or while the owner's last three fast calls of
  that model in the last seven days all failed as above, as when the organization has
  no fast mode access; a saved fast choice of such a model then runs at the standard
  speed. Retirement dates are not shown.
- Model rates are not written by hand (owner, 2026-10-23 11:31 UTC). `mise run
  //packages/inference:pricing` reads the model and fast mode tables of Anthropic's
  public pricing page (`https://platform.claude.com/docs/en/about-claude/pricing.md`)
  into `packages/inference/src/providers/claude-pricing.json`, keyed by the page's model
  names, which a model ID maps to (`claude-opus-5-5` is `Claude Opus 5.5`, as the Models
  API's display name also reads), and stops on any table it
  cannot read whole. The service and the benchmark charge those rates; Haiku 5.5's
  higher price above 100,000 prompt tokens is kept too, though the 64 KiB input bound
  keeps every call below it. The pricing workflow
  (`.github/workflows/pricing.yml`) runs the task daily and proposes any change as a
  pull request, merged like any other once CI passes. The Models API carries no prices
  and no fast mode flag, so the page is the provider's only source for both.
- Jev and Clef are not required. The finite-choice role has no provider for now; its
  adapter contract stays, and those models may be evaluated later against the same
  corpus. On 2026-10-11 the owner chose to implement the role with Clef in
  [phase 3](../plan.md#phase-3-public-release) of the roadmap.
- The owner approved one paid benchmark run of the synthetic corpus with this
  configuration. Further paid runs and the service route need their own approval
  (the route was approved in [ADR 0018](0018-recipe-generation-route.md)).
  The benchmark runs outside the service, so it reads the key from `ANTHROPIC_API_KEY`
  in the environment of the session that runs it. Cloud sessions withhold that name,
  so there the key is stored as `PATEAT_ANTHROPIC_API_KEY` and passed in as
  `ANTHROPIC_API_KEY="$PATEAT_ANTHROPIC_API_KEY"`.
- After that run refused the unlabeled bank page, the owner approved stating the use
  in the generation instructions (the credentials' owner signing in to their own
  account, values filled locally), recording the refusal category code, and one more
  run of the full corpus to check the change.
- On 2026-10-12 03:31 UTC the owner chose short, language-neutral instructions for the
  generation role, the sign-in judge and the finite-choice questions: the model handles
  any page language, so the instructions give no words or examples of a particular
  language (no Japanese button labels, no English keyword lists) and describe meanings
  instead. They keep the use statement above, the untrusted page text rule, when to
  abstain, and the passkey and authenticator-app rules; each output field's meaning is
  in the response format's descriptions rather than repeated in prose. The generic
  English slot ID that the model returns stays, since it is an output format from
  [ADR 0027](0027-per-account-login-routes.md), not a hint about the page's language.
- On 2026-10-12 03:44 UTC the owner chose to keep the local word-list safety checks for
  passkey buttons (`namesPasskey` and `registersPasskey`, now in
  `packages/contracts/src/passkey-button.ts`, with English and Japanese words): they are
  not sent to the model and only refuse a button.
- On 2026-10-23 the owner compared Claude models and fast mode on both roles (results in
  [the plan](../plan.md#ai-evaluation-harness-progress)) and kept `claude-opus-5-5` at
  effort `low` for both, without fast mode (11:03 UTC). The results stay recorded as
  the options for a faster model if the finite-choice role (the decisions API, Jev or
  Clef) falls short. The owner also set each call's timeout to 10 seconds and its
  output to 1,024 tokens, down from 60 seconds and 8,192 (11:03 UTC): every Opus 5.5
  call in that comparison that succeeded took under 7 seconds and wrote under 300
  tokens, while a judgement that kept thinking after its answer ran to the output bound
  in about 55 seconds.

Estimated cost per generation call, assuming about 3,000 input tokens and about 1,000
output tokens including thinking, at $4 and $20 per million: about $0.03, or about
6,000 calls per month on $200. These are estimates; the benchmark reports measured
usage.

## Consequences

Recipe generation depends on one provider and one model, so an Anthropic outage or
a refusal stops new recipe generation until it recovers or the owner changes the
configuration. Saved recipes keep working without inference.

`low` effort may lower accuracy on harder pages. The benchmark measures semantic
accuracy and false submits at this setting, and a higher effort or another model is
an owner decision on that evidence.

## Alternatives

- `claude-sonnet-5-5` ($2/$10 per million, about $0.015 per call) or
  `claude-haiku-5-5` ($0.10/$0.50, about $0.001 per call): cheaper; not chosen while
  the credit covers the expected volume.
- Higher effort on Opus 5.5: more accurate on hard pages, slower and more expensive.
- Requiring Jev or Clef for finite-choice decisions: unnecessary while generation
  covers the initial path.
- Calling the Anthropic SDK directly instead of the AI SDK provider: would bypass the
  harness's existing structured-output and outcome handling.
