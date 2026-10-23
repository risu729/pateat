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
<form action="login" method="post">
  username: <input type="text" name="acct" size="20" autofocus="true">
  password: <input type="password" name="pw" size="20" autocomplete="current-password">
  <input type="submit" value="login">
</form>
<b>Create Account</b>
<form action="login" method="post">
  <input type="hidden" name="creating" value="t">
  username: <input type="text" name="acct" size="20">
  password: <input type="password" name="pw" size="20" autocomplete="new-password">
  <input type="submit" value="create account">
</form>
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
   counts shown copies. The value follows the `name` locator's rule.
2. **When the extractor gives it.** Only to a fillable input on a page whose fields get
   visible names, after its `id`, `name`, `data-testid`, `autocomplete` token and
   visible name, and before an `id` another load may change. Only when the executor's
   lookup returns exactly that input, the value carries no token-like segment and
   redaction leaves it unchanged.
3. **Where.** Fields only, like the visible name: fill steps and a `totp` handler's code
   field take it. The observation schema refuses it on a candidate that is not a field,
   and the account-list and entry checks refuse it.
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
