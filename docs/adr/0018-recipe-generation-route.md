# ADR 0018: Service recipe generation route

Status: accepted by the owner on 2026-10-11. Amends
[ADR 0016](0016-recipe-generation-trigger.md) (which pages are observed) and settles
the retention left open by [ADR 0012](0012-inference-request-log.md). The service
routes are implemented ([API README](../../services/api/README.md#recipe-generation)).
The extension sends a recipe's first page and the page after its final submission;
continuing a recipe on the page after an `advance` step is not implemented yet.

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
  checks the plan with `validatePagePlan` and saves the steps as one recipe per origin.
  It answers synchronously with the saved recipe, an abstention reason, a failure code
  or an unavailable reason (no credentials, a limit reached, busy, or tried in the
  previous 24 hours).
- A login that spans pages is generated one page at a time. When an `advance` step
  leads to a page the recipe has no steps for, that page is sent and its steps are
  appended to the same recipe in a new revision.
- The extension writes the slot-to-field bindings itself and uploads them with settings
  sync; the service never sees item IDs.
- Limits per owner: $150 a month (the ADR 0014 default, estimated from returned usage
  and a versioned price table), 50 generation calls a day, one call at a time, and the
  ADR 0016 24-hour rule per origin and path, enforced again on the service.

Failed recipes are not repaired by this route; repair is a later design.

Implementation choices that follow from these decisions, made on 2026-10-11 without a
new owner decision:

- The daily limit counts judgement calls as well as generation calls, so repeated
  post-login pages for one revision are bounded too.
- A page that continues a recipe after an `advance` step counts toward the 24-hour rule
  under that recipe revision, not under its path alone, so the password form of a login
  that stays on `/login` is not refused as a retry of the email form.
- Revoking a generated recipe stops generation for its origin, because each origin has
  one generated recipe ID; a later design can let the owner reset it.
- Log rows older than 90 days are deleted whenever a call is logged and whenever a
  device reads the recipe change feed, since routine releases do not apply scheduled
  triggers. Requests refused locally before any model call are not logged.
- The extension sends the page after the final submission once the usual three-second
  observation finds no other result. A page that still shows one of the recipe's fields
  on one of its paths is not sent, since the sign-in has not finished there. Each
  attempt sends at most one such page.
- That page is described by `extractSignedInObservation`: every field on the page, which
  the judge needs to refuse a page that still shows a sign-in field, then buttons and
  links as possible markers up to the 48-candidate limit.

## Consequences

The service and Anthropic see, once per new recipe, the page shown right after the
first sign-in. That page can carry the owner's name or balances in its title and
headings, within the extractor's label redaction (`[email]`, `[masked]`, `[number]`).
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
