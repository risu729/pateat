# ADR 0083: Clef first for sign-in forms, Claude when Clef abstains

Status: accepted by the owner on 2026-11-04. The owner agreed to the design at 05:56 UTC
(「それでいいと思う」): Clef answers a sign-in form at a threshold of 0.7, and Claude
answers when Clef abstains. At 05:59 UTC the owner decided how it is paid and called
(「clefはclaudeと同様のコスト負担で。とりあえずローカルからはトークンで、サーバーからならworkersなのでそのまま繋げるはず」):
Clef's cost is carried the way Claude's is, a device calls it with a Cloudflare token,
and the service calls it through its Workers AI binding. Details marked "chosen by an
agent" were not asked. The questions and the decision role are implemented in
`packages/inference` (`buildFieldQuestions`, `createFieldMappingDecider`,
`createClefBindingModel`), and the service asks Clef through its binding (`sendClefCall`
in `services/api/src/claude/calls.ts`). A device without a pairing asks Clef with its
own Cloudflare token (`callModel` in `apps/extension/src/service/device-generation.ts`);
a paired device with its own Anthropic key does not call Clef yet, and its requests go
to Claude as before. Amends [ADR 0003](0003-service-and-ai.md) and
[ADR 0014](0014-claude-generation-provider.md).

Date: 2026-11-04

## Context

[ADR 0003](0003-service-and-ai.md) listed Cloudflare's Clef models as candidates for
finite candidate decisions. [ADR 0014](0014-claude-generation-provider.md) chose Claude
for generation. On the owner's request-log corpus
([ADR 0012](0012-inference-request-log.md)) Claude Opus 5.5 at low effort answers in
about 2.5 s (p50) and costs about $0.014 a page. Clef answers a set of finite-choice
questions in about 0.3 s, deterministically and whatever the option order, at a fraction
of the cost. Asked with the role's first questions (one choice per slot and one for the
action), Clef got 103 of the 144 corpus pages it can answer right, with one false
submit; Claude got 139.

## Decision

### The questions

Each request with slots for a page with a sign-in form is asked in two Clef calls at
once, over one state: the page's origin, path, language, title and headings, the
request's slots, and every element with its role, label, placeholder, description,
autocomplete token, form group, lengths and input mode. Locators and values never leave
the device.

- **Form call.** For each element some slot fits, which of the user's values goes there.
  For each slot, which element receives it, with the slot's field name and value shape
  written out and a one-time code described as one from an authenticator app, never one
  the page says it sent. The action, among the page's buttons, with `enter` (no listed
  button submits: pressing Enter in the last field does,
  [ADR 0064](0064-enter-in-a-form-without-a-button.md)) and `none`. And yes or no: does
  the page sign in to an existing account?
- **Page call.** The passkey button, asked only among buttons that name a passkey and do
  not register one. The account switch, among buttons and links. And yes or no: does the
  page ask a signed-in user to confirm an action, does submitting it do something that
  cannot be undone, and does it show other identifier sets beside the first?

Asked in the form call, the page questions moved the form answers by up to 0.19 and
sent three more corpus pages to Claude, so they are a call of their own.

### What Clef answers

Clef answers the page only when every form answer has a probability of 0.7 or more, it
is sure the page signs in (0.7 or more), the element and slot views agree on every slot,
and the plan passes the same checks as a generated one (`validateGeneratedPage`). Chosen
on the 2026-11-04 runs: a confirmation at 0.3 or more, or other identifier sets at 0.5
or more, leaves the page to Claude, which answers the page kind
([ADR 0035](0035-page-kinds-per-site.md)) and alternatives
([ADR 0027](0027-per-account-login-routes.md)). A passkey button or account switch under
0.7 is left out of the plan. A plan Clef answers has the page kind `sign-in`, and
`irreversible` is `yes` at 0.7 or more, `no` at 0.3 or less, and `unclear` between.

