# ADR 0072: A field may be named by its `name` within the sign-in form

Status: accepted by the owner on 2026-10-23 at 11:32 UTC. Built ahead of the decision as
the owner asked that day ("ある程度決め打ちで進め、後から判断"), then shown the
proposal on a card; the owner picked the recommended option, 「進める」.

Date: 2026-10-23

## Context

A fill step names its field with an allowlisted locator: an `id`, `name`, `data-testid`
or `autocomplete` attribute, or the field's visible name
([ADR 0037](0037-fields-by-visible-name.md)). Each must match one element on the page
(or one shown element, ADR 0037's 2026-10-22 amendment), or the field cannot be located
and its login form makes the page incomplete.

Hacker News's sign-in (`https://news.ycombinator.com/login`, observed 2026-10-23 in
Chrome for Testing 156 with the extension's extractor, main `381116f`) shows two forms,
both shown, that repeat the same field names:

```html
<b>Login</b>
<form action="login" method="post"><table>
  <tr><td>username:</td><td><input type="text" name="acct" size="20"></td></tr>
  <tr><td>password:</td>
    <td><input type="password" name="pw" size="20" autocomplete="current-password"></td></tr>
</table><input type="submit" value="login"></form>
<b>Create Account</b>
<form action="login" method="post"><input type="hidden" name="creating" value="t"><table>
  <tr><td>username:</td><td><input type="text" name="acct" size="20"></td></tr>
  <tr><td>password:</td>
    <td><input type="password" name="pw" size="20" autocomplete="new-password"></td></tr>
</table><input type="submit" value="create account"></form>
```

The password field is named by `autocomplete="current-password"` and the submit by its
text, but the account field has no `id`, `autocomplete` token or unique visible name
("username:" sits in a table cell, not a label), and its `name="acct"` shows twice, so
the page was incomplete (`unlocated-field`).

## Decision

1. **The locator.** A field target may be
   `{ "by": "password-form-name", "value": "acct" }`: among the elements whose `name`
   equals the value and whose form (its form owner, or for another element its nearest
   `<form>`) holds a shown password input whose `autocomplete` does not hold
   `new-password`, the one shown element, counted as ADR 0037's 2026-10-22 amendment
   counts shown copies. A lookup that counts hidden copies, as for a signed-in marker's
   elements that must be missing (ADR 0029) or a `wait` or `assert` step's missing
   element, also takes a form whose password input is hidden. The value follows the
   `name` locator's rule.
2. **When the extractor gives it.** Only to a fillable input on a page whose fields get
   visible names, after its `id`, `name`, `data-testid`, `data-test`
   ([ADR 0071](0071-data-test-locators.md)), `autocomplete` token and visible name,
   and before an `id` another load may change. Only when the executor's lookup returns
   exactly that input, the value carries no token-like segment and redaction leaves it
   unchanged.
3. **Where.** Fields, like the visible name: the extractor gives it only to a fillable
   input, so fill steps and a `totp` handler's code field take it, and a fill step's
   field on a marker's path becomes one of the marker's missing elements. The
   observation schema refuses it on a candidate that is not a field, and the
   account-list and entry checks refuse it; the recipe schema allows it wherever it
   allows a visible name.
4. **Deployment.** The service must accept the new locator before an extension that
   sends it: CI deploys the service when the change is merged, before the owner installs
   the new extension build.

## Consequences

- Hacker News's sign-in is described completely: the account field is
  `{ by: "password-form-name", value: "acct" }`, the password
  `{ by: "autocomplete", value: "current-password" }` and the submit
  `{ by: "text", value: "login" }` (live, Chrome for Testing 156, 2026-10-23).
- Two sign-in forms that both repeat the name, or a create-account form whose password
  is not marked `new-password`, stay ambiguous and the page stays incomplete.
- The form must show its password input when the step runs: a field on an
  identifier-first page, with no password yet, never gets this locator. A page that
  removes the `new-password` mark, or shows another sign-in form with the same names,
  breaks the recipe, which is then generated again.
- An older extension build fails to read a synced recipe that holds the new locator;
  Pateat keeps no backward compatibility before release.

## Alternatives

- **A form-scoped `name` in general** ("the `acct` in the form holding this password"),
  option C of ADR 0037's 2026-10-22 amendment, which the owner did not choose that day:
  it needs a second locator in each target. This ADR scopes only by a fixed rule (the
  form with a sign-in password), so a target stays one value.
- **The visible name from the table cell before the input.** "username:" is not tied to
  the input by markup, and guessing nearby text names the wrong field on other pages.
- **Keep it as is.** The page stays incomplete and is never generated.

## Amendment: a button named by its text within the sign-in form (2026-11-17)

Status: an agent's choice, made while fixing
[#1684](https://github.com/risu729/pateat/issues/1684); not yet decided by the owner.

### Context

United's sign-in (`https://www.united.com/en/us/account/profile`, a single-page app that
shows both steps on that path) asks for the email, then shows a form with the email as
text, `<input id="password" type="password">` and a `<button type="submit">` reading
"Sign in" with no `id` and no `aria-label`. On 2026-11-17 the log of that step read
`recipe.generate` `skipped` `incomplete-observation` `unlocated-button`, and a check of
the page reported a second shown button reading exactly "Sign in":
`button#loginButton` (`type="button"`, `aria-label="Sign in"`) in the site header's
navigation, outside every form. Neither the text nor the accessible-name locator
([ADR 0048](0048-password-method-button.md)) names the submit alone, so the password
step was incomplete and the password was never filled.

### Decision

1. **The locator.** A route step's click may name its button as
   `{ "by": "password-form-text", "value": "Sign in" }`: among the shown native buttons
   (a `<button>`, or an `<input>` of type `submit`, `button` or `image`) whose text, as
   a `text` locator reads it, equals the value and whose form owner holds a shown
   password input not marked `new-password` (the form a `password-form-name` locator
   looks in), the one such button. The value follows the `text` locator's rule.
2. **When the extractor gives it.** Only to a login form's native button, as its last
   locator: after its `id`, `name`, test attributes, text, accessible name and a
   locator `within` its shadow hosts ([ADR 0070](0070-shadow-roots-as-page-content.md)),
   and only before an `id` another load may change; only when the executor's lookup
   returns exactly that button and redaction leaves the text unchanged. A
   `type="button"` button with text that a located native submit precedes, which the
   extractor leaves out without a locator
   ([#1491](https://github.com/risu729/pateat/issues/1491)), never gets it, so it is
   still left out rather than offered as the form's action.
3. **Where.** A route step's click alone, never with `press: "enter"`: the observation
   schema refuses it on a candidate that is not a button, the recipe schema refuses it
   on every other element (a `password` handler's button included, unlike an accessible
   name, as the handler's word check reads the text a page sent and this locator adds
   nothing there), and the plan's account switch, the entry, account-list and logout
   checks refuse it.
4. **Execution.** As for every locator, the click acts only when exactly one element
   matches, and only when that button's form holds an input this attempt filled;
   otherwise it fails `target-missing` and presses nothing, so another sign-in form's
   button that became the only match is never pressed.
5. **Deployment.** As for the field locator (decision 4 of this ADR): the service
   accepts the locator before an extension that sends it.

### Consequences

- United's password step is described completely, with the submit as
  `{ by: "password-form-text", value: "Sign in" }` (a DOM fixture of that step; not yet
  tried on the live site).
- Two sign-in forms that both show the text, or two such buttons in one form, stay
  ambiguous, and the page stays incomplete.
- A page that renames the button, removes the password input, hides it or retypes it
  (as a show-password toggle switching it to `type="text"`) before the click, or marks
  it `new-password`, breaks the recipe: the click fails `target-missing`, and the recipe
  is then generated again.

### Alternatives

- **Leave the submit out** as an icon button or a form's `type="button"` text button is
  left out: the recipe would have no button to press, and Enter in the password field
  ([ADR 0064](0064-enter-in-a-form-without-a-button.md)) refuses a default button that
  was already shown.
- **Make the page-wide `text` locator prefer a login form's button**: it changes what
  every stored text locator matches, so a recipe made before could press another button.
- **`within` for forms**: a form often has no `id` or `name` to name it by, as United's.
