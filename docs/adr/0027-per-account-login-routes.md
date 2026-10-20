# ADR 0027: Login routes and second-factor pages chosen per account

Status: accepted by the owner on 2026-10-11 (13:47 UTC). Deliveries 1 (custom-field
names and Text shapes in generation) and 2 (handlers with the `passkey` handler) are
implemented, and so are delivery 3: part A (`password` route variants and start
detection over them) and part B (the start page's `passkey` route), and delivery 4 (the
`totp` handler) except a binding that names another field for its code, which is
deferred and ends `challenge` ([Implementation choices](#implementation-choices));
delivery 5 (the `sso` route) is not implemented. Amends
[ADR 0007](0007-existing-passkey-assertions.md) and
[ADR 0021](0021-account-choice-outside-settings.md) (which item answers a passkey
request during a login), [ADR 0010](0010-inference-field-hints.md) and
[ADR 0016](0016-recipe-generation-trigger.md) (custom-field names and Text shapes in
automatic generation), [ADR 0013](0013-service-held-recipes-and-settings.md) (bindings
per route), [ADR 0018](0018-recipe-generation-route.md) (when a page is judged and the
judge's limits) and [ADR 0026](0026-sign-in-through-identity-providers.md) (SSO as a
route). Each part lands in its own PR (see [Delivery](#delivery)); the ADR 0010 and ADR
0016 status notes land with the custom-field part. When a page after a step is judged is
amended by [ADR 0029](0029-local-sign-in-state.md), whose first part of delivery 2
(completing on confirmed evidence of a sign-in, on the `password` route) is implemented.
Amended on 2026-10-12 by the owner (13:08 UTC): a top-level `password` login that ends
`challenge` or settles as unknown is watched for 10 minutes
([Watching after a challenge](#watching-after-a-challenge)); implemented. Amended on
2026-10-12 by [ADR 0034](0034-answer-page-passkey-requests.md): a recipe without a
passkey button gets a `passkey` route that answers the start page's own conditional
request, chosen or switched to when the page asked, and that route falls back to the
recorded `password` variant when the site does not sign in (implemented). Amended on
2026-10-12 by the owner (decision card answered "fill" at 19:21 UTC): a `totp` handler
also takes a code split into one input per digit ("Split code inputs" in
[Implementation choices](#implementation-choices)); implemented. Amended on 2026-10-12
by the owner (decision card answered option A at 22:04 UTC): the judged page also
carries up to three short texts near its code field, so the judge can read where the
code comes from when the page says so outside the code form ("Text near the code field"
in [Implementation choices](#implementation-choices)); implemented. The rule that only a
code the page says comes from an authenticator app is learned was unchanged then
(changed on 2026-10-13, below). Amended on 2026-10-13 by
[ADR 0036](0036-passkey-after-the-identifier.md): an item without a password but with a
passkey takes the `password` route up to the step that fills the password, answers its
page's passkey request there, and otherwise ends `challenge`, watched (implemented).
Amended on 2026-10-13 by owner decision (03:30 UTC card, 04:01 UTC go-ahead): a code
page that says nothing about where the code comes from (the judge's `source` is
`unknown`: no authenticator app, no SMS, email, phone, call or address it was sent to,
and no other source such as a recovery code, card or hardware token) adds a `totp`
handler under the same field and button checks, so the item's TOTP is typed once; a
wrong code ends the login without a second code, and a code the page says was sent to
the person or comes from another source still adds nothing ("Learning a `totp` handler"
in [Implementation choices](#implementation-choices)); implemented. On 2026-10-13 (build
`fdf57ef`) Resend's code page was dropped with `totpDropped=source-unknown`, and on
ニコニコ's two-step page nothing near the code field says where the code comes from.
Amended on 2026-10-13 by [ADR 0021](0021-account-choice-outside-settings.md) (D): a
login that settles unknown on the sign-in form shown again, with its password input and
no other sign, stops being watched once that reading is confirmed; the tab asks for an
account at once (implemented).
Amended on 2026-10-13 by the owner (05:39 UTC) through ADR 0036 rule 6: at the stop of a
login of an item without a password but with a passkey, a "sign in with a passkey"
button beside the route's password field is pressed when the item has a passkey
(implemented). How it is done is Claude's extension, not confirmed by the owner
separately: the stop's page may be judged once with `stop: true`, the service keeps
only a `passkey` handler from it, and a `password` login never enters a `passkey`
handler on a path where its plan still has a route step to run that fills the password
or while a fill field of the route shows.
Amended on 2026-10-18 by [ADR 0048](0048-password-method-button.md) (owner, 01:38 UTC,
option B): the judge may also name a button that goes on to the password on a page that
asks how to confirm the sign-in, stored as a third handler kind, `password`, entered
only by a `password` login that has not filled its password, before other handlers
shown with it, and only when its text names a password choice (implemented).

Amended on 2026-10-18 by [ADR 0049](0049-start-at-a-later-step.md) (owner, 01:40 UTC,
implemented): a later step a login may start at releases a watched login as its first
step does, and the start page's `passkey` button is not offered to a login that starts
at a later step.

Amended on 2026-10-18 by the owner (decision card
「カスタムフィールドのスロット名を、LLM ではなくページの欄の名前から作りますか?」,
answer 「進める」, 08:58:31 UTC): a custom-field slot is named from the page's text for
its field, not by the model
([slot names from the page](#amendment-2026-10-18-slot-names-from-the-page)), which
replaces the model's names in
[Custom fields in generation](#custom-fields-in-generation), "Generic IDs" and the
alternatives' slot names under "Generation" in
[Implementation choices](#implementation-choices); implemented.

Amended on 2026-10-19 by the owner (decision card on keeping slot names when a recipe is
generated again, answer 「A 前の名前を使う」, 01:22 UTC): a custom field that the
owner's saved bindings of the recipe already name keeps that name on any generated page
([slot names from the bindings](#amendment-2026-10-19-slot-names-from-the-bindings)),
which amends [ADR 0018](0018-recipe-generation-route.md) (the service reads the
bindings while generating) and [ADR 0012](0012-inference-request-log.md) (a logged
result may hold a name the page does not show); implemented.

Amended on 2026-10-19 by the owner through [ADR 0053](0053-passkey-only-generation.md)
([passkey-only start pages and wider passkey words](#amendment-2026-10-19-passkey-only-start-pages-and-wider-passkey-words)):
a start page that shows only a passkey button is generated, as a recipe with only the
`passkey` route (recipe shape by decision card at 20:31 UTC; SSO-only start pages still
are not), and the words that name a passkey button also take device unlock words such as
Face ID, Touch ID, Windows Hello and 指紋認証 (20:29 UTC, "broad is fine"); implemented.

Amended on 2026-10-19 by the owner (22:48 UTC, "yeah sounds good. go ahead"): the slots
a saved binding does not name are filled as for an item without one, after the variants
were tried with the binding as it is, and the binding is widened by them after
`authenticated`; the same rule applies at login start, at a continuation's takeover and
at each step, and a refused takeover logs why
([saved bindings that lack a slot](#amendment-2026-10-19-saved-bindings-that-lack-a-slot)),
which amends [ADR 0013](0013-service-held-recipes-and-settings.md) (bindings are
widened) and [ADR 0018](0018-recipe-generation-route.md) (the takeover); implemented.

Date: 2026-10-11

## Context

A generated recipe is shared by every account on its origin and start path. Only the
binding (slot to vault field) is per account. Its steps are one line, and its
`completion` is learned from the first account whose post-login page is judged
([ADR 0018](0018-recipe-generation-route.md)).

On 2026-10-11 (12:49 UTC) a generated recipe for `https://www.npmjs.com/login` filled
the owner's username and password and clicked "Sign In". npm then showed its
security-key page, `/login/webauthn`. That page was judged a challenge, so no
completion was stored, the account choice was not saved, and the owner clicked "Use
security key" by hand. Every later login would judge the same page again. The owner
decided at 12:52 UTC that this click must be automated too.

One linear step appended to the recipe (approved at 13:06 UTC as "option B") fails
once accounts differ, as the owner pointed out at 13:21 to 13:23 UTC. For npm accounts
A (security key), B (no second factor) and C (authenticator app):

- If B logs in first, A's step is never added.
- If C logs in first, C's page uses up the revision's only judgement, and B never
  teaches the completion.

Accounts on one site also differ from the first page on: one has a passkey and signs in
with "Sign in with a passkey", another types a password, another signs in through
Google ([ADR 0026](0026-sign-in-through-identity-providers.md)). Some forms identify the
account in different ways: SMBC asks for either a branch number (3 digits) and an
account number (up to 7 digits), or a contract number (10 and 5 digits), plus the login
password. A recipe must therefore branch, and the branch must be chosen from the
selected vault item.

## Decision

### Branches of fixed kinds

Recipes carry branches of a fixed set of kinds, each with a fixed requirement, so the
service can check every branch. Free-form conditions are rejected: a model cannot learn
them from one page and nothing could check them.

- **Routes** are the ways a start page offers to sign in. One is chosen from the item's
  facts when the login starts:
  - `password`: today's fill-and-submit steps.
  - `passkey`: click the start page's passkey sign-in button. It requires a discoverable
    passkey for the site; a key registered only as a second factor does not count.
  - `sso`: click one IdP's entry, as decided in ADR 0026.
- **Variants** of a `password` route, one per identifier set the page offers (SMBC's
  branch and account numbers, or its contract number). Each variant names its slots.
  The executor uses the variant whose slots the item's binding can fill.
- **Handlers** are branches on the page that appears after any effect step, chosen by
  what the page shows and run only when the item has the needed fact:
  - `passkey`: click "Use security key" or the like. It requires any usable passkey
    for the site.
  - `totp`: fill the TOTP code into the code field and click its submit button. It
    requires a TOTP secret.

A page that asks for a passkey by itself (`navigator.credentials.get` without
`mediation`, or with `optional` or, since an amendment of ADR 0007 on 2026-10-12,
`required`) needs no branch: the bridge already answers it.

### The item's facts

The facts are read locally once, when the login starts, and recorded in the attempt, so
a service worker restart or a vault sync cannot change the route during a login. They
are never sent to the service or a model.

| Fact | How it is known |
| --- | --- |
| `password` | a new value-free catalog flag: the item's password is non-empty and not excluded ([ADR 0023](0023-synced-vault-policy.md)) |
| `totp` | a new catalog flag: the item has a TOTP secret and the field is not excluded |
| `passkey`, `discoverable passkey` | one `findVaultPasskeys` search per RP ID the origin may use; an incomplete search counts as not known |
| `sso` | the item's `SSO` field under ADR 0026's rules; an excluded field means no SSO, a duplicate or unreadable one stops the login |

Today the catalog lists `login.password` and `login.totp-code` for every login item,
whether or not they hold a value; the two flags fix that (owner, 13:42 UTC).

### Executor

1. **One route is chosen at start**, in this order (owner, 13:40 UTC: passkey before
   SSO), and recorded:
   1. `passkey`, if the recipe has that route and the item has a discoverable passkey;
   2. `sso`, if the item has it. An SSO item never uses `password` (ADR 0026);
   3. `password`, if the item has a password and its binding fills one variant.

   If none fits, the login stops with `no-route`. A login on the `passkey` route that
   reaches no signed-in page ends `challenge`; it never falls back to typing the
   password. The `passkey` route that answers the page's own request on a recipe without
   a passkey button is the exception
   ([ADR 0034](0034-answer-page-passkey-requests.md)).
2. **The start is detected** by watching the first element of every route, without
   reading the vault, as today for one first step.
3. **After each effect step** the executor checks, in order: the completion, the
   rejection, the route's next step, then a handler whose path matches and whose first
   element is present.
   - Each handler runs at most once per login, so a wrong TOTP code is never retried
     into a lockout. A click on the code's button that failed without changing the page
     is not retried either, since a late click could submit an expired code: the login
     ends `retry-limit` (2026-10-12). The same holds for a route step's click after it
     fills only the `totp` slot.
   - If the item lacks the handler's fact, the login ends `challenge`.
   - After a click (a handler's or the `passkey` route's), the page is not judged while
     the clicked button is still there. This waits out a slow WebAuthn exchange or a
     chooser the person is answering.
4. **Passkeys during a login.** For a passkey request from the tab and origin of a login
   that has not ended, the bridge uses that login's own vault item instead of the site
   default or the ADR 0021 chooser. That includes pages that ask by themselves, such as
   a passkey prompt after the username. Frames on another origin and ended records do
   not count. A request this item cannot answer is passed to the browser or Bitwarden
   as today, so Pateat never signs in as another account.
5. **Bindings** cover the recorded route's slots, not every recipe slot.
   `resolveBindingFields`, `resolveLoginPlan` and `allowed()` change from "exactly
   `recipe.slots`" to that, so the `passkey` and `sso` routes need no password field.
   The `totp` handler reads the item's built-in TOTP field unless the binding names
   another field.

### Custom fields in generation

To produce variants, generation needs the names the owner gave the vault fields, as
ADR 0013 and ADR 0010 already decided. The owner chose at 13:48 UTC to implement this
now rather than later.

- Before each generation request, the extension offers one slot per custom field that
  a matching item allows for automatic fill (not excluded, not waiting for review, a
  Text, Hidden or Linked field), with its `fieldName` and position for duplicate names.
- A Text field, or a Linked field that reads the username or a Text field, also carries
  its `valueShape`. As approved for the username, the shape is sent only when every
  matching item with that field name gives the same shape; several items send the
  union of their field names.
- The model names each slot it uses with a generic ID such as `branch-number` and maps
  it to a field name. The recipe stores the generic IDs only; the mapping becomes the
  binding ([ADR 0013](0013-service-held-recipes-and-settings.md)), so the shared recipe
  never carries the owner's field names.
- `totp` is offered for the start page only when the page shows a code-like field
  (`autocomplete="one-time-code"` or a short numeric input), so the slots never tell
  the model whether an account has TOTP (owner, 13:42 UTC). `password` is offered only
  when a matching item has a non-empty password.
- The model may also name the start page's passkey sign-in button and SSO entries.

### Learning

These rules work from any account, in any order.

- **When a page is judged:** after an effect step, if none of the checks in executor
  step 3 matched. That includes a recipe that already has a completion, and an
  `advance` whose next step never appeared.
- **Checked on the service:** the request names the login's route, and the service
  checks that the stored recipe has it. It then checks the judged page against the
  stored recipe, not against the request: the page shows none of that route's fill
  fields and not the completion marker. The path is not excluded, so a code form that
  stays on `/login` can still get a handler.
- **Verdicts:**
  - `signed-in` stores the completion, if there is none.
  - `challenge` naming a security-key or passkey sign-in button adds a `passkey`
    handler. A button that registers or adds a passkey ("Add a passkey", "Set up") is
    refused, and so is a page that shows the completion marker. On a page that asks only
    to verify with a security key, passkey or FIDO authenticator, even with a link to
    other methods, the button that starts that check counts whatever its label says,
    unless it registers one. Oracle Cloud's
    "FIDO Authenticator Verification" page starts its WebAuthn call only from a button
    labelled "Verify". On 2026-10-13 at 02:57 UTC (build `fdf57ef`), the judge answered
    a plain `challenge` for it, and the login was left watching. After the owner pressed
    "Verify", Pateat answered with the item's passkey. The judge's instructions now say
    so, and the prompt version changed with them. A recheck at 03:56 UTC still got a
    plain `challenge`: the page's description named only the title "Cloud Sign In", two
    redacted headings and the "Verify" button, since its "FIDO Authenticator
    Verification" heading is an `h4` and its sentence a `span`. The page now carries the
    text near its buttons (below).
  - `challenge` naming a code field and its submit button adds a `totp` handler. The
    field must pass the TOTP fill rule of ADR 0013, and the judge must not say the code
    was sent to the person (SMS, email, a call) or comes from another source such as a
    recovery code: a page that names an authenticator app counts, and so, since
    2026-10-13 (owner decision), does one that says nothing about where it comes from.
  - Anything else stores nothing.
- **Limits:** each recipe revision and page path is judged at most once per judge
  prompt version (its instructions and output schema, not the local checks that keep a
  handler); at most 20 judgements per recipe per day (UTC), whatever the path
  (owner, 13:45 UTC); and the existing $5 a day and $100 a month. Judging again after
  the judge changes was added on 2026-10-12, after Resend's code page, judged
  `challenge`, kept answering `judged-challenge` on the same revision and never got its
  `totp` handler. (That note first said Resend splits its code into one-digit inputs;
  a real-Chrome check the same day showed one input, `autocomplete="one-time-code"`,
  numeric, six characters.)
- **First login:** when a judgement adds a handler, the running login takes the new
  revision and runs the handler on the page it is on, if the item has the fact. Its step
  and submission budget grows by the handler's steps. A login accepts a newer revision
  only when its routes and route steps are unchanged and it only adds handlers or a
  completion; any other revision still makes a resumed login answer
  `recipe-not-found`.
- **First login after an advance** (owner, 04:11 UTC 2026-10-12): a running login also
  takes over a revision that appends route steps continuing its final `advance` step,
  the continuation of
  [ADR 0018](0018-recipe-generation-route.md#continuing-after-an-advance), which is used
  immediately; only for that case.

### What the model receives

- The page: structure and redacted labels, never values (`LoginObservation`). The
  judge's page also carries the texts near its code field (`nearCode`, below).
- Slot meanings for the built-in fields.
- Custom-field names allowed for automatic fill, with positions, and the shapes above.
- Never: values, item names, item or account IDs, and the facts (password, TOTP,
  passkey or SSO present).

### Implementation choices

Implementation choices that follow from these decisions, made on 2026-10-11 without a
new owner decision:

- **Which page is judged.** After an effect step, the pages judged are the first ones
  that reach the settle point without the route's fill fields on a route path and
  without the completion marker, at most 2 counted pages per effect step. A page counts
  once the extension holds its complete description, before the request, and stays
  counted whatever the answer, except after a temporary refusal before any model call: a
  busy service, the service's own request limit (its 429), an unreachable service, no
  paired service, a rejected device, or a request that failed before the model
  (`incomplete-observation`, `invalid-request`, `input-too-large`). Those give the page
  back. Permanent refusals (`already-judged`, `not-judgeable`, `recipe-conflict`,
  `recipe-revoked`, `judgement-limit`, the spend limits, credential and token errors,
  and any other `unavailable` reason) count, and so do the provider's rate limit, a
  timeout and an unexpected answer, since they may follow a model call. A login whose
  result settled as unknown therefore makes at most 2 counted requests per effect step,
  plus retries after temporary refusals, each of which needs the tab to reach a new page
  that settles. A page that is not sent, because its description is incomplete, failed
  or belongs to another path, does not count. The count is stored in the attempt before
  the request, so a worker restart during a request cannot send that step's pages
  without bound. A handler's click is a new effect step.
- **Settled logins and the bridge.** A login whose result settled as unknown no longer
  counts as running for the passkey bridge (executor step 4) until it moves on. A
  stored record that has neither ended nor settled keeps scoping its tab and origin to
  the same item, also after a worker restart, until it ends, settles or its tab closes,
  even if no document of the tab resumes it.
- **Settled logins and policy writes.** A similar rule decides which logins keep off the
  writes that would stop them: the settings sync's local write, the vault replacement
  (ADR 0025), and saving another tab's account choice or a passkey site default.
  Unlike the bridge, a login whose result settled as unknown counts again while the
  extension checks or judges one of its pages, so a judgement that adds a handler is not
  cut off. Its record can stay until the tab closes (a top-level `password` login's
  until its watch ends, below); if it counted, the settings sync's
  two-minute wait would run out once and never restart, so every later login would be
  stopped by the next settings write, and the vault's two-minute deferral would likewise
  force its replacement into later logins. A policy write while a login is settled stops
  it as `POLICY_CHANGED`, and its later pages are no longer judged.
- **Recipe refresh after a judgement.** A judgement that changes the recipe pulls
  recipes only. A full sync could apply a settings change from the service, which stops
  every running login as a policy change, including the one the judged page belongs to.
  Settings follow at the next full sync.
- **Custom-field offers.** A custom field is offered when its item allows it (not
  excluded, not waiting for review), it is a Text, Hidden or Linked field with a
  non-blank name of at most 120 characters without control characters, and, for a
  Linked field, the field it reads is allowed too; a Linked field that reads the
  password is offered only when the password holds a value. Offers are united over the
  matching items by reference (name, plus position and count among the item's custom
  fields of that name), each under an opaque request ID (`custom-1`, …). Text fields and
  Linked fields that read the username are `identifier` slots, Hidden fields a new
  `hidden` kind that plan validation accepts only where ADR 0013's Hidden rule fills (a
  password input, or a `tel` or `inputmode=numeric` text input whose `maxlength` is 1
  to 10; a number input is refused because observations omit its lengths), and Linked
  fields that read the password `secret` slots. A reference whose fields differ in kind
  across items takes the strictest kind (`secret`, then `hidden`) and gets no shape.
- **Bounds.** At most 16 custom-field offers per request, Text fields first, then Linked
  fields that read the username, Hidden fields and Linked fields that read the password,
  each in scope and field order, so a request stays within 20 slots; a reference whose
  fields differ in kind is ranked by the kind it is sent as. At most 32
  custom-field values are read for shapes per request, and an offer past that bound is
  sent without one. When an enabled connection could not answer or an item's URI rules
  could not be evaluated, the names that are known are still offered, but no shape is
  sent, as for the username.
- **Generic IDs.** A generic ID is one to four lowercase ASCII words of at least two
  letters joined by hyphens, at most 40 characters, not `username`, `password` or
  `totp`, and equal to no requested slot ID or other name in the plan. Digits and other
  scripts never fit, so an account number or a Japanese field name cannot become one. An
  ID that equals an English field name in slug form (`Branch number`, `branch-number`)
  is accepted. The decision role and the benchmark heuristic name no custom slot, so
  they abstain or fail on pages that need one.
- **Mapping before the first authenticated login.** The service answers the call that
  wrote the recipe with `customSlots` (generic ID and offered request ID). The extension
  turns it into field references from the slots it sent and keeps them in
  `chrome.storage.local` per service origin, device ID and recipe ID (at most 200
  recipes, the oldest dropped), written before the page is told to start the recipe. A
  continuation's answer names only its own page's slots, so its mapping is added to the
  map this device holds for the recipe it continues, keeping the slots that recipe still
  has; an answer that starts a recipe replaces the map. When the stored maps cannot be
  read, nothing is written, so no other recipe's map is dropped, and the next use reads
  them again; stored maps that do not parse count as none. A
  login with no saved binding for its item builds one from another item's saved binding
  of the same recipe and origin, then from that map: built-in slots read the item's
  built-in fields, other slots take the template's reference, and the first template
  whose references all resolve on the item wins. It is saved after `authenticated` like
  an automatic choice. Until one login authenticates somewhere, other devices cannot
  fill the custom slots. (Since 2026-10-19 the slots a saved binding lacks are filled
  the same way, and the binding is widened after `authenticated`:
  [saved bindings that lack a slot](#amendment-2026-10-19-saved-bindings-that-lack-a-slot).)
- **Lost response.** A device that never receives the answer (a worker restart during
  the request) or that gets a recipe another request stored has no map; the recipe
  cannot fill its custom slots on that device until a binding is saved by a login on
  another device or written by the owner.
- **Item lacking the field.** An item with neither template resolving stops before any
  fill with `field-missing`, `field-count-changed`, `field-ambiguous` or, when no
  template covers every slot, `binding-not-found`; a field excluded later stops with
  `binding-field-excluded`. The binding review of
  [ADR 0023](0023-synced-vault-policy.md#binding-review) is later work.
- **Variant shape.** A recipe's top-level `slots` and `steps` are its first `password`
  variant; an optional `alternatives` list adds one to three more, each with its own
  `slots` and `steps`. The shape is additive, so recipes with one variant, the D1 table
  and the recipe cache keep their form. `recipeSlots` is the union of every variant's
  slots (the service's slot checks and the generation answer's `customSlots` use it);
  `routeSlots` names the slots of the chosen variant only. A newer revision keeps a
  login only when its alternatives are unchanged, like its other route steps.
- **Variant validity.** Each variant is checked as a recipe is: known slots, the effect
  budget and the fallback-click rule. A recipe with alternatives also needs every
  variant to fill exactly its own slots, to start on the first variant's start path and
  to end in a `submit` step; no variant's slot set may equal or contain another's; a
  fill target (by path and locator) is filled as one slot in every variant, and no two
  variants fill the same targets; the union stays within 20 slots; the completion target
  on its path and the rejection may not be any variant's step target, nor the account
  switch any variant's click target; and the observation bound counts every variant's
  targets.
- **Choosing a variant.** A new login reads the item's facts once and takes the first
  variant, in recipe order, whose binding resolves, whose fields are all allowed and
  whose bound password or TOTP fields hold values; the `password` route also needs the
  item's `password` fact. The binding source is decided as for one variant: a saved
  binding for the item is the only source, so a saved binding that does not hold a
  variant's slots skips that variant and is never bypassed by a template; otherwise the
  automatic binding for built-in slots, then the templates, with the generated slot map
  read at most once per plan resolution (each later step's authorization resolves its
  plan again). (Amended 2026-10-19: the saved binding's entries are still used as they
  are and every variant is tried with it as it is first, but when none fits, the slots
  it lacks are filled as for an item without one and the variants are tried again:
  [saved bindings that lack a slot](#amendment-2026-10-19-saved-bindings-that-lack-a-slot).)
  The attempt records the variant (attempt store `pateat.login-attempts.v3` then,
  `pateat.login-attempts.v4` since the watch below; a previous store is left unread),
  and a running or resumed login checks only that variant's binding: the binding check
  ignores the fields of other variants.
- **Bindings with other slots.** A binding resolves for a set of slots when it holds an
  entry for each of them; entries for other slots are ignored. This also applies to a
  recipe with one variant, so a saved binding that still names a slot the recipe no
  longer has (`username`, `password` and a stale slot) resolves for that recipe.
- **Refusals.** A recipe with one variant refuses with that variant's own reason
  (`binding-not-found`, `field-missing`, `no-route` and the like), as before. A recipe
  with several refuses `no-route` when none fits, and the diagnostics log records the
  first variant's reason as the refusal's `detail`. `login.attempt` records the route
  and variant. The facts are never logged.
- **Judging.** The judge request does not name the variant. The extension does not send
  a page that shows a fill field of any variant on a path of the route, and the service
  answers `not-judgeable` for a page that shows one on any path. The login paths the
  judge receives are every variant's step paths and the handlers' paths.
- **Start detection.** A document watches the first step of every variant of each
  recipe for its origin. A start path is left out only when several recipes start
  there; several variants of one recipe on it are watched together, and any of them
  being ready starts the login.
- **Generation.** The model may name up to 3 `alternatives` for a start page, each a set
  of fields and the action that submits it. They must use the same slot names as the
  main plan for the same slot meaning, fill each element under one slot name only,
  differ from it and from each other in both slots and elements, and submit; an
  alternative that only advances is refused, so a variant is always one page. An answer
  that fills one element as different slots in different sets fails as invalid output
  (`inconsistent-candidate`) rather than being stored as two variants, so an ambiguous
  mapping is never hedged. More than 3 alternatives fail the response format, and plan
  validation also refuses them (`too-many-variants`). On a continuation (a request with
  `base`) or a chooser branch's page, plan validation drops the answer's valid
  alternatives (`startPage` false), so they name no slot; an answer whose alternatives
  fail validation still fails the call. The prompt does not mention
  continuations. A recipe with alternatives is
  never continued. A generation answer maps the custom slots of every variant, up to 16.
- **Passkey route shape.** A recipe's `passkey` route is an optional
  `passkey: { path, target }`, additive like `alternatives`: one `submit` click on the
  start page's passkey sign-in button, with no slots. Its path must be the start path,
  and its target may not be a step target of any `password` variant on that path, a
  handler target on that path, the completion target on its path, the rejection or the
  account switch; the observation bound counts it, and a newer revision keeps a login
  only when the route is unchanged. Start detection watches the button first, then the
  first step of every variant; the button alone being ready starts the login, and a
  login that chose the route but whose button never shows ends `structural-mismatch`
  after the usual step wait.
- **Choosing the passkey route.** The route is chosen only when the recipe has it and
  the item's facts include a discoverable passkey; a passkey registered only as a second
  factor leaves the `password` variants to decide as before. The route fills nothing,
  so it needs no binding, its password variants' bindings are not resolved for it, and
  a variant that does not fit the item never refuses such a login; the refusal reasons
  when the route is not chosen are unchanged. The attempt records `passkey` and no
  variant, a running or resumed login checks only the item and the account scope, and
  after `authenticated` only the site default (for an automatic choice) is saved: no
  binding is stored or synced for the route.
- **Held click.** The hold for a handler's click also covers the `passkey` route's
  click: while the button still shows in the document that clicked it, whatever path a
  same-document URL change (`pushState`) has moved that document to, the page is
  neither judged nor settled for up to two minutes, then the login ends `challenge`.
  This applies to a handler's click too. A new document of the tab that shows the
  button again on its path, as after a reload back to the start page, ends `challenge`
  at once; the button is never clicked again or judged. A click left to the person
  because a CAPTCHA shows is held the same way while its button shows in that document
  ([ADR 0029](0029-local-sign-in-state.md), S4); a new document, or the same one after a
  worker restart, is read as after Pateat's own click.
  The hold lives in the service worker's memory, so a worker restart during the hold
  treats the same document as a new one and ends `challenge`; a click whose delivery
  failed while the button still shows also ends `challenge`. Both fail closed.
- **Settlement on the passkey route.** Every result on the route other than
  `authenticated` ends `challenge`: the rejection marker, a final `unknown`, a
  judgement of `rejected`, `unclear` or `challenge` without a handler, and a page that
  could not be judged. A page after the click is still checked for handlers, so a
  handler the recipe has (or the judge adds) runs as on the `password` route, and the
  route never changes during the login.
- **Judging the passkey route.** The judge request names the `passkey` route. The
  route starts beside the password form, so a page that still shows that form is the
  sign-in page on this route too: the service answers `not-judgeable` for a page that
  shows a fill field of any `password` variant, on any path, as on the `password` route,
  and for a page on the route's path or any `password` route path that still shows the
  passkey button. The login paths it receives are the route's path and every
  `password` route path. The extension likewise sends no page that shows the button or
  a fill field of any variant on those paths. A start page that renders its password
  form again after the click is therefore never judged, so it cannot spend the start
  path's one judgement for the revision or add a handler there. The service answers
  `recipe-conflict` for a recipe without the route, and a judged `completion` or handler
  may not reuse the route's button.
- **What the route name tells.** Since only an item with a discoverable passkey takes
  the `passkey` route, the route name in the judge request, the `login.attempt` report
  and the attempt record implies that the login's item holds a discoverable passkey for
  the site. This follows from the accepted rule that the judge request names the
  login's route; the item's facts themselves are still never sent or logged.
- **Generating the passkey route.** On a start page, the generation role may name a
  `passkeyButton` beside its plan. It is kept only when it is a candidate with the
  button role (not a link or another role) whose label or `id`, `name`, test ID or text
  locator names a passkey or security key, case-insensitively (passkey, pass key,
  security key, each also plural, WebAuthn, FIDO, or パスキー, セキュリティキー,
  セキュリティーキー, 生体認証;
  [widened 2026-10-19](#amendment-2026-10-19-passkey-only-start-pages-and-wider-passkey-words)),
  that is not named like a registration or a setting
  (add, register, create, set up, new, enrol, manage, enable, turn on, or 登録, 追加,
  作成, 設定, 有効, 管理, the words the `passkey` handler check refuses too), and not
  any set's field or action or the account switch, by candidate or by locator. Latin
  words match whole words: of a label or text locator as written, and of an `id`, `name`
  or test ID locator split at camelCase, hyphens and underscores, so
  `passkeyLoginButtonAD` names a passkey but a label "MyFido" or "Fidor" does not;
  Japanese words match anywhere, except that セキュリティキー followed by more katakana
  is another word, so セキュリティキーボード ("security keyboard") names no security
  key, and that 設定済み ("already set up") and 有効な ("valid") describe the passkey of
  a sign-in button, as in "設定済みのパスキーでログイン", and are not registration
  words. A label that turns on or manages a passkey, such as "パスキーを設定" or "Manage
  passkeys", is therefore never a sign-in button or a `passkey` handler. The wording
  check keeps a mislabelled "Sign in with Google" or SSO button from becoming a passkey
  click outside ADR 0026; it is a shared helper the judge's `passkey` handler check does
  not use yet. A button that fails these checks is dropped silently and does not fail
  the answer. On a continuation plan validation drops it. The service stores it as the
  recipe's `passkey` route on the first page, and the request log records the kept
  button. The corpus case `ja-myjcb` expects its passkey sign-in button, and the
  evaluation reports passkey buttons as a separate count (expected, correct, missed,
  wrong) that does not change a case's result.
- **Synthetic passkey fact.** The probe build's configure message takes an optional
  `passkey` (`discoverable` or `second-factor`) that stands in for the vault search for
  the synthetic item, since the probe vault holds no passkey; no key is created or
  used.
- **`totp` handler shape.** A `totp` handler is `{ kind: "totp", path, field, target }`:
  the code input (an attribute locator, never a text one; since 2026-10-13 also its
  visible name, [ADR 0037](0037-fields-by-visible-name.md)) and the button that submits
  it, which may not be the same element. Its steps are one `prepare` fill of the
  `totp` slot into the field, then one `submit` click on the button. A recipe keeps one
  handler per kind and path, and both elements count wherever a handler target counts:
  the account switch, the completion and the `passkey` route may not reuse either. Its
  field is never an element a route step uses on its path.
- **Learning a `totp` handler.** The judge answers a code page with an optional `code`
  (`field`, `submit`, `source`: `authenticator-app`, `sms`, `email`, `other` or
  `unknown`); it says `sms` or `email` when the page says the code was sent to the
  person or names where it went (a phone, call, message or address), `authenticator-app`
  when the page names an authenticator app, `other` when it names another source such as
  a recovery code, card or hardware token, and `unknown` only when it says nothing about
  where the code comes from. The judge keeps the answer only when the source is
  `authenticator-app` or, since 2026-10-13 (owner decision, above), `unknown`, the field
  is a fill-role candidate with an attribute locator (or a visible name, ADR 0037) that
  the TOTP fill rule of ADR 0013
  accepts and whose `maxlength`, when set, is at least 6, no other such input is in its
  form, or the field is the first input of a split code (below), and the button is a
  button of the same form; any other code answer is dropped silently, so the page ends
  `challenge` and stores nothing. The service checks the field and button again with the
  same rule (`not-code-field`), then against the stored recipe: the field may be no
  field a route fills, no route step target on the path and no other handler's element
  there, and the button no route fill field, the `passkey` route's button, the switch,
  rejection, completion or another handler's element. The button may be the `password`
  route's submit button on that path, as on a page that asks for the code in the sign-in
  form after the password. A page that offers both a security key and an authenticator
  code gets both handlers in the same next revision. The service logs which handler
  kinds it kept or dropped and why, without elements or values. A judged completion is
  refused on a page of a `totp` handler's path that shows its code field, as on the
  sign-in page, and generation maps a one-time-code slot only to an input the TOTP fill
  rule accepts.
- **Text near the code field** (owner decision, 2026-10-12 22:04 UTC). On Resend's code
  page the sentence that asks for the authenticator app's code is a plain `span` outside
  the form, tied to no input, so the judge saw no source and answered `unknown`. The
  page shown after an effect step therefore carries `nearCode`: up to three texts near
  its first input that the TOTP fill rule of ADR 0013 accepts by itself
  (`autocomplete="one-time-code"`, or a numeric or `tel` input with `maxlength` 1 to 10,
  as `isCodeField` reads an observed field; a split code's first input). They come from
  the field's first six parents, never the body or above, and stop below the first
  parent that holds another shown field to type in (an enabled, writable text input,
  text area or editable text; not a checkbox, radio, button, select or hidden input,
  another one-character input of a split code, or one hidden from assistive technology
  or out of the tab order, as a form's trap for bots is), so they stay with the code's
  own part of the page. Each is the rendered text of one shown element without child
  elements, nearest parent first and then in page order, sent in page order. Live
  regions (`role="alert"`, `aria-live` and the like), the element the field's
  `aria-errormessage` names, editable text (`contenteditable`, the `textbox`,
  `searchbox`, `combobox` and `spinbutton` roles), `output` boxes, controls, labels,
  links, buttons, `h1` to `h3` headings, and `code`, `pre`, `kbd` and `samp`, and
  everything inside them, are left out, since error text and such boxes can echo a typed
  value (ADR 0010), code-like text may show a setup key or recovery code, and the rest
  is already described; such an element anywhere above the field, as a page wrapped in a
  live region, leaves out every text, and a field marked `aria-invalid="true"` gets
  none. Each text is redacted as the rest of that page (email addresses, masked runs and
  every number hidden, the account's own usernames as `[account]`) and then cut at 120
  characters. A text that repeats another, the title, a heading or the field's label,
  placeholder or description, or that has fewer than two letters beside its
  placeholders, such as a timer or one typed character in a box of its own, is dropped
  and does not count toward the three, and so is one that looks like a key or recovery
  code, or whose parent, up to the parent being read, shows one, as a key printed one
  group per element does. A text looks like one when, read before redaction, without
  invisible format characters and without email addresses, it has a word of ten or more
  letters and digits holding both; two or more groups of four or five letters and digits
  joined by hyphens, holding a letter and a digit, or three or more holding a letter;
  two words side by side of four to eight letters and digits that each mix both; four
  or more words in a row of four letters and digits of which two or more mix both; or
  three or more words in a row of four or five capitals and digits of which two or more
  hold a letter. An element with child elements gives no
  text of its own, so a sentence with an inline element inside, such as `<strong>`,
  `<br>` or an icon, gives only that element's words or nothing. The judge's
  instructions name `nearCode` as untrusted page text. Login pages, lists of accounts
  and sign-in entry pages never carry it, so recipe generation never sees it. A misread
  or deceptive text can at worst store a `totp` handler that fills the current TOTP code
  into that site's checked field on every login until the recipe is revoked; the code
  never leaves the site and the field checks still apply. The added text (at most 360
  characters) is in the request log for a year (ADR 0012); as with the header text of
  ADR 0029, it is allowed while Pateat is for the owner's own use and decided again
  before the public release (phase 3). The judge's prompt version changed with it, so
  judged pages are judged again once.
- **Text near the buttons** (owner decision, 2026-10-13 04:22 UTC). On Oracle Cloud's
  FIDO page, the judge's description named no sign of a security key (above), so the
  page shown after an effect step that has no code field carries `nearButtons` instead
  of `nearCode`. These are up to three texts near its button candidates, read and
  redacted as the texts near a code field are. They are read around every button at
  once, one parent further out at a time, nearest first. An open modal dialog that
  holds one of the buttons, or else the page's first shown main landmark (`main` or
  `role="main"`), bounds them: only the buttons inside it count and no text outside it
  is read, so a help or account widget beside it does not take the three texts.
  Buttons and texts in the header and navigation, which the header text already
  carries, never count, and a text that repeats a button's label is dropped. A live
  region still leaves out its text, as it does near a code field, with one exception:
  on the 05:41 UTC recheck no text was sent, because Oracle Cloud wraps each sign-in
  step, with its text and its Verify button, in an `aria-live="polite"` region. A
  polite live region with no role of its own that holds one of those buttons, either
  the bounding modal or main itself or a region inside it, is read, since it holds the
  step's own text. It is read whatever it announces, so a polite error or message list
  that holds a button inside the main is read too. Every other live region is still
  left out: one that holds none of the buttons, an alert, status, log, marquee or timer
  even when it holds a button such as a dismiss button, an assertive one, and one
  around the modal or main, such as a page wrapped whole. On `8b60ff2` (06:48 UTC),
  with the recipe revoked so the page was judged again, the judge named Verify and
  Pateat pressed it and answered with the passkey. When every button is left out
  because its locator shows a username, the texts go with it. The
  judge's instructions name `nearButtons` as untrusted page text. Unlike `nearCode`,
  this text comes from most judged signed-in pages, such as a dashboard: numbers, email
  addresses and the account's usernames are hidden and key-like text is left out, but
  other text near a button, such as a real name or a password without digits shown on
  the page, can be sent. As with `nearCode`, a misread or deceptive text can at worst
  store a `passkey` handler that clicks a button of that path once per login, only for
  an item that holds a passkey, until the recipe is revoked; the handler checks of
  `addHandler` still apply. The added text, at most 360 characters, stays in the
  request log for a year under the same terms as `nearCode`. The judge's prompt version
  changed with it.
- **Entering handlers.** A handler that has not run is entered when all its elements
  are unique and usable on its path: a `totp` handler's field a shown writable input,
  and its button, like a `passkey` handler's, a shown one, enabled or not, since many
  code pages keep Verify disabled until the code is typed; the click step still waits
  for the button to be enabled. A code input rendered hidden with the sign-in form
  therefore never stands for a code page. A `totp` handler whose button is also a route
  step's click target on that path is entered only while none of the route's fill
  fields there shows, since the page is still the sign-in page while one does. A
  handler that already ran counts as shown again when its elements are merely present,
  hidden or disabled, so its page never goes to the judge instead. When several shown
  handlers qualify, a `passkey` handler goes first, as the routes put the passkey first
  and it types nothing. A handler is passed over when it already ran (`shown-again`),
  the item lacks its fact (`missing-fact`), or, for a `totp` handler, the login already
  types a TOTP code (`code-used`); when every shown handler is passed over, the login
  ends `challenge` and the first one's reason is logged. A new document that shows a
  `passkey` handler that already ran beside a `totp` handler the item can use therefore
  enters the `totp` handler.
- **One code per login.** A login types at most one TOTP code: a `totp` handler is never
  entered by a login whose route fills a `totp` slot or that entered a `totp` handler,
  so a wrong code is never followed by another, which ADR 0013 and the lockout rule
  above ask for.
- **Which TOTP field.** A `totp` handler reads the item's built-in TOTP field, which the
  account must allow, and the `totp` fact must be set. A saved binding that names
  another field for `totp` ends the login `challenge` (`missing-fact`) instead of
  reading that field: Pateat cannot make a code from a custom field yet, and typing its
  raw value could put a TOTP seed into the page. Reading a custom field the binding
  names is deferred until it can. The field is added to the plan for that login only;
  the binding saved after `authenticated` still covers the route's slots. A field
  excluded or removed after the handler was entered stops the login as a policy change.
- **Code fill rule.** A `totp` handler's fill always uses the TOTP fill rule
  (`autocomplete=one-time-code` or a short numeric input), whatever field it reads. A
  new status message in the code's form during the fill, such as a digit counter, "Looks
  good" or "Verifying…", never refuses the code; a new alert or an invalid mark on the
  field still does (`fill-rejected`).
- **A page that submits the code itself.** Some code inputs submit once the last digit
  is in. The handler's click then counts as done (`AUTO_SUBMITTED`, one submission) and
  the page is held and settled as after a click: while the button still shows in that
  document, as on a form rendered again as "Verifying", it is neither judged nor settled
  for up to two minutes. The code is never filled again or followed by a click. The code
  fill watches the page for 2 seconds once the code is in, with listeners installed
  before it is typed, and the login treats the code as submitted on any of: a `submit`
  event of the field's form; `beforeunload`, `pagehide` or a Navigation API `navigate`
  event; a change of path; the field or its form disabled, read-only, inert, busy,
  removed or replaced; the field cleared; the button gone, hidden, busy, disabled after
  it was enabled, or still disabled half a second after the code went in, since a page
  that keeps Verify disabled with the code typed is checking it itself and may enable
  Verify again only for another code (the button's states are taken from the page's DOM
  changes, with the state before each change, not from polling, so a background tab
  whose timers Chrome throttles reads the same, and a disable that follows an enable
  lasting only a few milliseconds, as on a page that disables Verify while it checks the
  code, is caught too; a button outside the form is watched too); or a new visible busy
  indicator (`aria-busy`, `progressbar`, `progress`) in the form. A button the page
  renders again at the same locator, still shown, enabled and not busy, is not a sign,
  nor is a status message on its own, since ordinary pages count digits or confirm the
  format in live regions. It also does so when, before the click, the page has left the
  path or shows the completion or the rejection without the button, and when a new
  document of the tab resumes a login whose code fill went in, or may have, and whose
  click has not run. The button is clicked, once, only when it was enabled within half a
  second of the code going in, stayed enabled and idle since, and nothing else showed a
  submission. A route step that fills only the `totp` slot and is followed by a click on
  the same path is handled the same way, with its click taking the handler click's
  place; this was added on 2026-10-12, after Resend's code page, opened on its own as a
  pending sign-in's second factor, signed in on the last digit while the login retried
  the gone button until `retry-limit`.
- **Synthetic TOTP fact.** The probe build's configure message takes an optional
  `totp: true`, which gives the synthetic dummy item a `totp` field with the fixed code
  `012345` and sets its `totp` fact; no TOTP secret or real code is used.
- **Split code inputs.** A code page with one input per digit gets a `totp` handler too
  (owner decision, 2026-10-12 19:21 UTC). A split code is 6 to 8 inputs of one form (or
  of no form) that the TOTP fill rule accepts, each with `maxlength` 1 and an attribute
  locator, with no other code input in that form. The handler's field is the first of
  them in page order, whichever one the judge names; the prompt asks for the first. The
  service checks the same rule, and refuses the handler when any of the inputs is an
  element a route step uses on its path (`step-target`). When the code's length equals
  the number of the form's shown, writable inputs with `maxlength` 1 that the TOTP fill
  rule accepts, that field first, the code goes in one digit per input, in order, each
  with its own `input` and `change` event, and the code counts as typed with its last
  digit. Each input is checked again just before its digit, since the page may change it
  after an earlier one; an input that no longer takes a digit under the fill rule stops
  the fill without a click (`field-changed`). What the page does to the button or the
  form's busy indicators before the last digit, such as disabling Verify while the code
  is partial, is not a sign of a submission. The submission watch and the single click
  then work as for one input, and the alert and invalid-mark check covers every digit's
  input. When the number does not match, the fill is refused as before
  (`value-mismatch`). Not covered: inputs disabled until the previous digit is in, which
  are refused (`value-mismatch`), inputs without `maxlength` 1 or without a numeric,
  `tel` or `one-time-code` hint and a code split across forms, which end `challenge` as
  before, and a page that reads the digits only from key events or a paste, which does
  not see the code.
- **Known limitation: a wrong code on the same document.** A code page that shows the
  form again in the same document after a wrong code keeps the clicked button, so the
  login holds for two minutes before it ends `challenge`, as the held-click limitation
  below describes; so does one that submitted the code itself. A new document that
  shows the code page again ends `challenge` at once.
- **Known limitation: a silent submission.** A code page that submits the code itself
  with a background request and shows none of the signs above for 2 seconds is clicked
  as well, and so gets the code twice. That includes a page that only writes
  "Verifying…" into a status region while its field and button stay as they were.
- **Known limitation: a Verify button enabled late.** A page that enables a disabled
  Verify button only on `keyup` or `blur`, which the fill does not send, or more than
  half a second after the code goes in, reads as checking the code itself: the login
  holds the page for two minutes and ends `challenge` without a click. This fails
  closed.
- **Known limitation: a same-form code page that keeps the password input.** A form that
  asks for the code after the password and still shows the password input is a sign-in
  page to the service (`not-judgeable`) and to the extension, so its `totp` handler is
  never learned or entered; such a login ends as an unknown result.
- **Known limitation.** Variants come only from identifier sets the start page shows at
  once in one observation. A set behind a tab or a link, as SMBC's contract-number tab
  appears to be, is not observed and so not generated; such a site gets the variant the
  page shows first.
- **Known limitation: the ready variant is not the chosen one.** The document reports
  only that a first step on the start path is ready, not which variant's or route's.
  When another variant's first elements are ready but those of the variant chosen for
  the item never appear, the login waits the usual step wait and ends
  `structural-mismatch` before any fill; before variants, the document kept watching.
  The passkey button alone also starts a login, so an item without a discoverable
  passkey on a page whose password form is behind a toggle takes the `password` route
  and ends `structural-mismatch` the same way. This fails closed.
- **Known limitation: a page that keeps the clicked button.** While no completion has
  been learned, any page the clicking document shows after a held click, on any path a
  same-document URL change leads to, that keeps the clicked button in its DOM, hidden or
  not, is never judged: the login holds for two minutes and ends `challenge`. This
  applies to the `passkey` route's click and to a handler's click alike, so a site that
  signs in without leaving the document and keeps the button never learns a completion
  from such a login. A completion learned another way, such as on the `password` route,
  still applies, since it is checked before the hold.

### Watching after a challenge

Evidence (2026-10-12, the owner's Chrome, build 30dd6d7): on 三菱UFJ銀行 Pateat filled
and submitted the password, and the site showed its app-approval QR page
(`LG_0001_PC10`). The judge answered `challenge`, so the login ended there. The owner
approved in the app, the site signed in (`LG_0002_PC01`), and no later page was checked,
so the login never completed: the account was not saved as the default, the site stayed
held for other tabs for 5 minutes, and the sign-in form showing again after the site's
logout was not taken as a logout (ADR 0021 D counts only finished logins). After the
first QR code expired, Pateat did nothing more until the old tab was closed. On a later
login the QR page is not judged again (`already-judged`), so the login only settles as
unknown, with the same result.

The owner chose on 2026-10-12 (13:08 UTC, option 1 of the proposal, reviewed against the
code by a subagent):

- **Which logins.** A login on the `password` route in the tab's top document whose
  result stops at `challenge`, for any reason (the judge, a handler page shown again, a
  held click that never cleared), or settles as unknown. The `passkey` route and logins
  in a frame keep ending at once.
- **Watching.** For 10 minutes from that moment, each new page of the same tab and
  origin is checked. A `challenge` login waits in its own state, `watching`, where pages
  are read only, never filled or clicked. A login whose result settled as unknown keeps
  what it did before: its recipe's next step, a handler or a continuation showing on a
  later page still runs, since its result was never known to stop there; the watch adds
  only the judged pages, the release and the 10-minute limit below.
- **Completing.** The login completes on the recipe's completion, on evidence of a
  sign-in confirmed as in [ADR 0029](0029-local-sign-in-state.md) (E1 to E3), or when
  the judge answers `signed-in` for a page with no sign of a sign-in going on (no S1 to
  S5). At most 2 pages are judged during the watch, counted apart from the effect step's
  own 2. `rejected` ends the login `credential-rejected`. `unclear`, `already-judged`, a
  daily limit or a spent budget never completes it: it stays watched, and the judge's
  entry is a warning. Completing releases the site to other tabs, saves an automatic
  account choice, and starts the logout detection of ADR 0021 D.
- **Releasing.** While the login is watched, the recipe's first step showing in a new
  page of the tab (not the one the watch began in), as after an expired code or
  approval, releases the record as a logout does: the tab asks for an account and, with
  one account to use, fills without pressing anything, and the site's other tabs ask
  until a pick in the toolbar popup. Unlike #292, nothing is submitted again, so an
  expired QR code never sends another approval request by itself. The same release
  happens when the first step shows in a new page of another tab of the site, where the
  person may start over after closing the expired page (the owner's request after the
  check above, 2026-10-12 13:49 UTC): that tab asks and fills only, instead of being
  refused `origin-busy` until the watched tab's hold ends. Only a page Pateat first saw
  after the watch began counts, so a sign-in page left open from before does not release
  it (after a worker restart every page counts as new). The release comes before that
  tab's own checks, so if that tab is then refused for another reason, the watch is
  still over and the site's tabs ask (replaced on 2026-10-13, below). Another tab's page
  without the first step stays
  refused while the hold lasts.
- **After the watch.** The next page of the tab ends the login where it stopped
  (`blocked` with `challenge`, or `unknown-submit` for a settled one) without changing
  the record's last change time, so it holds the site only until 5 minutes after that
  time, and the rules for a login stopped after a submission apply (ADR 0021 D, 07:41
  UTC amendment), also to a page the watch already followed, other than the one it
  began in.

Implementation: the attempt contract has the `watching` state, the `WATCH_ENDED` event
and a `watch` on the record (its start, the document it began in and its judged pages),
kept by `transitionLoginAttempt`; the record schema refuses a watch on any other login.
A watched page of the tab gets the origin's first steps with its accepted hello, so the
content script watches for them as after a finished login. The watch's own document is
not read again. A restart keeps the watch; leaving the origin ends it `left-origin`
(until 2026-10-13, below).
Newer settings end it `policy-changed` only when they no longer allow its account on the
page: a watched login only reads, so it takes over a newer settings revision that still
plans its account (`POLICY_REVISED`), as when another site's account choice is saved,
and that keeps the record's last change time. On 2026-10-12 Cloudflare's saved default
bumped the revision during LinkedIn's watch, which then ended `policy-changed` with its
account still chosen. A watched login does not count as a login in progress for policy
writes or the passkey bridge, as a settled one. Logs: `login.attempt` with state
`watching` (warn), `recipe.judge` with `watched`, warn for its undecided answers and
`page-limit`, and `login.logout` with `watched` for a release.

Amended 2026-10-13 by the owner (04:30 UTC, decision card asking whether a sign-in page
shown again after a confirmation page timed out also makes the site's other tabs only
fill; answer 「このタブだけ」, this tab only), replacing the release above: a watched
login never signed in, so the first step showing again is no logout
([ADR 0021 D](0021-account-choice-outside-settings.md)). Evidence: Oracle Cloud's
challenge page timed out back to its sign-in page (2026-10-13 03:59 UTC), and Sony
Bank's login settled as unknown saw its sign-in page again (04:16 UTC), which was
released as a logout, so the site's other tabs only filled. Now the login ends
(`WATCH_ENDED` with `abandoned`): `blocked` with `challenge-abandoned` when it stopped
at `challenge`, else `watch-abandoned`, logged by `login.attempt` with no value. Its
record is forgotten, so it no longer holds the site. Only the watched login's tab asks
and fills without pressing anything, as after a login that stopped after a submission
(ADR 0021 D, `stopped-login`); the site's other tabs and new tabs log in as before, and
may show the challenge again. `login.logout` and its `watched` mark are no longer
logged for a watch.

Claude extended the owner's answer on the same grounds (the login never signed in), and
the owner has not confirmed these points separately:

- A login whose result settled as unknown is treated like one stopped at `challenge`
  and ends `watch-abandoned`.
- When the first step shows in a new page of another tab first, that tab logs in, and
  the watched tab asks if its own first step shows again.
- A watched login whose tab leaves the origin without a confirmed sign-in ends where it
  stopped (`blocked` with `challenge` or `unknown-submit`), as at the end of the watch,
  instead of `left-origin`, so its first step showing again in the tab later is no
  logout either. Before this, a timeout that went through another origin was still
  released as a logout. A login that did sign in but reached another origin more than
  30 seconds after its last step, as after a push approval on a single sign-on site,
  cannot be shown signed in and now ends this way too, as when its watch runs out.

Known gap: any tab's first step, a fill-only tab's included, ends another tab's watch,
so if the person then approves in that other tab, the login is not recorded as signed
in there. Keeping such a tab waiting instead would refuse a person who starts over in a
new tab while an old logout is still recorded elsewhere.

## Consequences

- npm in any order: B's login teaches the completion; A's login adds the security-key
  handler and clicks it in the same login; C's login adds a TOTP handler unless npm's
  page says the code was sent to the person or comes from another source. Later logins
  of all three make no Claude call.
- `https://my.jcb.co.jp/Login` shows both a password form and a passkey sign-in button
  (`#passkeyLoginButtonAD`, observed since #206), so its first generation can name both
  routes.
- The signed-in or challenge page of each new account path now reaches the service and
  Anthropic, within the limits above, not only once per new recipe. The request log
  keeps them for a year ([ADR 0012](0012-inference-request-log.md)).
- Custom-field names, and the Text shapes all matching items agree on, now reach the
  service and Anthropic with each generation request, and the request log keeps them.
- A site that asks for a security key as its second factor signs in with no human
  action; that factor then comes down to "Pateat is unlocked and holds the passkey",
  which the owner accepted on 2026-10-11 (12:52 UTC).

Not handled:

- SMS and email codes, and codes from other sources such as recovery codes. They end
  `challenge`. A code page shared by SMS, email and TOTP on one path that says nothing
  about where the code comes from gets the item's TOTP once (2026-10-13, above); a
  wrong code then ends `challenge`.
- Completion pages whose path differs per account; only the first learned one matches.
- An item whose fields fit no variant of the stored recipe; it stops with `no-route`.
  Adding a variant to an existing recipe is later work.
- A start page that asks for username, password and a code in one form, for an account
  without TOTP, when the recipe was generated with an account that has it.
- Paths that carry user IDs: handlers and judged paths are stored per path, so such a
  site may get several handlers, within the daily limit.
- Recipes generated before this design gain handlers and completions, but not routes. A
  route needs regeneration: revoking the recipe in the web UI has its start page
  generated again on the next visit (ADR 0018, owner decision of 2026-10-12).
- A passkey stored in another vault item than the login item.
- A 2FA page path shared by several methods. A page is judged once per recipe revision,
  path and judge prompt version, so the first account judged there decides what is
  learned: if a TOTP account is judged first, the security-key handler on that path is
  not learned until a new revision or judge prompt version.
- Start pages without a password input (passkey-only or SSO-only) are never generated
  (ADR 0016 condition 3); that is left to the SSO work.
  ([Amended 2026-10-19](#amendment-2026-10-19-passkey-only-start-pages-and-wider-passkey-words).)
- Passkey requests the bridge already passes on: `silent` or `immediate` mediation
  (`conditional` is answered through a login since ADR 0034, `required` since an
  amendment of ADR 0007), external-only transports, a nonzero counter, an incomplete
  vault, timeout.

## Alternatives

- One linear second-factor step appended to the recipe ("option B", approved at
  13:06 UTC and set aside at 13:21 UTC): breaks as soon as accounts differ, as above.
- Free-form branch conditions written by the model: cannot be learned from one page or
  checked by the service.
- A recipe per account: recipes could not be shared, and every account would pay for
  its own generation.
- SSO before passkey: rejected by the owner at 13:40 UTC.
- Telling the model whether the account has TOTP: rejected by the owner at 13:42 UTC;
  the page decides whether `totp` is offered.
- At most 3 judgements per recipe per day: too low for the owner (13:43 UTC), who chose
  20.

## Delivery

Each part is its own PR with an independent review, and a real-Chrome check on
npmjs.com or MyJCB where it applies:

1. Custom-field names and Text shapes in generation, with generic slot IDs and the
   bindings they produce, after the username shape
   ([#213](https://github.com/risu729/pateat/pull/213)).
2. Handlers with the `passkey` handler: item facts and the catalog flags, route and
   handler state in the attempt, the judging rules and limits, the first-login takeover,
   the bridge using the login's item, and no `totp` slot for start pages without a code
   field.
3. Start-page routes: `password` with variants and `passkey`, and start detection for
   several routes.
4. The `totp` handler.
5. The `sso` route, implementing ADR 0026.

## Amendment 2026-10-18: slot names from the page

The owner asked at 07:29 UTC whether the slot names could come from the page's fields
instead of the model, and at 07:54 UTC asked for no limit on words or length, for
Japanese names to stay Japanese, and for names that say which field they are, not
`field-one`. The proposal that followed was reviewed by an independent subagent against
the code and accepted at 08:58:31 UTC ("進める").

- **The model maps, the service names.** The generation answer has no `name`; it maps
  request slots to candidates only. Plan validation (`customSlotNames`, run in
  `validateGeneratedSets` over the identifier sets the recipe keeps: every set on a
  start page, the first alone on any other) names each custom-field slot from its
  element's text, the first that gives a name: the label (which already holds the
  `<label>`, `aria-label`, the text before the field up to three levels up and the
  `title`), the placeholder, the `aria-describedby` description, then the `id`, `name`
  or test ID locator value. A field with none is `欄 N`, or `field N` on an English
  page, N counting the page's fill fields without a name from the top.
- **Skipped text.** Text holding a redaction mark (`[number]`, `[email]`, `[masked]`,
  `[account]`) or a number anywhere, even past the 60-character cut, is skipped, as the
  label locator skips it (ADR 0037), so a value a later page shows back never becomes a
  name.
- **Form.** Text is taken in NFKC without default-ignorable (invisible) characters, with
  whitespace collapsed to single spaces and trimmed; a trailing copy of the placeholder
  or description is dropped from the label (`店番 半角数字3桁` → `店番`), and a label
  left empty falls to the next source. Case and language are kept, and a name has at
  most 60 characters. The recipe slot ID schema takes 1 to 60 NFKC characters without
  control, format or default-ignorable characters, words apart by single spaces;
  built-in slot names stay as they are, and login identifiers stay ASCII.
- **Equal names.** Names are compared without case. One equal to `username`, `password`,
  `totp`, a request slot ID or an earlier name of the page takes a number after a space
  (`店番 2`, `店番 3`), in page order rather than the answer's, so an unchanged page
  always gives the same names. A slot that fills different elements in different sets
  takes the name of its element in the first set that fills it. A continuation page's
  name equal to a slot of the recipe it continues still fails `recipe-invalid` and is
  not numbered: a form shown again after an error would otherwise become a next page
  that fills the same field again (ADR 0018).
- **Other roles.** The finite-choice decision role and the benchmark heuristic name
  custom slots the same way, so they answer on pages that need one. The request log's
  refused plans no longer carry names to reduce to `name-N` (ADR 0012).

The agent's choices, not confirmed by the owner: a `mixed`-language page gets `欄 N`; a
trailing copy is kept when it would split a Latin word or number (`word` in `Keyword`);
format characters are refused as in observed text, and default-ignorable ones are also
refused and stripped from page text; the continuation's comparison ignores case; a role
that checks one set names it alone; a page after the start page names its slots from the
first set alone, since its alternatives are dropped and a name such as `番号 2` must not
be stored without the `番号` it was numbered apart from; and an accepted plan's logged
`result` keeps the names it got.

Consequences: a recipe now stores more page text than the label locator does, such as
"Enter your Security number" or a display name a label shows (ADR 0037), and the
review before recipes are shared covers slot names too (ADR 0013). A name follows the
page's wording, so a recipe generated again after a wording change may rename a slot,
and a saved binding then no longer covers the recipe (`binding-slots-mismatch`) until it
is removed in `/manage`. (Since 2026-10-19 the renamed slot is filled when a template
names it, and refuses so only otherwise:
[saved bindings that lack a slot](#amendment-2026-10-19-saved-bindings-that-lack-a-slot).)
A name in another script that looks like a built-in one (Cyrillic `раssword`) passes
the check; it only reads confusingly. The names the five active production recipes
already have stay valid.

## Amendment 2026-10-19: slot names from the bindings

At 00:58 UTC the owner asked that a recipe generated again be tied to the names it
already has
(「レシピの作り直しのときに、既にある名前と紐づけるようにすればいいのでは？」). Revoking
a recipe in `/manage` leaves only its tombstone, and the recipe generated again has the
same ID, so its saved bindings still apply; but a page whose wording changed gives new
names, and those bindings then fail `binding-slots-mismatch`. The proposal (A: the
service reuses the bound names; B: the extension renames the bindings) was reviewed by
an independent subagent against the code, and the owner chose A at 01:22 UTC (「A
前の名前を使う」).

- **Bindings read.** For every generated page with a custom-field offer (a recipe's
  first page, new or generated again, a continuation and a chooser branch's page), the
  service reads the owner's saved bindings of the same origin and recipe ID, every
  account's (`recipeBindingSlots`), and takes only each entry's slot name and field
  reference, never the item or a value. The prompt is unchanged, and no model takes
  part.
- **Matching** (`carriedSlotNames`). A request slot with a `fieldName` matches an entry
  whose field is `{ custom }` with that name and, for a duplicate name, the same
  `position` and `count`; `username`, `password` and `totp` entries never match. A field
  the bindings give different names, as two accounts may, carries none.
- **Naming** (`customSlotNames`). A carried name counts only when it passes
  `customSlotIdSchema` and, without case, equals no built-in slot and no request slot
  ID; otherwise the slot is named from the page as before. Such names are reserved
  before any page text, so a field whose text gives the same name is numbered apart
  (`店番 2`), and a filled slot takes its carried name. The recipe never copies the
  vault field name; a carried name is whatever the binding already had.
- **Continuations.** A carried name equal to a slot of the recipe being continued fails
  `recipe-invalid`, as a page name does, so a form shown again stays refused.

The agent's choices, not confirmed by the owner:

- The carried names of every offer of the request are reserved, also of offers the page
  does not fill, so an unbound field of the first page cannot take the name a later page
  carries and then make that page fail `recipe-invalid`. The cost: offers are the union
  of every matching account's fields, so an unbound field the page fills whose text
  equals another offer's bound name is numbered apart (`店番 2`), and a binding that
  matched that field only because its page text was unchanged no longer does; that
  account then gets `binding-slots-mismatch`. The service cannot tell this case from the
  cross-page one, since it does not know which field filled a base slot. A recipe may
  then also store `店番 2` without any `店番`, when the reserving offer never appears on
  a later page. That departs from why the 2026-10-18 amendment names a later page's
  slots from its first set alone (no `番号 2` stored without its `番号`, as a dropped
  alternative would leave); this is accepted as cosmetic.
- Two slots of one page that would carry the same name, without case, both take their
  page names instead; the name stays reserved. When two different fields are bound to
  the same name by different accounts and only one is filled, it carries the name; if
  the other is filled on a later page, that page fails `recipe-invalid` where the page's
  text alone would have named it.
- Names are compared exactly across bindings, so `Branch` and `branch` disagree and
  nothing is carried.
- On a continuation, the names the page's text alone would give are also checked against
  the recipe's slots, so a page refused before is refused when its field carries another
  name.
- The bindings are read once, before the model call; a stored settings document that
  fails its schema fails the request as an internal error, as the settings route does.
- The request log does not mark which names were carried.

Consequences: a name now follows the bindings as well as the page, so an unchanged page
gives the same names only while the bindings are unchanged; a name the model gave before
2026-10-18 (`branch-number`) or an earlier page's wording stays while a binding uses it.
Since the request names no item, the name may come from another account's binding of the
same owner and recipe. It does not help when the account's vault field is named
otherwise, when the start path (and so the recipe ID) changed, or for a field no binding
names yet; there the 2026-10-18 consequence (`binding-slots-mismatch` until the binding
is removed) still holds, and since the
[2026-10-19 amendment](#amendment-2026-10-19-saved-bindings-that-lack-a-slot) it
holds only when no template names the new slot either. Recipe repair, once built, can
use the same matching.

## Amendment 2026-10-19: saved bindings that lack a slot

On 2026-10-19 at 12:50 UTC, in the owner's Chrome on build `cfce11f`, UniSuper's login
pressed "Select" for the password ([ADR 0048](0048-password-method-button.md)), and the
service returned the continuation that fills the password and presses Verify. The login
did not take it over and settled `unknown`. The item's saved binding of the recipe,
saved on 2026-10-17 at 01:34 UTC after revision 1, which filled only the username, and a
login wrongly judged `authenticated` (fixed since
[#571](https://github.com/risu729/pateat/pull/571)), named only `username`. The rule
above ("a saved binding for the item is the only source") made the takeover refuse
`binding-slots-mismatch`, every later login of the item would refuse the same way until
the binding was removed in `/manage`, and the log named no reason (`recipe.generate`
`takenOver: false` only). The proposal was reviewed by an independent subagent against
the code. The owner approved a revised proposal, which replaced its option A (fill
built-in slots only), at 22:48 UTC on 2026-10-19 ("yeah sounds good. go ahead"):

- **Saved entries.** The entries a saved binding names are used as they are.
- **Gaps.** The slots of the route that the saved binding does not name are filled the
  same way as for an item with no saved binding: `username`, `password` and `totp` from
  the item's built-in fields, and custom slots from the templates (the recipe's other
  saved bindings of the origin, then the generated slot map), with the same name-match
  rules and the same `field-missing` and `field-ambiguous` refusals
  (`fillLoginBinding` in `packages/contracts`).
- **Variants.** In a recipe with several `password` variants, the variants are first
  tried with the saved binding as it is; only when none fits are the gaps filled, again
  in recipe order. An item whose binding fits its second variant keeps that variant,
  even when the first could be filled.
- **Widening.** After an `authenticated` login, the filled slots are written into the
  saved binding (`saveLoginChoice` replaces a binding with one that starts with each of
  its entries in their order and adds slots after them), so the binding is widened.
- **Everywhere a plan is built.** The same rule applies at login start, to the
  continuation's takeover (`continueWith`, ADR 0018) and to each step's authorization,
  which plans the recorded route again.
- **Logged refusals.** A takeover the login refuses is logged with why, as a value-free
  code: `recipe.generate` gains `notTakenOver` beside `takenOver: false` (in the
  [local log](../architecture.md#local-log)), such as the plan's
  `binding-slots-mismatch` or `field-missing`.

Claude's details, not confirmed by the owner:

- A built-in field the saved binding already names directly under another slot (as
  `{ "slot": "Web password", "field": "password" }`) never fills a missing built-in
  slot, so the same value is not typed into a second field; that slot stays unfilled and
  the plan refuses as before. Only direct references are compared: a custom field linked
  to that built-in field is not detected.
- Existing entries are never overwritten, also when a template names another field for
  the same slot.
- A gap that no template names stays unfilled and refuses `binding-slots-mismatch`, as a
  saved binding that lacks a slot did before, not `binding-not-found`. A widened binding
  over the binding schema's 20 slots refuses the same way.
- A variant fits as it is when it passes every check of "Choosing a variant" without a
  gap filled (fields allowed, bound password or TOTP fields holding values, the stop of
  an item without a password). The second round runs only when the first refused some
  variant `binding-slots-mismatch`, and its result, with its refusals, is the plan's.
- The widened binding keeps the saved one's display names (`itemName`, `accountName`)
  and its place in the list; the site default is written only as before. As before,
  nothing is saved when a list is full, and a login that does not authenticate widens
  nothing. A fill-only login after a logout and a pick made for one login only fill
  gaps for that login and save nothing.
- The generated slot map is read at most once per plan resolution; with the two rounds
  and each step's authorization it may be read several times per login.
- `notTakenOver` is logged on the `recipe.generate` entry of the document that asked for
  the continuation. A revision taken from the recipe cache, or an answer a later
  document waited for, still logs no `recipe.generate` entry, so its refusal is not
  logged there. The codes are `left` (the login ended or moved meanwhile),
  `route-missing` (a chooser's answer without the login's branch), `route-not-password`,
  `recipe-changed`, `not-continued` (the revision does not continue the one the login
  ran), `settings-unavailable`, `settings-revision` (the settings changed since the
  login was authorized), the plan's own refusal, `account-changed`, `stop:<miss>` (a
  login stopping before its item's missing password that the continuation cannot stop
  in, with the miss of [ADR 0036](0036-passkey-after-the-identifier.md)), `not-ready`,
  `budget-exceeded` (more steps or effects than one page may add) and `not-recorded`
  (the takeover was not recorded).

Consequences: a binding saved before a recipe grew no longer blocks the item: UniSuper's
binding is widened by the next login that signs in. A binding written by the owner gains
entries too, which `/manage` shows; nothing tells the owner when that happens. The gap
filling reaches the same fields an item without a saved binding already reaches, and
the exclusions, the item's facts and the TOTP rules apply to the filled binding as to
any. A slot renamed when a recipe is generated again
([slot names from the page](#amendment-2026-10-18-slot-names-from-the-page)) is filled
when a template names its new name, as this device's generated slot map does after the
generation; without one it still refuses `binding-slots-mismatch`, and the stale entry
stays in the binding. A gap filled from a sibling binding or the generated map is a
guess by field name, checked only by resolution and the login's outcome, as for an item
without a saved binding.

## Amendment 2026-10-19: passkey-only start pages and wider passkey words

**Passkey-only start pages** (owner, 2026-10-19; recipe shape 20:31 UTC;
[ADR 0053](0053-passkey-only-generation.md)). A start page that shows no input, only a
button naming a passkey or security key, is generated when a URI-matching item holds a
discoverable passkey for the site. Its recipe has `passkeyOnly: true`, no slots, one
click step on that button that submits, `maxSubmissions: 1`, and the same button as its
`passkey` route; it has no `password` route, so only an item with a discoverable passkey
takes it, and a password-only item gets `no-route`. This replaces, for such pages, the
limit under [Consequences](#consequences) that they are never generated. SSO-only start
pages are still not generated.

**Wider passkey button words** (owner, 2026-10-19 20:29 UTC: keep 生体認証 and widen
the list, "broad is fine"). The words that name a passkey (`passkeyWording` in
`packages/contracts/src/passkey-button.ts`) also take the device unlock a passkey uses:
Face ID, Touch ID, Windows Hello, biometric, biometrics, fingerprint, fingerprints and
face recognition, as whole Latin words like the others (so "Facebook" or "interface"
never match), and 指紋 (also 指紋認証) and 顔認証 anywhere. The registration words, with
their 設定済み and 有効な exceptions, are unchanged, so "Touch ID を登録" or "Set up
Windows Hello" is still refused. The list is shared, so this widens the generated
`passkey` route's button check and the passkey-only start page of
[ADR 0053](0053-passkey-only-generation.md) alike; the judge's `passkey` handler check
still uses only the registration words.
