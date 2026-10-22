# ADR 0037: Fields located by their visible name

Status: accepted by the owner on 2026-10-13 at 04:50 UTC (decision card
「入力欄に毎回変わる ID しかないとき、レシピは画面の表示名で欄を探しますか？」, answer
「表示名で探す」). Adds a locator to the list the
[architecture](../architecture.md#declarative-recipes-and-ai) keeps; no earlier ADR
lists them. Corrected on 2026-10-14 by the
[wording changes amendment](#amendment-wording-changes) (item 5 of the decision).
Amended on 2026-10-18 by
[ADR 0027](0027-per-account-login-routes.md#amendment-2026-10-18-slot-names-from-the-page)
(owner, 08:58:31 UTC): recipes also store page text as custom-field slot names
([slot names](#amendment-2026-10-18-slot-names)).
Amended on 2026-10-19 by [ADR 0048](0048-password-method-button.md)'s amendment (owner,
01:26 UTC, option A1): a control may be named by its accessible name
([amendment](#amendment-controls-named-by-their-accessible-names)).
Amended on 2026-10-22 by the owner (11:36 UTC, #850): a split code input's name may
number its place ([amendment](#amendment-2026-10-22-places-of-a-split-code)).

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

## Amendment 2026-10-18: slot names

Since ADR 0027's amendment of 2026-10-18, a recipe also stores page text as the name of
each custom-field slot, taken under this ADR's rule against numbers and with redacted
text skipped. That text is wider than a visible name: the extractor's label also takes
the text before a field and its `title`, and the placeholder, description, `id`, `name`
and test ID follow. A person's display name that a label shows, as in this ADR's
consequences, can therefore become a slot name as well. All of it is text the service
and Anthropic already receive with the observation and the request log keeps.

## Amendment: controls named by their accessible names

Accepted by the owner on 2026-10-19 at 01:26 UTC, on the decision card that chose
option A1 of `designs/select-by-accessible-name-proposal-ja.md`; the rules are in
[ADR 0048's amendment](0048-password-method-button.md#amendment-controls-told-apart-by-their-accessible-names).
Option A2 was not chosen.

Item 2 says a field's visible name is never used for a button, link or checkbox. That
stays: the `label` locator still names only fillable inputs. A separate locator,
`{ "by": "accessible-name", "value": "Select Password." }`, names a control by the
rendered text of the elements its `aria-labelledby` names, else its `aria-label`, never
its `<label>` or `placeholder`. The two are counted apart, so a control whose name
equals a field's never makes the field's step ambiguous. It names only a `password`
handler's button, which may be a link to a fragment of its own page, and is given on
the conditions of item 2 (one on the page, no number, unchanged by redaction). The
service must accept it before an extension that sends it, as for the `label` locator.

## Amendment 2026-10-22: shown copies only

Accepted by the owner on 2026-10-22 at 04:23 UTC, on the decision card that chose option
A of `designs/hidden-duplicate-name-fields-proposal-ja.md` (#832). Options B (numbers
allowed in a length hint), C (a `name` scoped to its form) and D were not chosen.

This ADR counted visible names among shown inputs only, while `id`, `name`,
`data-testid` and `autocomplete` counted every element, hidden or not. They now count
the same way: when several elements carry the value, only those the content script's
visibility check shows count (`findTargets`), and the extractor gives such a value when
the field is the one shown element with it. One element counts shown or hidden, so a
step whose element is not shown yet is still waited for. The official Bitwarden
extension also leaves hidden fields out (`loadPasswordFields(…, canBeHidden = false)`
in `autofill.service.ts`).

Signed-in markers and the elements they need missing (ADR 0029) keep counting every
copy, in the extractor and when observed, as decided on the card, and so does a `wait`
or `assert` step's element that must be missing. A field that may be a sign-in field on
the signed-in page is located as on a login page, since its steps find it that way. An
absent element whose hidden copy stays on the signed-in page therefore still keeps that
marker from proving a sign-in.

A copy that a site shows later makes the step ambiguous (`structural-mismatch`), as a
second shown visible name already did. A step's element the page keeps in two or more
copies, all hidden, now counts as missing rather than ambiguous, so a login form left
hidden twice on a page may let that page reach the judge; a single hidden element is
still found, as before.

## Amendment 2026-10-22: places of a split code

Accepted by the owner on 2026-10-22 at 11:36 UTC, on the decision card that chose option
A of `designs/grok-issues-833-834-850-proposal-ja.md` (#850). Option B (a new locator
for a form's first code input, which changes the recipe format) and C were not chosen.

Slack's two-factor page shows six one-digit inputs with no `id` or `name`, sharing
`autocomplete="one-time-code"`, each named by its place (`digit 1 of 6`). Item 2 refused
those names, so the page was incomplete (`unlocated-field`) and never judged. An
input's name may now hold numbers when the input is one of a code split into one input
per digit (6 to 8 shown inputs of its form, or of no form, that take one character and
that the TOTP fill rule accepts: `splitCodeInputs` in
`apps/extension/src/page/code-submission.ts`, with shown read as the extractor reads
it) and every number in the name is the input's place among them or their count. A place
does not change as the person types; a name such as `Sent to ••12` or
`••• 4 2 7, digit 1` is still refused. Uniqueness and redaction stay as item 2 says.

This is an exception to item 2's other reason too: the numbers reach the service and the
model as locator values of the signed-in page, which otherwise shows no number (ADR
0018). A field's label and description there still show `[number]`. The executor
needs no change: a `totp` handler names only the first input, fills the rest from its
form (ADR 0027), and finds the first input by its name again while it watches for the
page submitting the code.
