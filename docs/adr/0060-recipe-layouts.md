# ADR 0060: A recipe holds up to three layouts of its sign-in pages

Status: proposed by Claude on 2026-10-23 and accepted by the owner on 2026-10-23 at
11:41 UTC, who approved recipe layouts as proposed (the recommended option, case B, of
the recipe-schema proposal), including keeping the layouts in the recipe document and
discarding existing recipes. Chooser layouts are part of the decision. The owner's
wording is not quoted here; the note under [Later](#later) records a further wish, not
decided by this ADR. In the same message the owner asked for what
[Generation provenance](#generation-provenance) and
[Changing the recipe schema later](#changing-the-recipe-schema-later) record, and to
proceed without asking unless something needed explaining. Implemented on main through
[#909](https://github.com/risu729/pateat/pull/909) and
[#968](https://github.com/risu729/pateat/pull/968) (local tests only, not tried on real
sites, not deployed); see [Delivery](#delivery). Amends
[ADR 0016](0016-recipe-generation-trigger.md) (what a continuation and a judgement
name), [ADR 0028](0028-account-chooser-login-pages.md) (the chooser's shape and branch
names), [ADR 0029](0029-local-sign-in-state.md) (E1 reads every layout's markers),
[ADR 0035](0035-page-kinds-per-site.md) (the page kind is kept per layout),
[ADR 0049](0049-start-at-a-later-step.md) (which recipe a later step starts),
[ADR 0055](0055-login-records-sent-to-the-service.md) (`branch` names the layout),
[ADR 0058](0058-automatic-recipe-removal.md) (part B counts use per layout) and
[ADR 0061](0061-personal-details-during-a-login.md) (a `detail` handler is kept per
layout).

Date: 2026-10-23

## Context

A generated recipe was one set of steps per recipe ID, and the ID is derived from the
origin and the start path. Its locators may name a control by its text (`次へ`, `Next`),
so a site that shows the same sign-in pages in another language, or a redesigned page
under the same path, no longer matches the recipe. The only way out was to revoke the
recipe and generate it again, which loses what the recipe learned: handlers, signed-in
markers and continuation pages. A chooser's `other` and `continue` buttons
([ADR 0028](0028-account-chooser-login-pages.md)) are text locators too, so a list of
accounts in another language fails the same way.

## Decision

### Shape

- A stored login recipe is a document: `version`, `id`, `revision`, `origin` and
  `layouts`, one to three (`MAX_RECIPE_LAYOUTS`). Each layout is the former recipe body
  (`slots`, `steps`, the route members, `handlers`, `completion`, `maxSubmissions`) plus
  a `key`, its `createdAt` in milliseconds, and the `language` of the page it was
  generated from, left out when the page was `mixed`.
- Each layout keeps the kind of its start page (`pageKind`,
  [ADR 0035](0035-page-kinds-per-site.md)), which ADR 0035 put on the recipe: only a
  `sign-in` layout is chosen for a login or counts as a logout, and a layout generated
  as `confirm` or `unclear` never reports use, so it is never removed as idle and its
  recipe is never revoked as idle. A chooser branch's route is `sign-in`, as in ADR
  0035. The per-layout `pageKind` is part of the layout shape the owner accepted at
  11:41 UTC.
- Every layout of a recipe has the same `pageKind`, since they share one start page: the
  document schema refuses a mix, and `withLoginLayout` writes a layout of another kind
  as the recipe's only layout, replacing the others, as the page is now of that kind. So
  a recipe runs, or is kept as a `confirm` or `unclear` page, as a whole. (Added on
  2026-10-23 after review; not confirmed by the owner.)
- The slots of all layouts together are at most 20, as one binding per recipe holds
  them, and a document is at most 120 KiB as JSON (`MAX_RECIPE_DOCUMENT_BYTES`), so a
  device can write back any document within the service's 128 KiB body limit. (Added on
  2026-10-23 after review; not confirmed by the owner.)
- The key never changes and is the decimal creation time, made unique within the
  document. Every record refers to a layout by its key, never by its place in the array,
  which removals shift.
- All layouts share the recipe's start path. The checks that held for one recipe hold
  for each layout; layout keys are unique.
- A chooser keeps its `path` and holds layouts too: each with a key, `createdAt`,
  `language`, and its own `other`, `continue`, `afterAccount` and `afterOther`. An entry
  recipe ([ADR 0031](0031-sign-in-entry-pages.md)) keeps its single shape.
- The recipe ID and the owner's bindings do not change. Bindings are kept by recipe ID,
  so they apply to every layout; a custom field named differently in another layout
  takes the bound name through the existing carried-name rule.
- `branch` in requests and in the service's records names the layout: `<key>` for a
  login recipe and `<key>:account` or `<key>:other` for a chooser's branch
  (`recipeBranchSchema`). It is now required on continuations, judgements, page samples,
  first-login results and login records, and a use report names the layout. The five
  tables with a `branch` column keep it and store the layout there, so only one table is
  new.

### Running one layout

- The device runs a projection: one layout as an ordinary recipe of the former shape
  with `layout` set to its key, so the executor and the step code read one route as
  before. The projection holds only that layout's signed-in markers, so a layout without
  markers still learns its continuation pages (`continuable`) and the four-marker limit
  holds. The checks that ask whether the tab is already signed in (the sign-in state of
  [ADR 0029](0029-local-sign-in-state.md) and the later-step marker check of
  [ADR 0049](0049-start-at-a-later-step.md)) read every layout's markers.
- The content script watches every layout's first step, as it watched every recipe of
  the origin.
- A new login on a start page chooses the layout in this order. It keeps the layouts
  that fit the page best, read in one observation of the elements of every route's and
  variant's steps on the start path: first those one of whose first steps shows whole,
  then those with the fewest of those elements missing, then those with the most shown.
  Among them it takes the first whose plan passes for the account (route, slots and
  binding), preferring a layout of the page's language, then the newest. When no plan
  passes, the first refusal stands as before. The last-used layout is never a criterion,
  so a newer layout made after a redesign is not passed over for an old one. (The order
  of the first three was changed on 2026-10-23 after review from the most elements shown
  alone, which let a larger layout missing its own submit button win.)
- The page's language is read the way the layout's was at generation, from the page's
  description (`language` of its observation), and only when the best layouts differ in
  language.
- The attempt records the layout's key, and a resumed login loads the same layout.
  A newer revision whose projection of that layout is unchanged, or only adds handlers
  or markers, is taken over as before, so adding or removing another layout does not
  stop a running login.
- A login that starts at a later step ([ADR 0049](0049-start-at-a-later-step.md))
  chooses among the layouts of the recipe that owns the step by how many of their later
  steps show, then the plan, the page's language and age as above.
- Where layouts part after the start page, a running login switches at the step where
  they part (added on 2026-10-23 so that a wrong repair of a later step cannot break the
  accounts that still see the original pages; proposed after the owner asked whether
  repair could follow such a change, not confirmed by the owner). A sibling of the
  running layout is another `sign-in` layout of the recipe, of the same or a newer
  revision, whose plan steps before that step equal the login's and whose step there
  differs, or exists where the login's own steps ended with an advance. When the login's
  own step does not show and a sibling's does, the login runs that sibling from there on
  (attempt event `LAYOUT`): after an effect step that may have advanced (never after a
  submission that ended the login's own steps), the step after it, confirmed as the
  login's own next step would be (on its path, or on the advance's own path only by
  elements that were not usable just before the advance, which the document measures for
  each sibling as it does for the login's own next step,
  [ADR 0013](0013-service-held-recipes-and-settings.md)); with nothing in flight, as
  when a step's own wait ran out or a new document resumes the login, the step at hand
  once it is ready, and only if it needs an element of the page. The account's plan on
  the sibling's route must pass, as a running login's does, and the newest sibling that
  fits wins. The attempt then records the sibling's key and step count, and its
  submission budget plus what the login held beyond its own recipe's (as after a passkey
  answer fell back to the password); a resumed login loads it, and its login record
  names it. Only a `password` login on its recipe's own steps (variant 0) switches, with
  no handler entered, no stop ([ADR 0036](0036-passkey-after-the-identifier.md)), no
  chooser and not only filling. When no sibling's step shows, the login goes on as
  before: its page is continued, judged or settled as unknown. The log names both
  layouts (`login.attempt` with `layout` and `layoutFrom`).
- A new chooser login ranks the layouts by their list buttons (`other`, `continue`) as
  a start page's elements, all of them being its first step, then by the page's
  language, then the newest. The account's plan does not take part, since which account
  the list holds is decided only once the layout is. The login records the layout and
  reports it in its branch.

### Generation and judgement

- The first page of a recipe writes a document with one layout. A first list of
  accounts writes a chooser with one layout.
- A continuation (`base` with `branch`) appends to the named layout, or to that
  chooser layout's branch, and writes the document at its next revision. A `base`
  without `branch`, or a `branch` without `base`, fails the request's schema (400
  `bad_request`); a layout the document no longer has, a chooser branch on a login
  recipe or a login layout on a chooser answers `recipe-conflict` without a model call.
- A continuation whose write loses to a write of another layout, or of the chooser
  layout's other branch, such as a judgement or a removal there, is written once more
  onto that newer revision while its own layout or branch is unchanged, so the paid
  answer is kept.
- The request log keeps the layout of each generation and judge row in `layout`: the
  one `branch` names, or for a recipe's first page sent to the model the key of the
  layout its answer creates, chosen before the call (not confirmed by the owner).
- A judgement learns its handler or marker into the named layout. Generation attempts
  and judged pages are keyed by layout, so two layouts of one revision and path do not
  share the once-per-page rule.
- `buildLoginLayout` in `services/api/src/recipes/generate.ts` builds a layout from the
  model's answer without writing it; the write is separate. Until repair lands, new
  generation writes the recipe's first layout only, and the document schema refuses a
  fourth layout that `withLoginLayout` adds.

### Existing recipes

Existing recipes are discarded, not converted. The rule of
[Compatibility before release](../development.md#compatibility-before-release) forbids
a migration whose only purpose is older data, and wrapping each recipe as
`layouts: [body]` would be one. Migration 0029 deletes every recipe revision and head,
and every judged page, generation attempt and first-login result, since their `branch`
named a route the old way. The request log and login records stay. The device's recipe
cache moves to version 2, so a version 1 cache is ignored and the device syncs from the
start.

### Use and removal (amends ADR 0058 B)

- The service keeps each layout's last use in `recipe_layout_uses`. A layout is used
  when a login starts on it (the use report), when a login on it ends (its login
  record), and when the service writes a continuation, handler or marker into it. A
  write that changes one layout is not a use of the others, and a service write that
  only removes layouts is no use of the recipe.
- A layout's last use is the newer of its creation and its last reported use. A layout
  unused for 90 days is removed by the same check that revokes idle recipes, as a new
  revision without it, while the recipe itself was used in those 90 days (any write or
  login of it, at its head's `lastUsedAt`) and another layout stays. A use of that
  layout reported after the check read the uses keeps it. When every layout is idle,
  nothing is removed, and the recipe is revoked as before once it is idle itself.
- A write removes the use rows of layouts the document no longer has.

### Management page

`/manage` keeps one entry per recipe. Its details list each layout with its language,
creation time, last use, the model and time of its first page
([generation provenance](#generation-provenance)) and steps, and offer to remove one
layout (`POST /recipes/:recipeId/layouts/:layout/revoke`, a new revision without it) or
the whole recipe. Removing the last layout revokes the recipe.

### Generation provenance

The owner's request (2026-10-23 11:41 UTC): layouts must be mergeable later into a
canonical recipe the server keeps, once the user who made them is judged trustworthy
(see [Later](#later)), and the model and time of each generation are stored and taken
into account for that merge. The service therefore records which call made each part of
a recipe. The owner chose to keep the record in a service table, not the document, on
2026-10-23 at 21:15 UTC.

- The record is the service-only D1 table `recipe_unit_sources`, one row per unit of
  an active recipe. It is never synced and never part of the recipe document, and the
  owner's and device's identity stay out of the document.
- A unit is a part one call makes, named within its layout (the row's `layout`, null
  for an entry recipe) by a position that no write shifts, so a migration that renames
  members leaves the IDs valid:
  - `page:<n>`: a page of the layout's route whose steps start at index `n` of
    `steps`, which only grow at the end.
  - `handler:<i>` and `marker:<i>`: the route's handler or signed-in marker at index
    `i`. The judge only appends them (`addHandler`, `addCompletion`), and continuations
    and `withLoginLayout` keep them. One judgement may add several handlers: each gets
    its row, all naming the same request log row. The judge never writes `rejection`.
    A `detail` handler ([ADR 0061](0061-personal-details-during-a-login.md)) is one of
    them.
  - `list`: a chooser layout's list buttons (`other`, `continue`).
  - `account/<unit>` and `other/<unit>`: the units of a chooser layout's branch, such
    as `account/page:0`.
  - `entry`: an entry recipe ([ADR 0031](0031-sign-in-entry-pages.md)).
- Each row keeps `digest`, 32 hex digits of the SHA-256 of the unit's content as
  canonical JSON, so a merge can check that a unit is still what its call produced. A
  page holds its own steps; `page:0` also holds the variants, passkey route, page kind,
  rejection and the layout's language. The slots and submission count follow from the
  steps, and a later page may keep, add or drop the account switch, so these are no
  unit's content; a merge takes them from the route.
- A row also holds its `origin` (`generated` for a page, `judged` for a handler or
  marker, `device` for a unit a device's document changed or added), the model that
  answered (`provider`, `model`, `effort`, `speed`: the `served` model `callClaude`
  reports), the role's prompt version, the service build, the recipe `revision` whose
  write recorded it (to join `login_outcomes` and judgements after older revisions are
  pruned), the device the revision records as its writer, the request log row's ID (not
  a foreign key, since the log is kept one year), and `created_at`, the time of that
  winning write rather than of the call.
- The rows are written in the batch of the recipe write that adds the unit, only when
  that write wins; a continuation written again onto a newer revision records its page
  with that write, at the same first step, since it is written only while its route is
  unchanged. A device's `PUT` of an active document splits each route at the recorded
  pages, keeps the rows of units whose digest is unchanged, deletes the rows of units
  the document no longer has, and writes a `device` row for each unit it changed or
  added; a route with no recorded pages is one `page:0`.
- A write drops the rows of the layouts the document no longer has, such as the idle
  layouts the check removes or the layouts a layout of another page kind replaces, and a
  revocation (by a device, the owner or the idle check) every row of the recipe. The
  request log's Delete all keeps the rows but clears their `device_id` and `log_id`; the
  model, prompt version, build, revision, digest and time identify no person.
- `/manage` shows, for each layout, the model and time of its first page (its `list`
  for a chooser).

The record is not in the document because:

- Size: a source of about 145 bytes on each of a typical layout's five units adds about
  720 bytes, about 64% of a layout, to a document every device syncs whole and the
  service keeps ten revisions of.
- Trust: `PUT /v1/recipes/:recipeId` accepts any active document, so a source in the
  document is whatever a device wrote; the service can trust only its own table.
- Shared recipes are untrusted input
  ([ADR 0013](0013-service-held-recipes-and-settings.md)) and their kind is classified
  again by the receiver ([ADR 0035](0035-page-kinds-per-site.md)); a source carried in a
  shared document would be untrusted for the same reason. Provenance can be copied from
  table to table when the service itself merges layouts.

### Changing the recipe schema later

The owner asked in the same request that a later schema change backfill stored recipes
from the logs without opening login pages where possible, since the schema may change
again, and allowed opening them again where it is not. So:

- A change that needs no new model output, such as renaming or moving a member,
  rewrites the stored recipes in a migration, as migration 0013 did
  ([development](../development.md#compatibility-before-release)). Unit IDs are
  positions, so `recipe_unit_sources` keeps its rows; digests of changed units are
  recomputed by a Worker step, since D1 has no SHA-256.
- A change that needs new model output, as `pageKind` did, is rebuilt by a separate tool
  that sends the logged observations to the current roles again. It finds each unit's
  observation through `recipe_unit_sources.log_id`, so it reaches only units whose log
  row is still kept. That tool is not part of this change.
- A recipe with a unit that cannot be rebuilt (its log row expired after a year or was
  deleted by Delete all, or a device wrote it) is discarded by such a change and
  generated again on the site's next visit, as this ADR's own change discards every
  recipe ([Existing recipes](#existing-recipes)): recipes stored before the page kinds
  of [ADR 0035](0035-page-kinds-per-site.md) would need new model output in any case.

### Left for later

The following are part of case B but are not decided here and are not implemented:
reporting a start page none of whose layouts shows, sending such a page for repair after
one load, the repair request (`repair: { recipeId, revision, layout?, step? }`) and its
`recipe_repairs` table and per-device daily limit, adding or replacing a layout on
repair (no write when the new layout equals an existing one including every locator; a
passkey button alone is added to the existing layout; the least recently used of three
is replaced), repairing a later step, the change of
[ADR 0058](0058-automatic-recipe-removal.md) part A from revoking to repairing, and the
rewrite of ADR 0041. The repair work builds on this ADR.

### Later

Recorded on 2026-10-23 from the owner; not designed or decided here:

- The owner wants layouts from trusted users to be mergeable into a canonical recipe
  kept by the server later, once several users share recipes. The merge itself is not
  designed; [Generation provenance](#generation-provenance) records what it needs.

## Consequences

- Each site generates its recipe again on its next visit (about $0.02 with the first
  judgement), and learns its handlers, markers and continuation pages again. A site with
  TOTP stops at `challenge` on its first login until its handler is learned. Bindings
  stay, since the recipe ID is the same.
- A device of an older build keeps its cached recipes and cannot read the new shape;
  the recipe sequence of each owner restarts at 1 after the deletion, so only a device
  whose cache was reset, as this build's is, sees every change.
- Revisions restart at 1 too, while `inference_log` and `login_timings` keep the old
  rows' `(recipe_id, revision)` for their retention, so the dashboard may show an old
  and a new revision 1 of one recipe side by side, and a device's local entry block
  (`pateat.login-entry-blocks.v1`) kept for an old revision 1 also holds for the new
  revision 1. Both are accepted under the compatibility rule: nothing is released, and
  the dashboard rows age out.
- Up to three layouts fit in the 1.5 MiB recipe bytes an owner may hold: a typical
  layout is about 1.1 KiB. The limit of 1,000 active recipes counts documents.
- The login's scope (account, origin, tab, frame and document), the extension's
  permissions and the declarative recipe vocabulary are unchanged. The choice reads only
  the recipe, the page's elements and language, and the account's facts, never a site
  name ([ADR 0033](0033-no-site-specific-features.md)). A page can steer the choice only
  among the owner's own layouts for the same origin and start path.
- A page whose start path changes is still a new recipe, and its bindings are not
  carried over.
- When two layouts' plans pass, every account moves to the newer one; the older one's
  learned handlers stay but go unused until it is removed as idle.

## Delivery

- Contracts: `packages/contracts/src/login.ts` (layouts, projection, branch helpers),
  `recipes.ts` (`rankLayouts`, selection), `generation.ts`, `sync.ts`, `manage.ts`,
  `login-attempt.ts` (`layout` on the attempt, the `LAYOUT` event).
- Extension: the recipe cache (`apps/extension/src/service/recipes.ts`, version 2),
  the login runtime (`apps/extension/src/login/runtime.ts`), the page's language
  (`observation/extract.ts`, `login/content.ts`), and the service senders that now name
  the layout.
- Service: `services/api/src/recipes/generate.ts`, `recipe-store.ts` (`markLayoutUsed`,
  `removeUnusedLayouts`, the unit rows of `writeRecipe`), `recipe-units.ts` (unit IDs),
  `routes/recipes.ts`, `routes/manage-api.ts`, `db/schema.ts` (`recipe_unit_sources`),
  migration `0029_recipe_layouts.sql`, and the management page
  (`services/api/web/recipes.tsx`).

## Alternatives

- Separate recipe IDs per layout (`gen-<hash>-<n>`): the same behavior with a smaller
  change, but bindings must be copied between IDs and `/manage` must group them.
- Keep one layout and overwrite it on repair: smallest, but every repair loses what the
  recipe learned, and a site that switches languages repairs again and again.
- Wrap each existing recipe as its first layout: keeps learned handlers, but is the
  migration for older data that the compatibility rule forbids.
- Project every layout's markers into the running recipe: stops a layout without markers
  from learning its continuation pages and exceeds the four-marker limit.
