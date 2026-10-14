# ADR 0037: Fields located by their visible name

Status: accepted by the owner on 2026-10-13 at 04:50 UTC (decision card
「入力欄に毎回変わる ID しかないとき、レシピは画面の表示名で欄を探しますか？」, answer
「表示名で探す」). Adds a locator to the list the
[architecture](../architecture.md#declarative-recipes-and-ai) keeps; no earlier ADR
lists them. Corrected on 2026-10-14 by the
[wording changes amendment](#amendment-wording-changes) (item 5 of the decision).

Date: 2026-10-13

## Context

A step names its element with an allowlisted locator: an `id`, `name`, `data-testid`,
an input's `autocomplete` token, or a button's text. A field that none of them names
alone, and that only an `id` holding a random-looking run names, is located by that
`id`, which the extractor demotes but still uses.

外資就活ドットコム is built with Mantine. Its login fields carry only the per-load IDs
Mantine's `useId` makes (`mantine-v0zmrhrmb`), with no `name`, `autocomplete` or
`<label>`, and the placeholders 「メールアドレス」 and 「パスワード」 (AI generation
log, 2026-10-13 04:37 UTC). The saved recipe names the fields by those IDs, which the
next visit no longer has, so the recipe fails on every visit and the AI generates it
again each time.

## Decision

A fill target may name a field by its visible name, as `{ "by": "label", "value":
"メールアドレス" }`.

1. **The name.** For a shown `<input>` of a type Pateat fills (`text`, `email`, `tel`,
   `number`, `password`): the rendered text of the elements its `aria-labelledby`
   names, else of its `<label>` elements, else its `aria-label`, else its
   `placeholder`; the first that is not empty, with whitespace collapsed and format
   characters removed. A first name longer than 120 characters gives no name; a later
   source is not tried in its place. The extractor and the executor compute it with
   one function (`fieldName` in `apps/extension/src/page/text.ts`).
2. **When the extractor uses it.** Only for such a field, never for a button, link or
   checkbox, and only after the `id`, `name`, `data-testid` and `autocomplete`
   locators: a field that one of them names alone keeps using it. The name comes
   before an `id` another load may change (a random-looking run or a library's `useId`
   prefix), and only when exactly one shown fillable input on the page has that name,
   counted as the executor sees the page. A name that redaction would change, such as
   a placeholder holding an example address (`taro@example.com`), or that holds a
   number, which may change as the person types (a counter such as `0/20`) and which a
   signed-in page's text never shows, is never used.
3. **Where.** Fill steps and a `totp` handler's code field accept it; the observation
   allows it on fill-role candidates only. A sign-in entry and a list control never
   take it. On the signed-in page only a field that may be a sign-in field gets it, as
   a recipe's fill names it; signed-in markers stay as before. ADR 0027 called the
   `totp` code field's locator an attribute one; it may now be a visible name too.
4. **The executor** matches the shown fillable inputs whose name equals the value. A
   hidden input never matches, and, as for every locator, anything but exactly one
   match is a structural mismatch.
5. **Wording changes.** When the site changes the field's wording or language, the
   recipe no longer finds the field, and the recipe is generated again as it is today.

The AI never picks a locator: it names candidates, and the recipe takes the locator the
observation offered for each, so the generation prompt does not change.

## Consequences

- A login form that only per-load IDs and stable names identify keeps its recipe across
  visits, so the second visit to 外資就活ドットコム should run the saved recipe without
  a model call. Checked with synthetic pages only; the real site is to be checked in the
  owner's Chrome.
- The name is page text stored in the recipe, like a button's text locator. Redaction
  keeps email addresses and long numbers out of it, and the account's own username
  keeps the page from being sent (`username-shown`) as for any field locator, but a
  person's display name in a label, as "Password for Taro Yamada" on a page that asks
  again, would be stored when it differs from the username.
- A stable `id` that looks random-looking or carries a library prefix now loses to the
  visible name, so such a field's recipe depends on the page's wording.
- A recipe's signed-in marker lists the fields of its own sign-in path as `absent`, so
  a login page that keeps a hidden "Sign out" element never counts as signed in. A
  field named by its visible name never matches hidden, so such a page that also keeps
  the sign-in field hidden is not caught by that field.
- A recipe that relies on a placeholder breaks when the site rewords it, and a page
  that shows a second field with the same name (a hidden copy shown later, or a second
  form) makes the step ambiguous until the recipe is generated again.
- The service and the extension share the contract. The service must accept the new
  locator before an extension that sends it: CI deploys the service when the change is
  merged, before the owner installs the new extension build.

## Alternatives

- **Keep it as is.** Such a site's recipe is generated again on every visit, about
  $0.007 a visit, and logs in only after the model answers.
- **Locate by input type.** `type="password"` or `type="email"` alone names one field
  on many login pages, but not a text field, which most identifiers use, nor a form with
  two inputs of one type, and a newsletter field beside the form takes it over.

## Amendment: wording changes

Added on 2026-10-14 at the owner's request (08:44 UTC); a correction of a fact, not a
new decision. Item 5 of the decision says that when the site changes a field's wording
the recipe is generated again as it is today. It is not: the step no longer finds its
field, the login ends as a structural mismatch, and the saved recipe stays until it is
revoked. Only a revoked recipe is generated again
([architecture](../architecture.md#declarative-recipes-and-ai)); repairing a recipe
whose elements no longer match is planned early in
[phase 3](../plan.md#phase-3-public-release).
