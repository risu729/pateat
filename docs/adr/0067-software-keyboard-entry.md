# ADR 0067: A field on a page's software keyboard is typed one key press per character

Status: accepted by the owner on 2026-10-23 at 12:28 UTC, choosing option A: press the
page's own on-screen keys (setting the field's value, B, and leaving these pages to the
person, C, were the other options). Built ahead of the decision on the owner's
2026-10-23 rule to set the phases aside, proceed on the most likely answer and decide
afterwards
(「フェーズは一旦無視して、ある程度決め打ちで進め、後から判断という今あるprたちと同じ例外扱いで」);
the plan's phase 4 item on entering a value on a page's software keyboard is the owner's
(2026-10-17 03:35 UTC). On 2026-10-23 at 13:01 UTC the owner also chose, on two cards: a
keypad that leaves the visible field unchanged gets no press past the first (the check
after each press stays), and option B for keypads without a unique `id` or
`data-testid`: they may be named by a class or by their position when that names them
alone at run time, letters-only keyboards count, and date pickers, pagination and
`A`-`Z` index bars are kept out by general structural guards. The other choices below
are Claude's defaults. Amends [ADR 0010](0010-inference-field-hints.md) (a read-only
field beside a keypad is described), [ADR 0016](0016-recipe-generation-trigger.md) (such
a password field is a sign-in input) and [ADR 0029](0029-local-sign-in-state.md) (such a
field counts in the signs of a failure and S2). Revised on 2026-10-23 after an
independent review (keypad requirements, value checks before the first press, a page
change after a press, the signs of a failure), and after the decision (a stop after a
key press tells the person to reload). No installed-Chrome or real-site check has been
run.

Date: 2026-10-23

## Context

