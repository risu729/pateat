# ADR 0018: Service recipe generation route

Status: accepted by the owner on 2026-10-11. Amends
[ADR 0016](0016-recipe-generation-trigger.md) (which pages are observed) and settles
the retention left open by [ADR 0012](0012-inference-request-log.md). The service
routes are implemented ([API README](../../services/api/README.md#recipe-generation)).
The extension sends a recipe's first page and a page that an effect step leads to and
no check explains; continuing a recipe on the page after an `advance` step is not
implemented yet.
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

## Consequences

The service and Anthropic see, once per new recipe, the page shown right after the
first sign-in. That page can carry the owner's name or balances in its title and
headings, within the extractor's label redaction (`[email]`, `[masked]`, and
`[number]` for every run of digits on that page, as the owner chose on 2026-10-12).
A new site costs about two Claude calls, roughly $0.015. A post-login page the extractor
cannot describe completely is not sent, and that attempt ends `unknown`; the next run
tries again.

Real calls to the owner's Anthropic organization start only after deployment and the
owner's approval. Tests use a fake token endpoint and fake models.

## Alternatives

- Treat a vanished login form as success: no extra data sent, but sites that move to
  an error page would count as signed in.
- Never judge generated recipes: always `unknown`, so the chosen account is never saved.
- Use a generated recipe from the next visit, or only after the owner confirms it in the
  web UI.
- Keep the log 30 days, or until deleted.
