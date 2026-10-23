# ADR 0071: Elements may be named by their `data-test` attribute

Status: accepted by the owner on 2026-10-23 at 11:32 UTC. Built ahead of the decision
as the owner asked that day ("ある程度決め打ちで進め、後から判断"), then shown this
proposal on a card; the owner picked the recommended option, 「採用してマージ」.

Date: 2026-10-23

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
