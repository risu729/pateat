# ADR 0014: Claude Opus 5.5 for recipe generation

Status: accepted by the owner on 2026-10-10. The adapter and the benchmark runner are
implemented in `packages/inference`. The first approved benchmark run on 2026-10-10
had semantic accuracy 0.9375, no false submits and one refusal; after the instruction
change below, the second run had 1.0 with no refusal. Results are in
[the plan](../plan.md#ai-evaluation-harness-progress). Amended by
[ADR 0015](0015-per-owner-claude-credentials.md): the service uses per-owner
credentials instead of one operator key.

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
  extension never holds it. [ADR 0015](0015-per-owner-claude-credentials.md) replaces
  this operator key with credentials each owner brings, starting with Workload
  Identity Federation.
- The default monthly spending limit is $100 against the $200 credit, leaving room
  for the overshoot ADR 0003 allows from in-flight and concurrent requests. The owner
  first set $150 and lowered it to $100 on 2026-10-11.
- Anthropic's server-side `fallbacks` parameter is not used. A refusal, overload or
  other failure of the configured model ends as `refused` or an error, with no
  automatic switch to another model, as ADR 0003 requires.
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
  generation role and the sign-in judge: the model handles any page language, so the
  instructions give no words or examples of a particular language (no Japanese button
  labels, no English keyword lists) and describe meanings instead. They keep the use
  statement above, the untrusted page text rule, when to abstain, and the passkey and
  authenticator-app rules; each output field's meaning is in the response format's
  descriptions rather than repeated in prose.
- On 2026-10-12 03:44 UTC the owner chose to keep the local word-list safety checks for
  passkey buttons (`namesPasskey` and `registersPasskey` in
  `packages/inference/src/plan.ts`, with English and Japanese words): they are not sent
  to the model and only refuse a button.

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
