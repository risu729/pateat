# ADR 0027: Login routes and second-factor pages chosen per account

Status: accepted by the owner on 2026-10-11 (13:47 UTC). Delivery 2 (handlers with the
`passkey` handler) is implemented; the other deliveries are not. Amends
[ADR 0007](0007-existing-passkey-assertions.md) and
[ADR 0021](0021-account-choice-outside-settings.md) (which item answers a passkey
request during a login), [ADR 0010](0010-inference-field-hints.md) and
[ADR 0016](0016-recipe-generation-trigger.md) (custom-field names and Text shapes in
automatic generation), [ADR 0013](0013-service-held-recipes-and-settings.md) (bindings
per route), [ADR 0018](0018-recipe-generation-route.md) (when a page is judged and the
judge's limits) and [ADR 0026](0026-sign-in-through-identity-providers.md) (SSO as a
route). Each part lands in its own PR (see [Delivery](#delivery)); the ADR 0010 and
ADR 0016 status notes land with the custom-field part.

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
`mediation`, or with `optional`) needs no branch: the bridge already answers it.

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
   password.
2. **The start is detected** by watching the first element of every route, without
   reading the vault, as today for one first step.
3. **After each effect step** the executor checks, in order: the completion, the
   rejection, the route's next step, then a handler whose path matches and whose first
   element is present.
   - Each handler runs at most once per login, so a wrong TOTP code is never retried
     into a lockout.
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
    refused, and so is a page that shows the completion marker.
  - `challenge` naming an authenticator-app code field and its submit button adds a
    `totp` handler. The field must pass the TOTP fill rule of ADR 0013, and the judge
    must say it is an authenticator app, not SMS or email.
  - Anything else stores nothing.
- **Limits:** each recipe revision and page path is judged at most once; at most 20
  judgements per recipe per day (UTC), whatever the path (owner, 13:45 UTC); and the
  existing $5 a day and $100 a month.
- **First login:** when a judgement adds a handler, the running login takes the new
  revision and runs the handler on the page it is on, if the item has the fact. Its step
  and submission budget grows by the handler's steps. A login accepts a newer revision
  only when its routes and route steps are unchanged and it only adds handlers or a
  completion; any other revision still makes a resumed login answer
  `recipe-not-found`.

### What the model receives

- The page: structure and redacted labels, never values (`LoginObservation`).
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
  (ADR 0025), and saving an account choice or a passkey site default from another tab.
  Unlike the bridge, a login whose result settled as unknown counts again while the
  extension checks or judges one of its pages, so a judgement that adds a handler is not
  cut off. Its record stays until the tab closes; if it counted, the settings sync's
  two-minute wait would run out once and never restart, so every later login would be
  stopped by the next settings write, and the vault's two-minute deferral would likewise
  force its replacement into later logins. A policy write while a login is settled stops
  it as `POLICY_CHANGED`, and its later pages are no longer judged.
- **Recipe refresh after a judgement.** A judgement that changes the recipe pulls
  recipes only. A full sync could apply a settings change from the service, which stops
  every running login as a policy change, including the one the judged page belongs to.
  Settings follow at the next full sync.

## Consequences

- npm in any order: B's login teaches the completion; A's login adds the security-key
  handler and clicks it in the same login; C's login adds a TOTP handler if npm's page
  says it is an authenticator app. Later logins of all three make no Claude call.
- `https://my.jcb.co.jp/Login` shows both a password form and a passkey sign-in button
  (`#passkeyLoginButtonAD`, observed since #206), so its first generation can name both
  routes.
- The signed-in or challenge page of each new account path now reaches the service and
  Anthropic, within the limits above, not only once per new recipe. The request log
  keeps them for 90 days ([ADR 0012](0012-inference-request-log.md)).
- Custom-field names, and the Text shapes all matching items agree on, now reach the
  service and Anthropic with each generation request, and the request log keeps them.
- A site that asks for a security key as its second factor signs in with no human
  action; that factor then comes down to "Pateat is unlocked and holds the passkey",
  which the owner accepted on 2026-10-11 (12:52 UTC).

Not handled:

- SMS and email codes, and a code page shared by SMS, email and TOTP on one path unless
  the page says which. They end `challenge`.
- Completion pages whose path differs per account; only the first learned one matches.
- An item whose fields fit no variant of the stored recipe; it stops with `no-route`.
  Adding a variant to an existing recipe is later work.
- A start page that asks for username, password and a code in one form, for an account
  without TOTP, when the recipe was generated with an account that has it.
- Paths that carry user IDs: handlers and judged paths are stored per path, so such a
  site may get several handlers, within the daily limit.
- Recipes generated before this design gain handlers and completions, but not routes. A
  route needs regeneration, which today means revoking the recipe, and that stops
  generation for its path (ADR 0018).
- A passkey stored in another vault item than the login item.
- A 2FA page path shared by several methods. A page is judged once per recipe revision
  and path, so the first account judged there decides what is learned: if a TOTP account
  is judged first, the security-key handler on that path is not learned until a new
  revision.
- Start pages without a password input (passkey-only or SSO-only) are never generated
  (ADR 0016 condition 3); that is left to the SSO work.
- Passkey requests the bridge already passes on: `conditional`, `required` or `silent`
  mediation, external-only transports, a nonzero counter, an incomplete vault, timeout.

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
