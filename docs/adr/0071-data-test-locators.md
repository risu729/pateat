# ADR 0071: Elements may be named by their `data-test` attribute

Status: accepted by the owner on 2026-10-23 at 11:32 UTC. Built ahead of the decision
as the owner asked that day ("ある程度決め打ちで進め、後から判断"), then shown this
proposal on a card; the owner picked the recommended option, 「採用してマージ」.

Date: 2026-10-23

Amended 2026-10-24: test attributes come before `id` and `name`
([amendment](#amendment-2026-10-24-test-attributes-first)), accepted by the owner.

## Context

A recipe step names its element with an allowlisted locator: an `id`, `name`,
`data-testid` or `autocomplete` attribute, a button's text, a field's visible name
([ADR 0037](0037-fields-by-visible-name.md)) or, for some buttons, an accessible name
([ADR 0048](0048-password-method-button.md)). A login form's control that none of them
names alone makes the page incomplete, and an incomplete page never reaches inference.

Duolingo's sign-in (`https://www.duolingo.com/log-in`, observed 2026-10-23 in Chrome for
Testing 156 with the extension's extractor, main `381116f`) opens over its landing page,
which keeps its own header button with the same text, under the overlay:

```html
<button class="_2V6ug ..." data-test="have-account"><span>ログイン</span></button>
<form>
  <input data-test="email-input" id="web-ui1" type="text">
  <input data-test="password-input" id="web-ui2" type="password">
  <button data-test="register-button" type="submit"><span>ログイン</span></button>
</form>
```

The submit has no `id`, `name` or `data-testid`, and its text is shown twice, so the
page was incomplete (`unlocated-button`). Every control of the page carries
`data-test`, a test attribute some sites use instead of `data-testid` (others use
`data-qa` or `data-cy`).

## Decision

1. **The locator.** A target may be `{ "by": "data-test", "value": "register-button" }`:
   the element whose `data-test` attribute equals the value, with the same value rule as
   `test-id` (`[A-Za-z0-9_.:-]`, 1 to 120 characters). It is counted, and found by the
   executor, like the other attribute locators, including the shown-copies rule of
   ADR 0037's 2026-10-22 amendment.
2. **When the extractor gives it.** After `id`, `name` and `data-testid`, before
   `autocomplete`, a field's visible name, a button's text and an `id` another load may
   change: an element with a stable `id` or `name` keeps it.
3. **Where.** Wherever a `test-id` locator is allowed: route steps, handlers, signed-in
   markers, a sign-in entry and list controls.
4. **Only `data-test`.** `data-qa`, `data-cy` and other test attributes are not added
   until a page needs them.
5. **Deployment.** The service must accept the new locator before an extension that
   sends it: CI deploys the service when the change is merged, before the owner
   installs the new extension build.

## Consequences

- Duolingo's sign-in is described completely: the submit is
  `{ by: "data-test", value: "register-button" }` (live, Chrome for Testing 156,
  2026-10-23). The value says "register" on a sign-in button, and the model sees each
  candidate's locator with the page, so such a value may push it toward abstaining as
  a sign-up form; not checked with a paid generation run.
- Pages that carry `data-test` but also stable `id`s keep their `id` locators. An
  element that today gets an `autocomplete`, visible-name or text locator and carries
  `data-test` is observed with `data-test` instead, so checks that compare an observed
  target with a stored recipe's exactly miss it until the recipe is generated again.
- An older extension build fails to read a synced recipe that holds the new locator;
  Pateat keeps no backward compatibility before release.
- A site that renames its test attributes breaks the recipe, as for `data-testid`.

## Alternatives

- **Count only the button not covered by the overlay.** A hit test
  (`elementFromPoint`) would tell the covered header button apart, but it sees only the
  viewport and depends on scrolling and animation, and the executor would have to agree
  with the extractor on every visit.
- **A form-scoped text locator** ("the ログイン in the form holding these fields") also
  works, but the owner did not choose a form-scoped `name` on 2026-10-22 (ADR 0037
  amendment, option C), and it changes the recipe format more than a new attribute.
- **Keep it as is.** The page stays incomplete and is never generated.

## Amendment 2026-10-24: test attributes first

Status: accepted by the owner on 2026-10-24 (23:07 UTC, decision card
"A: テスト用属性を先にする", recommended, over B, demoting counter IDs alone, and C, no
change).

Real Chrome on 2026-10-24: Duolingo's generated recipe `gen-d0ad348b…` (revision 2, read
from the service's copy) names its fields `{ "by": "id", "value": "web-ui1" }` and
`{ "by": "id", "value": "web-ui2" }`. Duolingo numbers these IDs per render: its
remembered-account screen ("Welcome Back!") shows the password input alone as
`id="web-ui3"`, with the same `data-test="password-input"`, so no login started there
([ADR 0049](0049-start-at-a-later-step.md)'s password-alone start never found it).

Decision 2 changes: the extractor tries `data-testid`, then `data-test`, then `id`, then
`name`, each only when it names the element alone, before the other locators, as test
tools such as Playwright, Cypress and Testing Library treat a test attribute as the
stable hook. An element without a test attribute keeps its `id` or `name`.

Consequences:

- Recipes generated before keep their targets and work as before; Duolingo's must be
  removed on the management page and generated again to get `data-test` targets.
- A site that changes its test attributes between releases breaks its recipes, as one
  that renames its IDs does.
- Demoting only counter-like IDs (B) was not chosen: it guesses from the page (a stem
  and digits shared by another element), demotes stable numbered IDs such as
  `address1` and `address2`, and misses a counter alone on its page.

## Amendment 2026-11-02: counter-shaped IDs give way

Status: proposed, waiting for the owner's decision. It reverses the "demoting only
counter-like IDs (B)" rejection above, for a shape that needs no other element.

Discord's login form
([issue #1161](https://github.com/risu729/pateat/issues/1161)) has no test attribute.
Measured in Chromium on 2026-11-02, its inputs read
`<input name="email" id="uid_7" autocomplete="username webauthn">` and
`<input name="password" id="uid_9" autocomplete="current-password">` on
`/invite/<code>/login`, and `id="uid_13"` and `id="uid_15"` on `/login`. A recipe that
names them by `id` stops matching whenever the page renders a different number of
components first. The step then waits out its 10 seconds (`elements-timeout`) until the
retry limit, and nothing is filled.

Decision 2 changes: an `id` is counter-shaped when it is lower-case words joined by `-`
or `_`, ends in one to four digits and holds at least one `-` or `_` (`uid_7`,
`web-ui3`, `field-12`, `password-field-1`). Such an `id` gives way to a unique `name`,
then to a fillable input's login `autocomplete` token. It is still used when neither
names the element alone, so a stable numbered ID loses nothing on a page without
another locator. IDs without a separator before the digits (`address1`) are unchanged.

Consequences:

- The shape is read from the ID alone, so a counter alone on its page is caught and no
  other element is compared.
- A stable ID of that shape is named by its `name` or `autocomplete` token instead,
  which is as stable for a form field.
- Recipes generated before keep their targets. Discord's must be removed on the
  management page and generated again.