A page the device reports signed in (`signedIn`,
[ADR 0035](0035-page-kinds-per-site.md)) goes to Claude, which weighs that hint for a
confirmation. Lists of accounts ([ADR 0028](0028-account-chooser-login-pages.md)),
sign-in entries ([ADR 0031](0031-sign-in-entry-pages.md)), passkey-only pages
([ADR 0053](0053-passkey-only-generation.md)), logout requests and the judge go to
Claude as before.

### When Clef does not answer

When Clef abstains or fails, the request goes to Claude with the owner's model choices,
as every request did before. Clef never answers after Claude. Chosen by an agent: the
request takes its attempt ([ADR 0016](0016-recipe-generation-trigger.md)) before Clef's
calls are sent, so when Claude then cannot be asked (its token exchange fails, or Clef's
spend reached a stop) the request ends unavailable with that attempt taken.

### Cost and keys

Clef's calls are charged the way Claude's are. A page's two calls get one request-log
row (provider `cloudflare`, model `clef`, with both calls' answers and usage; its
request is the generation request, from which the prompt version rebuilds Clef's
questions), and count toward the owner's daily and monthly spend stops at Workers AI's
published rate (`clefModels`), from the input tokens they report, or the worst case for
the input bound when a call reports none.

- **The service** calls Clef through its Workers AI binding, which needs no token. It
  bills the Cloudflare account the Worker runs in, not a credential of the owner's as
  Claude does ([ADR 0015](0015-per-owner-claude-credentials.md)); while the operator and
  the owner are one person this makes no difference. Chosen by an agent: it asks Clef
  only for an owner who has set up a Claude credential, so an owner without one still
  gets no model call, as before; a page Clef leaves still needs that credential's token
  exchange.
- **A device with its own key** ([ADR 0040](0040-running-without-the-service.md)) calls
  Clef with a Cloudflare API token and account ID it holds, as it holds its Anthropic
  key: on this device only, never synced or exported, and sent only to
  `https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/@cf/cloudflare/clef`.
  Its spend counts toward the device's limits, at the same rate, or Clef's whole context
  (65,536 tokens) for a call that reports no usage. Chosen by an agent: the settings
  page's AI key section takes the account ID and a token made with Workers AI's
  "Use REST API" (Workers AI Read and Edit), and a device asks Clef only while its
  Anthropic key is saved too, as the service asks only for an owner with a Claude
  credential. So far only a device without a pairing does: a paired device with its own
  key would need the service to hand it Clef's calls as it hands it Claude's, which the
  device-model protocol does not carry yet.

Chosen by an agent: the model is `clef` (27B). `clef-flash` and `clef-omni` answered
fewer pages right on the same questions.

## Measurements

Runs of 2026-11-04 on Workers AI (`clef`), at 0.7, scored with the value check. Results
are kept outside the repository with the corpus.

| Corpus | Pages | Right | Claude asked | False submits |
| --- | --- | --- | --- | --- |
| Request log, Clef can answer | 144 | 125 by Clef | 19 | 0 |
| Japanese and web pages | 159 | 146 by Clef | 13 | 0 |

Scored on the form call alone, with Claude's run of 2026-11-03 answering the pages Clef
left, 141 of the 144 request-log pages were right.
Clef alone took 0.33 s at p50 and 0.62 s at p95; a page that went on to Claude took
3.0 s and 5.9 s; all pages together 0.38 s at p50, against 2.5 s with Claude alone.
A page costs about $0.004, against $0.014 with Claude alone. The page call found every
labelled passkey button (23), and two more the labels had missed.

## Consequences

- Most sign-in pages get their recipe in well under a second, and generation costs
  about a quarter of what it did.
- A page Clef leaves takes one Clef round trip longer than before.
- The request log gets a row for Clef's answer, so a page Claude answered after Clef
  has two rows. The dashboard counts such a page once, by the row after Clef's.
- The service's Clef calls bill the operator's Cloudflare account.
