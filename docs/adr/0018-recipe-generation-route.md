# ADR 0018: Service recipe generation route

Status: accepted by the owner on 2026-10-11; implemented. Amends
[ADR 0016](0016-recipe-generation-trigger.md) (which pages are observed) and settles
the retention left open by [ADR 0012](0012-inference-request-log.md). The service
routes are implemented ([API README](../../services/api/README.md#recipe-generation)).
The extension sends a recipe's first page, a page that an effect step leads to and no
check explains, and the page after a recipe's final `advance` step, which continues the
recipe in the running login
([Continuing after an advance](#continuing-after-an-advance)).
Its one generated recipe per origin is amended to one per start path by
[ADR 0016](0016-recipe-generation-trigger.md#pages-where-no-recipe-starts), which the
service and the extension implement.
How a page after a submission is settled, and when it is sent to the judge, is amended
by [ADR 0029](0029-local-sign-in-state.md), whose first part of delivery 2 (completing
on confirmed evidence of a sign-in) is implemented.
Amended on 2026-10-11 by [ADR 0027](0027-per-account-login-routes.md): a page is judged
after any effect step that leads nowhere known, a judgement can add a second-factor
handler, and judgements are limited per revision and path and to 20 per recipe a day
(implemented with the `passkey` and `totp` handlers).
Amended on 2026-10-12 by the owner's decision on a sign-in form's lone `new-password`
field ([Decision](#decision)), which the plan check implements.
Amended on 2026-10-12: every number on the page shown after sign-in becomes `[number]`
([Architecture](../architecture.md#declarative-recipes-and-ai)).

Date: 2026-10-11

## Context

ADR 0016 decides which pages are observed and sent for recipe generation, but leaves
open how the service turns a `LoginObservation` into a recipe and when the extension
uses it. The generation role (`createRecipeGenerator` in `packages/inference`) maps
slots to the candidates of one page and names one button. A recipe
(`loginRecipeSchema` in `packages/contracts/src/login.ts`) also needs a `completion`
target: an element on the page reached after signing in, which the executor uses to
report `authenticated`. That target cannot be derived from the login page alone.

## Decision

The owner chose these on 2026-10-11:

- **Success check: the page after submitting is sent too.** A generated recipe starts
  without a `completion` target. After its final `submit` step, the extension observes
  the resulting page once and sends it to the service. Claude decides whether that page
  is signed in. If it is, it names an element only a signed-in page shows, such as a
  logout button. The service saves that element as the recipe's `completion` in a new
  revision, and the attempt ends `authenticated`. Otherwise it ends
  `credential-rejected`, `challenge` or `unknown` as Claude reports. Later runs use the
  saved `completion` and send nothing after login.
- **Use: immediately.** A recipe the service returns is cached and run on the same page
  at once, about 5 to 20 seconds after the page loaded, with the existing submission
  limits and fill rules.
- **Request log retention: 90 days** for the ADR 0012 log, after which rows are
  deleted. A delete-all action comes with the web UI.

The owner added on 2026-10-12 (chosen on a decision card as "allow it when it is the
only field" and confirmed at 05:59 UTC, with the wish that Pateat never signs up by
mistake): **a lone `new-password` field on a sign-in form takes the password.** SBI
Securities' login form marks its only password field `autocomplete="new-password"`, and
the plan check refused Claude's correct plan for it (username, password, submit) as
`incompatible-role`. A password or Hidden slot may now go into such a field; every other
`new-password` field still refuses a secret.

The checks that keep sign-up forms out are implementation choices made with it, not
owner decisions (`loneNewPassword` and `validatePagePlan` in
`packages/inference/src/plan.ts`). All must hold:

- It is the only input of its form that is a password input or marked
  `current-password` or `new-password`, so there is no confirmation field.
- No input of its form carries a personal-data autofill token (a name, organization,
  address, birthday, sex or telephone part), which a sign-up form asks for. A sign-in
  by phone number marked `tel` is therefore refused, a conservative choice.
- No input of its form is marked `one-time-code`, as on a password-reset form.
- No input outside its form shows a sign-in as the judge reads one: a password input
  not marked `new-password`, or an input marked `username`, `current-password` or
  `one-time-code`. Such a page signs in there, and the lone field belongs to a sign-up
  form, as when an identifier-first sign-in sits beside an email and new-password
  sign-up form.
- The plan fills an identifier of the same form whose `autocomplete` is `username`,
  `email`, `off` or absent. A plan that fills the field without one fails the plan
  check as `lone-new-password`.

A sign-up form with only an email and one password still passes these checks, so the
model's `no-login-form` abstention remains the guard there; its description in the
response format now names sign-up and password-change forms. The same holds for a
widget that shows its sign-up tab while the sign-in tab is hidden, since hidden inputs
are not observed, and for a sign-up form whose name or phone inputs carry no
`autocomplete` token. If the model misses one, the existing username and password are
submitted to that form, which a site usually refuses as already registered.

The route follows from these and from ADRs 0013 to 0016:

- `POST /v1/recipes/generate` takes a device credential and
  `{ version: 1, observation: LoginObservation, slots: SemanticSlot[] }`. The service
  validates it with the package schemas. It resolves the owner's credential through
  `resolveClaudeCredential` (ADR 0015) and calls `createRecipeGenerator` once. It
  checks the plan with `validatePagePlan` and saves the steps as one recipe per origin
  (per origin and start path since the ADR 0016 amendment).
  It answers synchronously with the saved recipe, an abstention reason, a failure code
  or an unavailable reason (no credentials, a limit reached, busy, or tried within the
  ADR 0016 retry window).
- A login that spans pages is generated one page at a time. When an `advance` step
  leads to a page the recipe has no steps for, that page is sent and its steps are
  appended to the same recipe in a new revision.
- The extension writes the slot-to-field bindings itself and uploads them with settings
  sync; the service never sees item IDs.
- Limits per owner: $100 a month (the ADR 0014 default, estimated from returned usage
  and a versioned price table), $5 a day (UTC), one call at a time, and the ADR 0016
  retry window per origin and path (24 hours until 2026-10-12, now 10 minutes),
  enforced again on the service. The owner replaced
  the first limit of 50 calls a day with the daily amount on 2026-10-11.

Failed recipes are not repaired by this route; repair is a later design.

Implementation choices that follow from these decisions, made on 2026-10-11 without a
new owner decision:

- The daily limit counts the spend of judgement calls as well as generation calls, so
  repeated post-login pages for one revision are bounded too. Like the monthly one, it
  is checked before each call against the day's estimated spend, including the upper
  bound held for a call whose usage was not reported (about $0.43), so a day can end at
  most one call over $5. A typical call costs about $0.007 (the approved benchmark),
  so $5 is about 700 calls; a day of calls that report no usage stops after about 12.
- A page that continues a recipe after an `advance` step counts toward the retry window
  under that recipe revision, not under its path alone, so the password form of a login
  that stays on `/login` is not refused as a retry of the email form.
- Each origin and start path has one generated recipe ID. Revoking it stops its later
  pages and judgements, but its start page is generated again on the next visit, as the
  revision after the tombstone (owner decision, 2026-10-12). That attempt is keyed by
  the tombstone's revision, so the earlier recipe's attempt does not hold it back. A
  device offers the page again once its recipe sync has removed the revoked recipe. The
  recipe keeps its ID, so a saved binding or this device's slot map for it still
  applies. Until then a revoked recipe stopped generation on its start path for good.
- Log rows older than 90 days are deleted whenever a call is logged and whenever a
  device reads the recipe change feed, since routine releases do not apply scheduled
  triggers. Requests refused locally before any model call are not logged.
- The extension sends the page after the final submission once the usual three-second
  observation finds no other result. A page that still shows one of the recipe's fields
  on one of its paths is not sent, since the sign-in has not finished there. Each
  attempt sends at most one such page while the extension's service worker runs; an
  attempt resumed after the worker restarts may send it again, within the daily limit.
- That page is described by `extractSignedInObservation`: every field on the page, which
  the judge needs to refuse a page that still shows a sign-in field. Until 2026-10-12
  every field that could not be filled made the page incomplete; since then (added
  after this decision) a read-only, transparent or tiny field that does not look like a
  sign-in field is left out: not a password or email input, no `username`, `email`,
  `current-password`, `new-password` or `one-time-code` autocomplete token, not a short
  numeric field. A hotel search's read-only date picker is such a field. A disabled
  field still makes the page incomplete, as a code field waiting for a timer may be
  disabled. Then come buttons and
  links as possible markers up to the 48-candidate limit, those in the page header or
  navigation first. A link may be located by its text, and the executor then finds the
  completion marker by that text; text with a digit never locates a marker. An `id`,
  `name` or `data-testid` value that the label redaction would change is never used as a
  locator there, since signed-in pages often name the account in them: such a button or
  link is left out, and such a field makes the page incomplete.
- While a model call runs, the extension calls an extension API every 20 seconds, so
  Chrome does not stop its service worker and lose the answer. It waits up to 90
  seconds; a page whose answer timed out is freed for its next visit, which the service
  answers with `recently-tried` or the written recipe if the model was called
  ([ADR 0016](0016-recipe-generation-trigger.md)).

Diagnostics added on 2026-10-12, after a real page's `invalid-output` could not be told
apart from other failures; they are implementation choices, not owner decisions:

- A generation that fails `invalid-output` names the check that refused the model's
  output in its answer and in the request log, in codes only: the output was not JSON,
  failed the output format at a path, or failed the plan check with its code. The
  request log also keeps a plan the plan check refused, reduced to the request's
  candidate and slot IDs, with each name the model gave replaced by a placeholder. The
  extension logs the check and its codes with `recipe.generate`.
- Each request log row records the role's prompt version, a short hash of its
  instructions and response format, so a row shows which instructions produced it.

### Continuing after an advance

Implementation choices for the page after a recipe's final `advance` step, made on
2026-10-12 without a new owner decision:

- **Which logins.** Only a login on the `password` route and the recipe's own steps (its
  first variant), in the tab's own page rather than a frame, whose recipe has no
  `completion` and no `alternatives`, and only once the step in flight is the recipe's
  last step, an `advance`, and never a login that only fills the form after a logout,
  which stops before the advance (ADR 0021 D). Once the result would settle as unknown,
  confirmed sign-in evidence still completes the login before the continuation's own
  rule applies (ADR 0029). A recipe with a completion has already reached a signed-in
  page; its later pages are judged as before
  ([ADR 0027](0027-per-account-login-routes.md)).
- **Which page.** The page qualifies once it has finished loading
  (`document.readyState` is `complete`) and has shown, on one path for a second within
  the advance's 10-second wait, a sign-in input for a built-in slot the recipe does not
  fill yet that is not one of the recipe's own fields:
  - a visible writable password input, while the recipe fills no `password`. It
    qualifies even beside the identifier field the recipe filled, still writable, as a
    form that reveals its password input below the email field on the same path;
  - a visible writable email input or one marked `username` or `email`, while the recipe
    fills no `username` and none of the recipe's fill fields is writable on the page, on
    any path. So the identifier form shown again where it posted (an unknown account, a
    captcha) and a signed-in page with an unrelated email box are judged instead.

  An input marked `new-password` or `one-time-code`, and every input of a form that
  holds one, never counts: a sign-up, password change or code form is not continued, and
  a code page is judged, which may add a `totp` handler (ADR 0027). Any other page is
  judged as before. The email input and the `email` token widen ADR 0016's third input
  condition for this page only, since email-first sign-in pages often mark their field
  only as an email address.
- **One request per step.** The page is described by `extractLoginObservation` and sent
  only when the description is complete, on the login's origin and on the path that
  qualified. The login's own vault item must still match the page, as for a first page;
  a vault or tab that cannot answer for a moment, or a match that could not evaluate
  every item, is asked again on the next round. The request offers only the slots the
  recipe does not fill yet, and no custom field the recipe's generated slot map already
  names (ADR 0027), and both the extension and the service refuse a page whose steps
  fill one of the recipe's slots again, before anything is stored. A read-only or
  disabled field that the recipe already fills on that path, such as an identifier the
  page shows again, is left out instead of making the description incomplete. The
  request is recorded in the attempt before it is sent, so a worker restart cannot send
  that step's page again, and the login makes one model call per final advance within
  the 10-minute retry window ([ADR 0016](0016-recipe-generation-trigger.md)). The
  request is given back for a later document of the tab by
  the generation claim's own rule ([ADR 0016](0016-recipe-generation-trigger.md)): when
  its claim is freed because the request did not reach the model, or it was not sent
  because no service is paired, storage could not be written or the same request is
  still `sending`. A continuation answered `recipe-revoked` or `recipe-conflict` is
  spent instead, since a later document would get the same answer. The same document
  does not send it again, even after a path change or
  a moment in which the page stopped qualifying. A document left while the request was
  being recorded may leave it recorded with nothing sent; that fails closed, as a spent
  request. A qualifying page whose request is spent or whose answer cannot be used
  settles `unknown` without a judge call: it still asks for credentials, so the judge
  could not learn anything from it. The log says why such a page was not sent
  (`recipe.generate` `skipped`, once per document) and that the judge was skipped
  (`recipe.judge` `not-sent`, `continuation`).
- **Recipes-only refresh.** A returned revision is pulled with recipes only, as after a
  judgement, so a settings change from the service does not stop the login that asked
  for it.
- **Taking over.** "Use: immediately" applies to a continuation too, as the owner
  decided at 04:11 UTC on 2026-10-12
  ([ADR 0027](0027-per-account-login-routes.md), First login after an advance): the
  running login takes the new revision over when it keeps every step, slot, handler and
  setting of the revision the login ran and only appends steps (`continuesRecipe` in
  `packages/contracts`), and when a dry run of the login's recorded route on it still
  resolves to the login's own account. The steps already run do not run again. The step
  and submission budget grows by the appended steps and effects: at most 32 steps and 8
  effects per recipe, and at most 40 steps and 12 submissions per login. The account
  choice saved after `authenticated` is derived from the new revision, so it covers both
  pages' slots; a saved choice that cannot fill the new page's slots stops the takeover.
  A revision that is not taken over stays cached for the next visit, and this login
  settles `unknown`.
- **New documents and restarts.** A form that posts back during the request makes a new
  document; the login there keeps the revision it ran and takes the continuation over
  once it reaches the recipe cache, or once the answer the earlier document asked for
  arrives: the extension keeps that request in memory until the login ends, and the new
  document waits for it for up to 100 seconds, past the step's 10 seconds. An answer
  that gives the request back lets the new document send it. A login resumed after a
  worker restart does not send the page again and settles `unknown` on it unless the
  cache already holds the continuation.
- **Limitations.** A page that shows the password and a one-time-code input in separate
  forms may put `totp` into the recipe's steps rather than a handler; in one form it is
  not continued. A continuation on another origin is not supported: the login ends
  `left-origin`. When a worker restart lost the answer and the cache already holds the
  continued revision, a later document of that login answers `recipe-not-found`. A
  recipe whose first page fills no `username` can still be continued on a later page
  with an unrelated email box. On a form that reveals its password input below the email
  field, a later login continues after Next only when the password input was missing,
  hidden or disabled before Next
  ([ADR 0013](0013-service-held-recipes-and-settings.md)'s same-path rule); one that was
  already usable leaves the login `unknown` after Next. A code input typed `password`
  without `autocomplete="one-time-code"` counts as a password input, so such a code
  page is sent to be continued rather than judged. A sign-in form whose only password
  field is marked `new-password`, which a first page may fill since 2026-10-12, is not
  continued after an `advance` step: such a page is judged.

## Consequences

The service and Anthropic see, once per new recipe, the page shown right after the
first sign-in. That page can carry the owner's name or balances in its title and
headings, within the extractor's label redaction (`[email]`, `[masked]`, and
`[number]` for every number on that page since 2026-10-12). The page after an `advance`
step, like any judged page, may show the identifier just entered and is sent as
observed; redacting the account's own username from every description is planned in
[phase 1](../plan.md#phase-1-usable). A new site costs about two Claude calls, roughly
$0.015. A post-login page the extractor cannot describe completely is not sent, and that
attempt ends `unknown`; the next run tries again.

Real calls to the owner's Anthropic organization start only after deployment and the
owner's approval. Tests use a fake token endpoint and fake models.

## Alternatives

- Treat a vanished login form as success: no extra data sent, but sites that move to
  an error page would count as signed in.
- Never judge generated recipes: always `unknown`, so the chosen account is never saved.
- Use a generated recipe from the next visit, or only after the owner confirms it in the
  web UI.
- Keep the log 30 days, or until deleted.
