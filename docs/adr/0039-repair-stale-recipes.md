# ADR 0039: Repair a generated recipe whose start page no longer matches

Status: Proposed — Claude's design, pending the owner's approval; delivery 1 is
implemented behind no switch, so that the owner can try it before deciding. The owner
asked on 2026-10-15 for designs that are hard to settle to be implemented first and then
asked as "should it be this way?" on the pull request; the questions there name each
choice below. Amends [ADR 0016](0016-recipe-generation-trigger.md) (generation runs only
where no cached recipe starts) and [ADR 0018](0018-recipe-generation-route.md) (failed
recipes are not repaired).

Date: 2026-10-15

## Context

Until now nothing regenerated a recipe whose elements no longer match its page:
generation runs only on a path where no cached recipe starts (ADR 0016), and ADR 0018
left repair to a later design, so a stale recipe failed the same way on every visit
until it was revoked on `/manage`. The [roadmap](../plan.md#phase-3-public-release) puts
repair early in phase 3 (owner, 2026-10-13 19:10 UTC) and asks the design to say when a
miss counts as a stale recipe rather than a slow or different page, what the repair
request may spend, and what happens to the stale revision. The owner named two cases it
must cover (2026-10-13 19:14 UTC):

- **The same page in another language.** A text or label locator no longer matches,
  but the recipe is still right; the page is only shown in the other language.
- **A maintenance page on the same URL**, without a redirect. It must not be taken as a
  changed login page.

A recipe can miss its page in three places today, checked against the code on
2026-10-15:

| Where                                   | What happens now                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The recipe's start page                 | The page shows a sign-in input for the 10-second step wait without a ready first step. The content script reports it once per document and path (`shown`); the background logs `login.refused` `not-started` with `first-step-missing`. No login starts, so no attempt, failure or retry exists.  |
| A later step (`elements-timeout`)       | The attempt's next step does not show within the step wait; it fails `structural-mismatch` and is retried from the same step until the retry budget ends it `retry-limit`. Its start page matched, and the earlier steps already typed and clicked.                                               |
| After a submission (`unknown-submit`)   | The page after the submission shows no next step: the [ADR 0029](0029-local-sign-in-state.md) check and the judge decide; a sign-in field of the route still showing settles `unknown-submit`. This is also what a wrong password, a second factor or a site error looks like.                    |

## Decision

### 1. Only a generated recipe's start page is repaired (delivery 1)

A repair is asked for only from a recipe's **start page**: the first step's own path, in
the top frame, on a recipe generated on the service (`gen-` IDs; a recipe written by the
owner is never rewritten). Account chooser recipes
([ADR 0028](0028-account-chooser-login-pages.md)) and sign-in entry recipes
([ADR 0031](0031-sign-in-entry-pages.md)) are not repaired in delivery 1. A start page
is the only place where nothing has been typed or clicked yet, so asking the model again
there cannot resubmit anything.

- **`elements-timeout` (delivery 2, proposed, not implemented).** A later step's miss
  would repair that page as a continuation
  ([ADR 0018](0018-recipe-generation-route.md)'s `base`), once the same step missed on
  two attempts. It needs the attempt's earlier steps to have run, so it is a separate
  change.
- **`unknown-submit` is never a repair.** It cannot be told apart from a rejected
  password, a second factor or a site error without the judge, and the judge's verdicts
  already settle it.

### 2. When a start page's miss counts as stale

The content script's `shown` report now says what the first steps watched on the path
missed: their targets that match no element or several (`missing`), the page's
language as the page description reads it (`ja`, `en` or `mixed`), and the HTTP status
of the document's load (the navigation entry's `responseStatus`). The background
classifies it (`classifyStartMiss` in `apps/extension/src/login/repair.ts`):

1. **No detail** (an older report): not counted.
2. **Status**: the document's load was answered with a status outside 2xx. A
   maintenance page served on the login page's URL usually answers 503, so it is not
   counted, whatever inputs it shows. A maintenance page answered 200 still counts as a
   miss; the two-load rule below holds it.
3. **Unusable**: none of the first step's own targets is missing; they were found but
   could not be used within the wait, as on a slow page. Not counted.
4. **Language**: every missing target is a `text` or `label` locator, the recipe was
   written in one language, and the page now reads in the other one (`ja` against `en`).
   The recipe is still right, so it is not counted. The recipe's language is the one it
   records, or for a recipe generated on a page of `mixed` language, which records none,
   Japanese when every missing locator's words hold Japanese script; Latin letters say
   nothing, since Japanese pages also name fields "ID" or "Email". A page of `mixed`
   language counts. An `id`, `name` or other attribute locator that misses counts in any
   language.
5. **Signed in**: a page where one of the recipe's learned completion markers is
   visible, or the tab's next page after a submitted password form, is not counted: it
   is a signed-in page on the start path, such as a profile form with an email input,
   and is never sent.
6. **Stale**: otherwise.

A stale miss is counted per recipe on this device (`pateat.recipe-repairs.v1`, trusted
contexts only). Only **two separate page loads in a row** of the same recipe revision
and start path make it due; the same document reporting again is not another load, and
a login that starts on the recipe, another revision or another start path starts the
count over, as does a sent repair. A maintenance page answered 200 or a page that failed
once while loading therefore needs to show on two loads with no login started between
them.

### 3. The repair request and its budget

A due repair sends the start page, as a first page is sent (the same page description,
redaction and vault scope, [ADR 0016](0016-recipe-generation-trigger.md)), with
`repair: { recipeId, revision }`. The service:

- answers `recipe` with the current recipe and no model call when its revision is not
  the one named (a newer one, as after another device's judge), `recipe-revoked` for a
  revoked recipe, and `recipe-conflict` for a recipe that is not a generated route
  recipe of the origin;
- allows **one repair per recipe per UTC day** (`recipe_repairs`), checked and reserved
  under the owner's lock with the existing spend limits ($5 a day, one call at a time,
  [ADR 0018](0018-recipe-generation-route.md)); a second repair the same day answers
  `unavailable` `repair-limit`. The ADR 0016 retry window of the origin and path does
  not apply, and the origin's recipe room is not needed, since the recipe already
  exists;
- takes the day as soon as the request passes the limits, before the model is called,
  so an abstention or a request the model role refuses (`input-too-large`) spends it.

The extension claims a repair under the revision it repairs, apart from the claim of the
page's first generation, so the ADR 0016 retry window does not hold it locally either.
Any answer of the service but `busy` (another request in flight) or a failure marked for
retry holds the recipe until the next UTC day, including a current recipe returned for a
newer revision and the spend limit, so that a page that keeps missing does not send a
request on every load. A request the model role refused before the call is not held
locally, but the service already took the day, so the next one is answered
`repair-limit` without a model call and holds it.

### 4. What happens to the stale revision

The repaired start page **replaces** the recipe's steps as a new revision of the same
recipe ID; the stale revision stays in the recipe's history, which keeps the last ten
revisions (a revocation drops the older ones, as for any recipe). Its learned completion
and continuation are not carried over: the judge learns them again on the next login
(about $0.015). A repair answer whose start page is the same as the stale one keeps the
current revision unchanged, as does an abstention; both are logged.

The recipe now records the `language` of the page it was generated on (`ja` or `en`;
none for `mixed`), for rule 4 above.

### 5. Logs

`recipe.repair` (info) logs a counted miss (`noted`), a sent repair (`due`) and a miss
not counted (`skipped`, debug) with its reason: `status`, `unusable`, `language`,
`signed-in`, `after-sign-in`, `no-detail`, `held` (tried today), `repeat`, `unavailable`
or why the page could not be sent. The request itself is `recipe.generate` with page
`repair`.

## Consequences

- A generated recipe whose start page was redesigned is repaired on the second load
  that misses, for at most one model call per recipe a day, within the existing $5 a
  day.
- The two owner cases do not spend a model call: a maintenance page answered with an
  error status is never counted, and a page shown in the other language of the recipe is
  not counted while only its worded locators miss.
- The `shown` report is now also sent for a page whose only text input is an
  identifier (`sole`), where a recipe's first step is watched on that path, so an
  identifier-first start page can be repaired. It adds `login.refused` `not-started`
  lines for such pages.
- Known gaps: languages other than Japanese and English are read as one of the two or
  `mixed` by the page description, so two Latin-script languages (English and French)
  are not told apart and a French page of an English recipe counts as stale; a
  maintenance page answered 200 that shows a sign-in input on two loads is repaired,
  and the model then usually abstains, which spends the day; a signed-in page on the
  start path is caught only by a completion marker the recipe learned, so before the
  judge learns one, a signed-in page that shows a password or a sole identifier input
  on two loads in a new tab is sent; chooser and entry recipes are not repaired.
- Not verified on a real site or in the owner's Chrome; the synthetic browser test
  covers a changed page and a 503 maintenance page.

## Alternatives

- **One load.** Repair on the first miss: a page that failed to load once would spend
  a model call. Two loads cost one more failed visit for a real redesign.
- **Merge the repair into the stale revision** (keep its completion and continuation):
  keeps what the judge learned, but a redesigned start page often changes the pages
  after it, and a merged recipe could keep steps that no longer exist.
- **Repair by attempt failures** (`elements-timeout`, `retry-limit`): only covers later
  steps; the start page never starts an attempt. Planned as delivery 2.
- **Treat the language case by locator kind alone** (never count `text` or `label`
  misses): a reworded button in the same language would never be repaired.
- **Detect maintenance pages by their text** ("maintenance", "メンテナンス"): language-
  and site-specific ([ADR 0033](0033-no-site-specific-features.md)); the status code is
  the general signal, and the two-load rule covers the rest.
- **A separate repair budget** apart from the daily spend: the coordinator's default
  counts repairs in the existing limits, so a repair can never raise what a day may
  spend.
