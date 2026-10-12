# Cloudflare Clef for the finite-choice role

Researched: 2026-10-11, from Cloudflare documentation, the Workers AI schemas, package
sources and the repository's own corpus. Research only: not a plan, an evaluation or an
adoption. The owner asked on 2026-10-11 at 17:48 UTC to stop at research that assumes
Clef, because the Claude baseline needs a larger corpus of real pages first. No model
was called. It updates the
[Clef section](2026-10-10-feasibility.md#clef-update-reviewed-2026-10-10) of the
feasibility research and grants no capability.

## Summary

- **What Clef is:** Cloudflare's multiple-choice models on Workers AI. Given page
  context and a list of options, they return a probability for each option. They do
  not write free text.
- **What it could replace:** the one Claude call that maps a login page's fields and
  button (`POST /v1/recipes/generate`). Not the completion judgement, `accountSwitch`
  or second-factor handlers.
- **What is unknown:** how accurate it is on login pages, whether it handles Japanese,
  and how its probabilities are calibrated. Nothing about Clef can be measured with
  the current corpus, which Claude already gets fully right.

Terms used below:

- *Abstain*: the role declines to answer and no recipe is made.
- *Neuron*: Cloudflare's Workers AI billing unit.
- *`noul`*: Clef's yes/no question type (the AI SDK calls it `boolean`).
- *`doDecide`*: the AI SDK interface a decision-model adapter implements.

## 1. What the repository already says

- [ADR 0003](../adr/0003-service-and-ai.md):
  inference has two roles, recipe generation/repair and finite selection. "Evaluate
  Clef-flash, Clef and Jev for finite candidate decisions." Decision adapters need an
  explicit none option, validate IDs and probabilities, abstain on low confidence, and
  never fall back to another provider or model automatically. The Clef part is a
  "Proposed 2026-10-10 amendment" covering "research and evaluation scope, not provider
  adoption".
- [docs/research/2026-10-10-feasibility.md](2026-10-10-feasibility.md#clef-update-reviewed-2026-10-10)
  already covers Clef's prices, schemas and truncation as of 2026-10-10. This note
  updates it.
- [ADR 0014](../adr/0014-claude-generation-provider.md):
  "Jev and Clef are not required. The finite-choice role has no provider for now; its
  adapter contract stays, and those models may be evaluated later against the same
  corpus."
- [ADR 0015](../adr/0015-per-owner-claude-credentials.md):
  "Each owner brings their own Claude credentials. The operator never pays for another
  owner's inference."
- [docs/plan.md](../plan.md): "the
  finite-choice role" is an open M4 item; Clef-flash, Clef and Jev are "optional later
  candidates", and "evaluating a candidate does not authorize adopting it". The plain
  Formasaurus forms "cannot tell a finite-choice model apart from Claude; the synthetic
  and Japanese pages carry that comparison."
- [docs/development.md](../development.md):
  the role uses `experimental_decide` from the pinned `ai` package; "A Clef or Jev
  adapter implements that `doDecide` contract or replaces it with a direct typed
  adapter if the contract loses provider semantics."
- The role exists offline: `createFieldMappingDecider` in
  `packages/inference/src/decision.ts`, tested only with fake models. No real model has
  answered it.

## 2. What Clef is

Cloudflare's own decision models on Workers AI. A request carries a `state` (text or
JSON) and up to 64 typed questions; the model returns a probability for every allowed
option.

| | Clef-flash | Clef |
| --- | --- | --- |
| Workers AI ID | `@cf/cloudflare/clef-flash` | `@cf/cloudflare/clef` |
| Size (Cloudflare) | 9B | 27B |
| Price, input tokens only (output free) | $0.038 per million (cut from $0.09 on 2026-10-09) | $0.24 per million |
| In Workers AI neurons | 3,455 per million tokens | 21,818 per million tokens |
| Context | 24,576 tokens (hosted; was 64k) | 65,536 tokens |
| Latency (Cloudflare's measurement) | not published | 152 ms median, 351 ms p95 at about 800 tokens |

Sources: [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/),
[Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Cloudflare blog, 2026-10-09](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/).
A
[third-party overview](https://dev.classmethod.jp/en/articles/cloudflare-clef-overview/)
gives the release date as 2026-10-01 and Qwen base models, without a source; Cloudflare
says only "last week's release".

API shape
([input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json),
[output schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-output.json)):

- Request: `model` (`"clef"` or `"clef-flash"`), `state`, `questions`, optional
  `images` (up to 4). No temperature or seed.
- Question types: `choice` (`criteria` maps 2 to 255 option IDs to a description,
  which may be a string, object, array or null), `score` (ordered levels) and `noul`.
- Choice answer: `{ type: "choice", choice, probabilities, confidence }`, where
  `probabilities` maps every option to 0 to 1 and sums to 1, and `choice` is the most
  probable option.
- `usage`: `{ input_tokens, output_tokens }`.
- Calls: a Worker binding
  (`env.AI.run("@cf/cloudflare/clef-flash", { model, state, questions })`) or REST
  (`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash`
  with an API token). The REST answer is wrapped in Cloudflare's
  `{ result, success, errors }`.
- Cloudflare calls Clef "fully Jev-API compatible": the same state, questions and
  answers as Jev (typesafe.ai), with a different endpoint, key and model name.
- If text plus questions exceed the context, the text `state` is truncated. Whether
  the answer says so is not documented.
- Free allocation: 10,000 neurons a day per Cloudflare account, about 2.9 million
  Clef-flash tokens or 458,000 Clef tokens; beyond that $0.011 per 1,000 neurons on
  Workers Paid.
- Data: Workers AI "does not use your Customer Content" (inputs and outputs) to train
  models ([data usage](https://developers.cloudflare.com/workers-ai/platform/privacy/)).
- Not published: supported languages (Japanese included or not), calibration
  measurements for Clef or Clef-flash, option-order effects and resistance to injected
  text. Jev documents a lean toward the first option and steerable inputs
  ([Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13)); whether Clef
  shares them is unknown.

## 3. How it would fit

### What it would decide

What Claude decides for one login page, asked as choices. The questions are already
built by `buildFieldQuestions` in `packages/inference/src/decision.ts`. Real example,
the Rakuten Securities case in `packages/inference/src/corpus/japanese.json`
(instructions shortened):

```json
{
  "state": {
    "page": { "origin": "https://www.rakuten-sec.co.jp", "path": "/ITS/V_ACT_Login.html", "language": "ja",
      "title": "総合口座ログイン | 楽天証券", "headings": ["総合口座ログイン", "使われている文字のヒント", "ご注意ください"] },
    "slots": [
      { "id": "username", "kind": "identifier", "description": "account username, email address or login ID" },
      { "id": "password", "kind": "secret", "description": "account password" }
    ]
  },
  "questions": {
    "slot:username": { "type": "choice", "instructions": "Which element receives the account username ... Choose none unless one element clearly fits. ...",
      "criteria": { "c:c1": { "role": "text", "label": "ログインID", "group": "f1", "maxLength": 8 }, "none": "No listed element is this field." } },
    "slot:password": { "type": "choice", "instructions": "Which element receives the account password ...",
      "criteria": { "c:c2": { "role": "password", "label": "パスワード", "group": "f1", "maxLength": 20 }, "none": "No listed element is this field." } },
    "action": { "type": "choice", "instructions": "Which element continues or submits this login form? ...",
      "criteria": { "c:c6": { "role": "button", "label": "ID･パスワードでログインする", "group": "f1" },
                    "c:c7": { "role": "button", "label": "クリア", "group": "f1" },
                    "none": "No listed element continues or submits the login form." } }
  }
}
```

The correct answer is `c:c1`, `c:c2` and `c:c6` (not "クリア"). The decider turns the
answers into an `InferenceOutcome<ValidatedPagePlan>`, the type the Claude generation
role returns, but with a subset of its fields: `ok` with
`{ fields: [{ slot, candidate }], action: { candidate, purpose }, steps }` and never an
`accountSwitch` (`purpose` is derived locally: `submit` when a secret or code is
filled, else `advance`); or `abstained` (`low-confidence` below `minProbability`, which
must be 0.5 to 0.99, `missing-probabilities`, `no-action`, `no-login-form`,
`inconsistent-mapping`); or `failed`. The model never sees locators, hidden elements or
values. Clef's limits fit these requests: across the 153 current corpus cases the
largest request is 3,175 bytes (SMBC Direct), with at most 8 options in one question.

Claude keeps what Clef cannot express as a choice among page elements today: the
`accountSwitch` link, the completion judgement after sign-in
([ADR 0018](../adr/0018-recipe-generation-route.md))
and second-factor handlers
([ADR 0027](../adr/0027-per-account-login-routes.md)).

### Where in the generation path

Today the extension posts `{ version: 1, observation, slots }` to
`POST /v1/recipes/generate`; the service calls `createRecipeGenerator` (Claude) once,
checks the plan with `validatePagePlan`, saves and returns the recipe, and the executor
runs it at once. Clef would sit at that one call. Possible arrangements, for a later
owner decision once there is evidence:

- Not at runtime: an offline comparator only, like the heuristic.
- Clef first, Claude when Clef abstains: could avoid Claude's 2.0 s p50 / 3.8 s p95
  and its cost on pages Clef answers, minus Clef's own latency (unmeasured).
- Both must agree before a plan is saved.

### Adapter

- No AI SDK provider implements Clef as a decision model: `workers-ai-provider` 4.0.0
  has none. `@ai-sdk/typesafe-ai` 3.0.17 implements Jev's `decisionModel` on the same
  `@ai-sdk/provider` 4.0.26 that `ai` 7.0.137 uses, but Clef's REST answer is wrapped
  in `result`, so pointing it at Cloudflare is not a drop-in.
- A direct `doDecide` implementation over the binding or REST, with a Valibot schema
  for the answer and `noul` mapped to `boolean`, would avoid a new dependency; whether
  to write one or adopt a package is an owner choice.

## 4. Cost

For the 153 current corpus cases, state plus questions total 275,374 bytes. As a rough
estimate of one token per byte (Clef's reported tokens also include its own prompt
wrapper), one pass is about $0.011 on Clef-flash (about 950 neurons) and $0.066 on
Clef (about 6,000 neurons), both within one day's free 10,000 neurons. At runtime about
2,000 tokens per page is about $0.0001 per page on Clef-flash.

For comparison, [ADR 0018](../adr/0018-recipe-generation-route.md)
puts a new site at about two Claude calls, roughly $0.015. Clef could replace only the
generation call (about $0.0085, a little over half), and only on pages where it does
not abstain. In absolute terms that is under a cent per new site; in relative terms it
is about half of the per-site Claude cost.

## 5. Open questions

1. **Corpus first.** The current pages do not separate Clef from Claude: Claude is
   131/131 and 6/6, and plain forms are easy. A comparison needs real pages where a
   choice model can go wrong: sign-up pages with one password field (the heuristic's
   main error: formasaurus-35, -62, -140, -407), forms with "create account" or
   "cancel" next to "log in" (-216, -739, -254), bank pages with custom fields (SMBC,
   PayPay Bank), multi-step pages (Mizuho), passkey buttons next to the password form
   (MyJCB), and Japanese pages in general. This is the same corpus the owner wants for
   the Claude baseline.
2. **Japanese.** Cloudflare does not say which languages Clef supports.
3. **Sign-up pages.** Today's questions ask only which element fits, so a sign-up form
   with one password field may get a confident answer. Whether the questions need to
   ask what the form is for (sign-in, sign-up, password reset) is open.
4. **Option order and injected text.** Jev documents both; Clef does not. They could
   be measured by repeating a case with options reversed, and with the synthetic
   label-injection cases.
5. **Threshold.** `minProbability` would have to be chosen from measured
   probabilities; no calibration data is published for Clef.
6. **Who pays.** A Worker binding bills the operator's Cloudflare account, which
   conflicts with ADR 0015 ("the operator never pays for another owner's inference").
   The alternative is each owner's Cloudflare account ID and API token, a stored
   secret, unlike the secret-free Workload Identity Federation used for Claude. For one
   owner today they are the same account.
7. **Fallback rule.** "Clef first, Claude when Clef abstains" hands a page to a second
   model. ADR 0003 forbids automatic fallback after a failure; whether an abstention
   handover is allowed is an owner decision.
8. **Clef-flash truncation.** ADR 0003 says to "never depend on provider truncation of
   an observation", so the service would have to keep requests well under 24k tokens;
   `decideFields` already refuses inputs over `maxInputBytes`.
9. **Images.** Clef accepts screenshots, but the observation contract excludes them for
   privacy (ADR 0003); that stays deferred.
10. **Jev.** Same API at $0.042 per million tokens per typesafe.ai's model page, but a
    separate provider and account; not covered here since the owner asked for Clef.