Some bank and card pages keep a password or PIN input `readonly` and take its characters
only from keys the page draws, often in an order that changes on every load or press.
Pateat's fill writes only into inputs that are not read-only, the observation marks a
read-only field as `unfillable-field`, and the official Bitwarden extension skips such
fields too ([differences](../bitwarden-differences.md#software-keyboards)), so these
logins are left to the person (the [phase 1](../plan.md#phase-1-usable) row for
エポスNet).

Public login pages loaded in a cloud browser on 2026-10-23 without credentials showed
two shapes, both optional keyboards beside an ordinary input: SMBC Direct's
`<div id="softwareKeyBoard">` of `<input type="button" value="Ｆ">` keys with full-width
characters, whose letters start at another place and whose digits change order on each
load, and MUFG's list of `<a href="#">A</a>` links in a fixed order. Keys elsewhere show
their character by `aria-label`, by an image's `alt`, or only as an image.

## Decision

- **The observation names the keypad, never its keys.** A keypad is the nearest element
  holding every control of the document whose label is one character (a button, a
  submit, button or image input, a script button, a link to a fragment of its own page,
  or an element with an `onclick` attribute; the label is its visible text, else its
  `aria-label`, else its one image's `alt`, with full-width forms folded), when there
  are at least 10, they include a key for each of the ten digits or at least 26 letters
  of any script (a letters-only keyboard, owner, 13:01 UTC), and that element is not the
  body. Guards read the page's structure, never a site
  ([ADR 0033](0033-no-site-specific-features.md)):
  - A control inside navigation (`nav`, `role="navigation"`), a grid, a tab bar or a
    menu bar, one marked `aria-current`, a `rel` next or previous link, and a link that
    jumps to an element of its own page by `id` or `name` (an `A`-`Z` index bar's `#A`)
    is not a key; a keypad's links go nowhere (`href="#"`).
  - An element is no keypad when it, with its box (its parent below the body), sits in
    or holds navigation or a grid, holds the current item of a list, a next or previous
    link, a `<time datetime>` or such a non-key control, or holds a control or table
    cell whose label is a whole number from 10 on: a date picker's days 10 to 31, a
    page 12. A keypad's `00` key is no such number.
  It is located by the `id`, `data-testid` or class of it or its nearest ancestor below
  the body that names one element alone, skipping IDs and classes that look generated,
  else by its position from each field: up to the nearest box holding both, then down
  by child indexes (owner, 13:01 UTC). A visible, enabled, empty read-only fill field
  that shares the keypad's form or a container below the body with it is described as a
  fill candidate with `keypad` set to that locator; the keys are left out of the
  candidates. A read-only field that holds a value, as a date or an email address shown
  again, stays unfillable, and so does any field without a keypad, as before.
- **The recipe carries only the keypad's locator.** A fill field may name `keypad`
  (`id`, `test-id`, `class` or `position`), only in a preparing fill. A class or a
  position names the keypad only while the one element it finds holds the page's
  keypad, read again at run time, else the step ends as `keypad-missing`. Generation
  copies it from the observation in `validatePagePlan`; the model never gives it, and
  the prompts are unchanged. An empty read-only password input beside a keypad counts
  as a sign-in input (ADR 0016).
- **The executor presses one key per character, and never guesses.** A value longer
  than the field's `maxlength` is refused before anything is filled, as for any field
  (ADR 0010). A keypad that already shows its keys must show exactly one key a person
  can press now (shown, enabled, not inert) whose label equals each character, case
  kept, before any field of the step is typed; otherwise the step ends as
  `value-mismatch` with nothing done. Only key labels are folded: a value's own
  full-width character, as `Ａ` in a stored password, has no key. Otherwise the executor
  focuses the field and, when no key shows, presses the field, waits up to 2 seconds for
  the keys, and checks the same before the first key press (`keypad-key-missing` in the
  log). A field that already holds characters is refused. Each key is looked up again
  just before its press, since a keypad may shuffle after each one, and pressed with a
  person's mouse events (`pressElement`); the press stops before its click when the key
  no longer shows its character, as a keypad that relabels its keys on `mousedown`.
  After each press the field must hold exactly one more character, masked or not;
  otherwise the step stops as `fill-rejected`. A page that moves or replaces the field
  after a key press may have taken the characters so far as the whole value, as a PIN
  pad that submits at its fourth digit, so the step is answered as a possible
  submission and the login waits for its result, never as a cancellation that could type
  again. A stop never presses again, never presses a clear key and never clicks the
  submit button. A key that shows its character only as an image without `alt` is
  never used.
- **A stop after a key press tells the person to reload.** A stop of the step after a
  key press, other than a possible submission and including one at a later field, leaves
  characters in the field that no step clears. The step's detail is then
  `keypad-pressed`, and the popup tells the person to reload the page before entering
  the value. Pateat never reloads the page itself: a reload may send a posted form
  again. The stopped login, ended while a fill may have reached the page, is resumed by
  the tab's later pages and holds the site in other tabs
  ([ADR 0022](0022-login-attempts-per-tab-and-origin.md)), so the reloaded page is left
  to the person and never typed on again by itself.
- **A rejection is read as for any field.** The read-only field the step typed on counts
  as a sign-in input in the signs of a failure (ADR 0029, F1 and F2), in the submitted
  document and in a sign-in form shown again beside a keypad, and an empty read-only
  password input beside a keypad counts for S2, so a wrong PIN ends the login as
  `credential-rejected` and other tabs never type it again (ADR 0021 D).
- Nothing new leaves the device: the keypad's `id` or test ID goes to the service as
  any locator does; the value, the key labels, their order and which keys were pressed
  do not. Logs and the outcome report (ADR 0019) carry the codes `keypad-missing`,
  `keypad-key-missing` and `keypad-pressed` only.

## Consequences

- A page that takes a password or PIN only from its own keys can log in automatically
  when its keypad and field are as above.
- A keypad whose keys check `isTrusted`, or that keeps the value elsewhere and leaves
  the field unchanged, stops after its first press without submitting, as the owner
  chose (13:01 UTC); the person is told to reload and enters the value. A
  single-character control elsewhere on the page, such as a "?" help button, makes the
  page have no keypad.
- An advance whose next step on the same path is a keypad field is not confirmed by that
  field, which the in-place check reads as writable inputs only (ADR 0013).
- A keypad with neither every digit nor 26 letters is no keypad, and a keypad drawn
  apart from its field, sharing only the body with it, is not that field's. A keypad
  drawn as an ARIA grid, or placed beside navigation, a `<time>` or a jump link in its
  box, is taken for a date picker, pagination or an index bar and left to the person.
- A position locator breaks when the page moves the keypad to another place relative to
  the field; the step then ends as `keypad-missing` and nothing is pressed.

## Alternatives

- Setting the read-only field's `value` and sending events (B): the least code, but most
  keypads keep the value in their own state or a hidden input, so the page would get no
  value or another one than it shows, and a wrong submission can lock the account.
- The model naming the keys, or a recipe storing the layout: sends the keypad's labels
  to the service and breaks on every shuffle.
- Leaving these pages to the person, as before (C).
- Pressing on when the visible field does not change after a press: would type into
  keypads that keep the value elsewhere, but Pateat could no longer see what it typed
  and a wrong submission can lock the account; the owner kept the check (13:01 UTC).
- Requiring every digit and an `id` or `data-testid` (the first build): kept date
  pickers, pagination and index bars out without guards, but left letters-only
  keyboards and keypads without such attributes to the person; the owner chose to widen
  it (13:01 UTC).
- Trusted input through `chrome.debugger` (the debugger API's `Input.dispatchMouseEvent`
  or `Input.insertText`), which a keypad that checks `isTrusted` would take: rejected
  because it needs the `debugger` permission and Chrome shows its debugging banner on
  the tab while attached.
- Reloading the page after a stop that pressed a key: clears the field without the
  person, but a reload may send a posted form again and loses what the page held, so
  the person is told to reload instead.
