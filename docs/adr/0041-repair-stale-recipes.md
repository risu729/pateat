# ADR 0041: Repair a generated recipe by adding a layout

Status: accepted by the owner on 2026-10-23. The core is part of case B of the
recipe-schema proposal, accepted at 11:41 UTC with [ADR 0060](0060-recipe-layouts.md),
which left its repair items to this ADR: a repair adds a layout and never overwrites
one, a page is sent after one load, one repair per device a day, at most three layouts
with the least recently used one replaced, nothing written for a start page a layout
already has, a passkey button alone merged into its layout, a 503 page never counted,
and a page in another language counted. The #617 root decision of 2026-10-19 (1-1 A)
makes repair automatic, once a UTC day, within the $5 a day. The owner's answers on
2026-10-23: same-path advances count (12:51 UTC, option B, section 4), the claim of
section 5 is per missing route for 3 days (12:53 and 12:54 UTC), the stale steps are not
sent to the model (12:54 UTC, option A) and chooser and sign-in entry recipes are
repaired too (13:03 UTC, [section 6](#6-chooser-and-sign-in-entry-recipes)). The rest is
Claude's design, marked where it applies. Implemented on main through
[#911](https://github.com/risu729/pateat/pull/911) (2026-10-23), local tests only.
Replaces the overwriting repair first proposed in
[#617](https://github.com/risu729/pateat/pull/617). Amends
[ADR 0016](0016-recipe-generation-trigger.md) (generation runs only where no cached
recipe starts), [ADR 0018](0018-recipe-generation-route.md) (failed recipes are not
repaired) and [ADR 0058](0058-automatic-recipe-removal.md) part A (a recipe the chosen
item cannot run is revoked).

Amended on 2026-11-07 by [ADR 0086](0086-logins-in-frames-like-top-pages.md) (owner,
13:06 UTC; delivery 3): a generated recipe's start page, chooser form, chooser list and
later step are repaired in a frame of the tab's page too; an entry recipe's page still
only in the tab's page.

Date: 2026-10-23

## Context

Nothing regenerated a recipe whose elements no longer match its page: generation runs
only on a path where no cached recipe starts (ADR 0016), so a redesigned or translated
login page failed the same way on every visit until the owner revoked the recipe on
`/manage`. The [roadmap](../plan.md#phase-3-public-release) asks for repair early in
phase 3 and for the owner's two cases (2026-10-13 19:14 UTC): the same page in another
language, and a maintenance page on the login URL, which must not be taken for a changed
login page.

\#617 replaced the recipe's start page as a new revision. That drops what the recipe had
learned (second-factor handlers, signed-in markers, continuation pages), and a page that
switches language would be rewritten back and forth. With layouts (ADR 0060), a recipe
document holds up to three layouts of the same start page, so a repair can add one
instead.

## Decision

### 1. When a start page is sent for repair

The content script's `shown` report, sent once per document and path when a sign-in
input shows for the step wait without a ready first step, now carries what the first
steps watched on the path missed (`miss`): the targets that match no element or several,
and the document's load status (`PerformanceNavigationTiming.responseStatus`). It is
also sent for a page whose only text input is an identifier, where a first step is
watched on that path. The worker (`classifyStartMiss` in
`apps/extension/src/login/repair.ts`) sends the page on **the first load that misses**,
unless:

- the load answered outside 2xx (`status`), as a maintenance page usually does (503);
- a first step's targets were all found shown and are only not usable yet (`unusable`),
  as on a slow page; an element still not rendered after the step wait counts as
  missing, as a form the page swapped for another and kept hidden (x.com's start page
  swaps its first form for another about 2 seconds after it shows);
- the page also starts the recipe's login meanwhile (`running`);
- the page showed no detail (`no-detail`);
- the page is the tab's next page after a submitted password form (`after-sign-in`), or
  a signed-in marker of the recipe shows (`signed-in`);
- a list (section 6) shows every element of one of the recipe's handlers on its path
  (`handler`), as a second-factor page on the sign-in form's own URL that shows the
  account's email above its "Verify" button: a later page of the recipe's own login,
  which must not replace the recipe. A form beside such a button is still sent, since it
  only adds a layout (Claude's rule, 2026-11-04,
  [#1248](https://github.com/risu729/pateat/issues/1248));
- the recipe is not generated (`gen-` IDs), the page is a frame, or a later step of the
  recipe shows there (ADR 0049).

A start page that lists accounts by email instead (ADR 0028) is reported the same way,
and sent as a list (section 6).

A page in another language counts: it gets its own layout, which records its language.
Each document is sent once (`pateat.recipe-repairs.v1`, trusted storage).

### 2. The request and its limit

The page is sent as a first page with `repair: { recipeId, revision }`. The service:

- answers the current recipe without a model call when the named revision is not the
  current one, as after another device's repair; the device then tries that revision;
- answers `recipe-revoked` for a revoked recipe and `recipe-conflict` for one that is
  not a generated route recipe of the origin and start path;
- allows **one repair per recipe, device and UTC day** (`recipe_repairs`), checked and
  reserved with the existing spend limits ($5 a day, up to five calls at a time since
  [2026-10-23](0018-recipe-generation-route.md#five-calls-at-a-time), so two devices
  repairing the recipe at once are both charged), before the model is called; a second
  one answers `unavailable` `repair-limit`. The ADR 0016 retry window and the recipe
  room check do not apply.

The device holds the recipe until the next UTC day after any answer but a new revision,
`busy`, or a request left free to send again, so a page that keeps missing does not send
on every load; the current revision answered back, as when nothing was written, holds it
too. The day is reserved before the model is called, so a provider error or timeout
after that still spends it, as the ADR 0016 retry window does (Claude's choice).

### 3. What the answer writes

- A new layout beside the others, with the page's language. Nothing is removed.
- An answer whose start page equals an existing layout's, locators and their values
  included, writes nothing and returns the current recipe.
- An answer that only adds a passkey button to an existing layout's start page is merged
  into that layout. The model may name the start page's elements by other locators, so a
  layout whose start page does the same (step kinds, paths, slots and purposes) also
  takes the button when the page still shows every element that layout names, and keeps
  its own locators (Claude's rule).
- An answer whose page kind is not `sign-in` (ADR 0035), as a maintenance page answered
  200 that kept an input, writes nothing: no login would ever choose such a layout, and
  it would hold one of the three places (Claude's rule).
- With three layouts already, the least recently used one is replaced.
- An abstention writes nothing; the day is spent.

### 4. A later step that no longer shows

When a top-frame `password` login of a layout's own steps (no other variant, no entered
handler) settles as unknown after an `advance` whose next step never showed, on that
step's path, where the page shows a password input and no CAPTCHA (ADR 0029 S2 without
S4, so the judge was asked first and did not move the login on), the device sends that
page with `repair: { recipeId, revision, layout, step }`, under the same limits. The
service copies the layout cut before that step, without its signed-in markers, and
continues it with the page as a continuation (ADR 0018), as a new layout. An `advance`
on its next step's own path counts too, as a single-URL form that asks for the
identifier, then the password (owner, 2026-10-23 12:51 UTC, option B). The next login
chooses the newer layout (ADR 0060); the old one is removed after 90 days unused (ADR
0058 B).

### 5. A recipe the chosen item cannot run (ADR 0058 A)

Instead of revoking the recipe and generating it again, the device first pulls the
service's recipes: a newer revision, as after another device's repair added the route
the item needs, is tried without a model call (`recipe.unfit` outcome `newer`).
Otherwise it sends the same repair of the start page, after claiming it in
`pateat.recipe-replacements.v1`: once per recipe, device and missing route (`passkey`
or `password`) in 3 days, so at most two claims per recipe (owner, 2026-10-23 12:53 and
12:54 UTC, replacing ADR 0058 A's 30 days per recipe), and a claim whose request never
reached the model is given back. An answer that
adds the missing passkey button is merged into the layout (section 3), so accounts that
used the other route keep what it learned; the page announces again and starts it. Any
other answer refuses the page as before. The claim logs `recipe.unfit`. A passkey-only
recipe ([ADR 0053](0053-passkey-only-generation.md)) is claimed and sent only when one
immediate read (`login.entry.check`'s `signIn`) finds a sign-in or identifier input on
its page; otherwise the page is refused at once with no claim (`recipe.unfit` outcome
`not-due`, reason `no-form`; owner, 2026-10-25 00:16 UTC), including a form the page
renders only after its button. A page that shows a list of accounts beside the button
instead is claimed and sent as a list, whose chooser layout keeps the button as its
`passkey` (section 6, [ADR 0079](0079-passkey-button-beside-an-account-list.md)).

### 6. Chooser and sign-in entry recipes

Owner, 2026-10-23 13:03 UTC: account choosers
([ADR 0028](0028-account-chooser-login-pages.md)) and sign-in entries
([ADR 0031](0031-sign-in-entry-pages.md)) are repaired too, and the answer is written as
the kind the page is now, as the next revision of the same ID.

- **Chooser.** A login on the list that finds nothing to click while a button the
  chooser names (`other`, `continue`) matches no element sends the list, as a list,
  while the login ends as before (`account-not-listed`). The answer adds a chooser
  layout without branches, which the next login generates; a list whose buttons a layout
  already has writes nothing, and with three layouts the least recently used one is
  replaced. Amended by
  [ADR 0079](0079-passkey-button-beside-an-account-list.md) (owner, 2026-10-25): a list
  answer that names the passkey button beside a list a layout already has adds it to
  that layout as its `passkey`, or puts it in place of one on another button, and keeps
  the layout's branches.
- **Entry.** Only when the press found its link missing on a page whose URL names
  another path of the site (`namesReturnPath`, checked before the press), since a
  signed-in page drops the link too. The page goes as a form when it shows a sign-in
  input now, as a list when it lists accounts by email, and otherwise as an entry page,
  which answers the entry's next revision (`POST /v1/recipes/generate` with `repair` and
  no slots), or nothing when the model names the same link. A load answered outside 2xx
  is not sent.
- **Kind changes.** Amended on 2026-11-04 (owner, 11:30 UTC, after
  [#1248](https://github.com/risu729/pateat/issues/1248)): the same URL shows a sign-in
  form or a list of accounts by the state of the browser's session, so a recipe holds
  layouts of both kinds on its start path (ADR 0028, ADR 0060), and a repair adds the
  kind the page showed beside the other instead of replacing it. A list answer adds a
  chooser layout to a login recipe, which keeps its layouts with what they learned; a
  form answer adds a layout to a chooser's recipe, which keeps its list. Only an entry
  recipe is still replaced by the kind its page shows. A passkey-only layout whose
  button the list answer names again is copied into the new chooser layout's `passkey`,
  with its handlers and markers (ADR 0079), and stays as a layout of its own. Each kind
  keeps at most three layouts, and an unused layout goes after 90 days whatever its kind
  (ADR 0058 B); a kind whose last layout goes leaves the other alone. A login recipe's
  start page that became a list is reported as in section 1. On every chooser path, the
  page's `shown` report carries what the list's buttons missed as its `miss`. A chooser
  whose path shows a form instead of its list is its `other` branch's page (ADR 0028)
  and is not repaired, when a layout of the chooser has a button for another account.
  Without such a button, the form is sent as a form, which adds a login layout to the
  recipe, unless its list shows by then (`list-shown`), the first step of the branch for
  the shown account shows there (`branch`, as after the person pressed "Continue"
  themselves), the page said nothing of its miss (`no-detail`), the load answered
  outside 2xx (`status`) or it is the tab's next page after a submitted password form
  (`after-sign-in`); as for a start page, only a generated chooser's top-frame page with
  no login of it running is sent, and a failed lookup of the chooser's layouts sends
  nothing (Claude's rule, 2026-11-04, #1248: a second-factor page that showed only the
  account's email above "Verify" was stored as such a chooser, replacing the login
  recipe that had signed in, and the sign-in form on the same path then never started a
  login). Before 2026-11-04 a kind change replaced the recipe, which lost every layout
  of the other kind each time the page changed kind.

The same limits apply: one repair per recipe, device and UTC day, and the device's hold.

### 7. Logs

`recipe.repair` logs a page sent (`due`, info) or not (`skipped`, debug) with why. The
request itself is `recipe.generate` with page `repair`.

## Consequences

- A redesigned or translated login page is repaired on its first visit for one model
  call (about $0.007), at most once a day per recipe and device, within the $5 a day.
- A maintenance page answered with an error status never spends a call. One answered 200
  that shows a sign-in input is sent; the model usually abstains, which spends the day.
- More requests reach the service and Anthropic than with #617 (up to one per recipe and
  device a day); they carry the same redacted page description as a first page.
- A signed-in page on the start path that shows a password or a sole identifier input is
  caught only by a learned signed-in marker or the after-sign-in rule.
- Not verified on a real site or in the owner's Chrome.

## Alternatives

- **Replace the start page (#617).** Loses learned handlers and markers, and a page that
  switches language is rewritten back and forth.
- **Two loads before a repair (#617).** Needed only because a wrong repair overwrote a
  working recipe; adding a layout breaks nothing, so one load is enough.
- **For a kind change, put back the recipe's previous revision of the other kind without
  a model call** (2026-11-04, #1248). Keeps what that revision learned, but the recipe
  still holds one kind at a time, so a page that shows either by the session's state
  goes back and forth, and it makes the first replacement pointless (owner, 11:29 UTC).
  Not chosen: both kinds are held instead.
- **Two pages of the other kind on different days before a kind change** (2026-11-04).
  Fewer wrong replacements, but a recipe still holds one kind at a time. Not chosen.
- **Skip a page in the other language (#617).** It would never get a working layout.
- **Detect maintenance pages by their text.** Language- and site-specific
  ([ADR 0033](0033-no-site-specific-features.md)).
- **Send the stale steps to the model as a repair prompt** (`repair` in
  `packages/inference`). The page is generated as a first page or continuation instead,
  with the prompts already tested; the stale steps would only bias the answer.
