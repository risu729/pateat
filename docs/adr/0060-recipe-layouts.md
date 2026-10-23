# ADR 0060: A recipe holds up to three layouts of its sign-in pages

Status: proposed by Claude on 2026-10-23 and accepted by the owner on 2026-10-23 at
11:41 UTC, who approved recipe layouts as proposed (the recommended option, case B, of
the recipe-schema proposal), including keeping the layouts in the recipe document and
discarding existing recipes. Chooser layouts are part of the decision. The owner's
wording is not quoted here; the notes under [Later](#later) record two further wishes,
not decided by this ADR. Implemented on `claude/review-issue-prs-j7hli2` (local tests
only, not tried on real sites, not deployed); see [Delivery](#delivery). Amends
[ADR 0016](0016-recipe-generation-trigger.md) (what a continuation and a judgement
name), [ADR 0028](0028-account-chooser-login-pages.md) (the chooser's shape and branch
names), [ADR 0049](0049-start-at-a-later-step.md) (which recipe a later step starts) and
[ADR 0058](0058-automatic-recipe-removal.md) (part B counts use per layout).

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
  0035. (Added when ADR 0035's first delivery was merged in; not confirmed by the
  owner.)
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
  the origin, and reports the page's language with a ready start.
- A new login on a start page chooses the layout in this order: the layouts that show
  the most of the start path's elements their first step and passkey button name; among
  them the first whose plan passes for the account (route, slots and binding);
  preferring a layout of the page's language; then the newest. When no plan passes, the
  first refusal stands as before. The last-used layout is never a criterion, so a newer
  layout made after a redesign is not passed over for an old one.
- The attempt records the layout's key, and a resumed login loads the same layout.
  A newer revision whose projection of that layout is unchanged, or only adds handlers
  or markers, is taken over as before, so adding or removing another layout does not
  stop a running login.
- A login that starts at a later step ([ADR 0049](0049-start-at-a-later-step.md))
  chooses among the layouts of the recipe that owns the step in the same order.
- A new chooser login chooses the layout whose list buttons (`other`, `continue`) show
  most, then one of the page's language, then the newest. The account's plan does not
  take part, since which account the list holds is decided only once the layout is. The
  login records the layout and reports it in its branch.

### Generation and judgement

- The first page of a recipe writes a document with one layout. A first list of
  accounts writes a chooser with one layout.
- A continuation (`base` with `branch`) appends to the named layout, or to that
  chooser layout's branch, and writes the document at its next revision. A request
  without `branch`, for a layout the document no longer has, or naming a chooser branch
  on a login recipe answers `recipe-conflict` without a model call.
- The request log keeps the layout of each generation and judge row in `layout`: the
  one `branch` names, or for a recipe's first page sent to the model the key of the
  layout its answer creates, chosen before the call (not confirmed by the owner).
- A judgement learns its handler or marker into the named layout. Generation attempts
  and judged pages are keyed by layout, so two layouts of one revision and path do not
  share the once-per-page rule.
- `buildLoginLayout` in `services/api/src/recipes/generate.ts` builds a layout from the
  model's answer without writing it; the write is separate. Until repair lands, new
  generation writes the recipe's first layout only, and `withLoginLayout` refuses a
  fourth layout.

### Existing recipes

Existing recipes are discarded, not converted. The rule of
[Compatibility before release](../development.md#compatibility-before-release) forbids
a migration whose only purpose is older data, and wrapping each recipe as
`layouts: [body]` would be one. Migration 0028 deletes every recipe revision and head,
with the judged pages, generation attempts and first-login results that named a branch
the old way. The request log and login records stay. The device's recipe cache moves to
version 2, so a version 1 cache is ignored and the device syncs from the start.

### Use and removal (amends ADR 0058 B)

- The service keeps each layout's last use in `recipe_layout_uses`. A layout is used
  when a login starts on it (the use report), when a login on it ends (its login
  record), and when the service writes a continuation, handler or marker into it. A
  write that changes one layout is not a use of the others, and a service write that
  only removes layouts is no use of the recipe.
- A layout's last use is the newer of its creation and its last reported use. A layout
  unused for 90 days is removed by the same check that revokes idle recipes, as a new
  revision without it, while another layout of the recipe is still in use. When every
  layout is idle, the recipe is revoked as before.
- A write removes the use rows of layouts the document no longer has.

### Management page

`/manage` keeps one entry per recipe. Its details list each layout with its language,
creation time, last use and steps, and offer to remove one layout
(`POST /recipes/:recipeId/layouts/:layout/revoke`, a new revision without it) or the
whole recipe. Removing the last layout revokes the recipe.

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

Recorded on 2026-10-23 from the owner; neither is designed or decided here:

- The owner wants layouts from trusted users to be mergeable into a canonical recipe
  kept by the server later, once several users share recipes.
- Generation provenance (which generation made each layout) is being added in the same
  PR as this ADR's implementation; its details are recorded with that change.

## Consequences

- Each site generates its recipe again on its next visit (about $0.02 with the first
  judgement), and learns its handlers, markers and continuation pages again. A site with
  TOTP stops at `challenge` on its first login until its handler is learned. Bindings
  stay, since the recipe ID is the same.
- A device of an older build keeps its cached recipes and cannot read the new shape;
  the recipe sequence of each owner restarts at 1 after the deletion, so only a device
  whose cache was reset, as this build's is, sees every change.
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
  `login-attempt.ts` (`layout` on the attempt).
- Extension: the recipe cache (`apps/extension/src/service/recipes.ts`, version 2),
  the login runtime (`apps/extension/src/login/runtime.ts`), the page's language
  (`observation/extract.ts`, `login/content.ts`), and the service senders that now name
  the layout.
- Service: `services/api/src/recipes/generate.ts`, `recipe-store.ts` (`markLayoutUsed`,
  `removeUnusedLayouts`), `routes/recipes.ts`, `routes/manage-api.ts`, `db/schema.ts`,
  migration `0028_recipe_layouts.sql`, and the management page
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
