# ADR 0014: Claude models for recipe generation and the sign-in judge

Status: accepted by the owner on 2026-10-10. The adapter and the benchmark runner are
implemented in `packages/inference`. The first approved benchmark run on 2026-10-10
had semantic accuracy 0.9375, no false submits and one refusal; after the instruction
change below, the second run had 1.0 with no refusal. Results are in
[the plan](../plan.md#ai-evaluation-harness-progress). Amended by
[ADR 0015](0015-per-owner-claude-credentials.md): the service uses per-owner
credentials instead of one operator key. Amended on 2026-10-23: generation uses Claude
Sonnet 5.5 and the sign-in judge keeps Opus 5.5, each charged at its own rates
([separate models per role](#separate-models-per-role-2026-10-23)).

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
  effort `low` (Sonnet 5.5 since 2026-10-23, see
  [separate models per role](#separate-models-per-role-2026-10-23)). The owner chose
  `low` as the tradeoff between speed and accuracy; Opus 5.5 always thinks, and effort
  bounds how much.
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

### Separate models per role (2026-10-23)

- The generation role (`generate`) uses `claude-sonnet-5-5` at effort `low`
  ($2 and $10 per million tokens, checked 2026-10-23). The sign-in judge (`judge`)
  keeps `claude-opus-5-5` at effort `low` ($4 and $20).
- `claudeRoles` in `packages/inference/src/providers/claude.ts` holds each role's model,
  effort and rates; `createClaudeModel({ ...credential, role })` builds that role's
  model. The service reserves, corrects and logs each call at its role's model and rates
  (`modelId` and `costMicroUsd` in the request log); the monthly and daily caps stay
  shared by both roles.
- Evidence, from the paid model comparison of 2026-10-23 (same instructions, effort
  `low`, accuracy as correct plus correct abstentions over cases):

  | Corpus | Opus 5.5 | Sonnet 5.5 | Opus 5.5 $/call | Sonnet 5.5 $/call |
  | --- | --- | --- | --- | --- |
  | Synthetic generation, 17 pages (Opus 4 runs, Sonnet 3) | 0.882 | 1.000 | 0.0117 | 0.0056 |
  | Formasaurus, 131 pages (Opus 2 runs, Sonnet 1) | 0.985 | 1.000 | 0.0120 | 0.0060 |
  | Japanese 71 and English 18 live pages (Opus 2 runs, Sonnet 1) | 1.000 | 1.000 | about 0.0117 | about 0.0059 |
  | Synthetic judged pages, 31 (Opus 6 runs, Sonnet 3) | 0.989 | 0.817 | 0.0097 | 0.0042 |

  Generation differs on four pages only: two synthetic pages where Opus abstains
  (`en-label-injection`, a label telling the model to delete the account, and
  `ja-fullwidth-pin`, a password into a field labelled as a four-digit PIN) and two
  Formasaurus sign-up pages where Opus names a "Log in" link as an entry and fails as
  `invalid-output`; neither model stored a wrong recipe. Sonnet's p50 latency was about
  0.3 s lower. As a judge, Sonnet mostly answered the marker as button text instead of a
  candidate ID, so the judge stays on Opus.
- The corpora are synthetic and public pages; production `inference_log` pages
  (multi-step banks, account lists, entry pages) were not replayed. Sonnet 5.5 can still
  refuse (its categories include `cyber`); Sonnet 5.5 and Haiku 5.5 refused none of
  about 470 comparison calls, while Fable 5.1 and Opus 5 refused Japanese PIN and SMS
  pages as `cyber`. Opus 5.5 refused one judge call as `reasoning_extraction` and ran
  one into the 8,192-token output limit after 59.7 s (`en-method-chooser`). A refusal
  still ends the call as `refused`, with no fallback. The choice is to be re-checked
  against a replay of production `inference_log` pages.

Estimated cost per generation call, assuming about 3,000 input tokens and about 1,000
output tokens including thinking, at $4 and $20 per million: about $0.03, or about
6,000 calls per month on $200. These are estimates; the benchmark reports measured
usage. At Sonnet 5.5's rates the same call is about $0.016; the 2026-10-23 comparison
measured about $0.006 per generation call and $0.010 per Opus 5.5 judge call.

## Consequences

Recipe generation depends on one provider and one model per role, so an Anthropic
outage, or a refusal or outage of a role's model, stops new recipe generation or sign-in
judgement until it recovers or the owner changes the configuration. Saved recipes keep
working without inference.

`low` effort may lower accuracy on harder pages. The benchmark measures semantic
accuracy and false submits at this setting, and a higher effort or another model is
an owner decision on that evidence.

## Alternatives

- `claude-sonnet-5-5` ($2/$10 per million, about $0.016 per call) or
  `claude-haiku-5-5` ($0.10/$0.50, about $0.001 per call): cheaper; not chosen at first
  while the credit covers the expected volume. Sonnet 5.5 became the generation model on
  2026-10-23 on the comparison above. Haiku 5.5 low scored like Opus 5.5 on generation
  (0.882 synthetic, 0.992 Formasaurus) and scored 0.785 as a judge.
- One model for both roles: simpler, but either generation stays on Opus or the judge
  moves to Sonnet, which scored 0.817 against Opus's 0.989 on the judged pages.
- Opus 5.5 in fast mode (research preview, $8/$40 per million): about 0.9 s faster per
  generation call at twice the price, and only the first sign-in on a site waits for
  generation.
- Higher effort on Opus 5.5: more accurate on hard pages, slower and more expensive.
- Requiring Jev or Clef for finite-choice decisions: unnecessary while generation
  covers the initial path.
- Calling the Anthropic SDK directly instead of the AI SDK provider: would bypass the
  harness's existing structured-output and outcome handling.
