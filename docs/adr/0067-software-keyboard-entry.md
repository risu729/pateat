# ADR 0067: A field on a page's software keyboard is typed one key press per character

Status: proposed, implemented pending the owner's approval; not to be merged until the
owner decides. The plan's phase 4 item on entering a value on a page's software keyboard
is the owner's (2026-10-17 03:35 UTC); every choice below is Claude's default, pending
the owner's confirmation. On 2026-10-23 the owner asked for work to go ahead regardless
of phase on the most likely answer and be judged later, as for the other proposed pull
requests
(「フェーズは一旦無視して、ある程度決め打ちで進め、後から判断という今あるprたちと同じ例外扱いで」).
The number was free when the pull request opened and may be renumbered. Amends
[ADR 0010](0010-inference-field-hints.md) (a read-only field beside a keypad is
described) and [ADR 0016](0016-recipe-generation-trigger.md) (such a password field is a
sign-in input). No installed-Chrome or real-site check has been run.

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
  are at least 10 and that element is not the body. It is located by the `id` or
  `data-testid` of it or its nearest ancestor below the body that names one element
  alone. A visible, enabled, read-only fill field on such a page is described as a fill
  candidate with `keypad` set to that locator; the keys are left out of the candidates.
  Without a locator the page stays incomplete, as before.
- **The recipe carries only the keypad's locator.** A fill field may name `keypad`
  (`id` or `test-id`), only in a preparing fill. Generation copies it from the
  observation in `validatePagePlan`; the model never gives it, and the prompts are
  unchanged. A read-only password input counts as a sign-in input on a page with a
  keypad (ADR 0016).
- **The executor presses one key per character, and never guesses.** It focuses the
  field and, when no key shows, presses the field and waits up to 2 seconds for the
  keys. A field that already holds characters is refused. Before the first press every
  character must have exactly one key a person can press now (shown, enabled, not inert)
  whose label equals it, case kept; otherwise nothing is pressed (`keypad-key-missing`).
  Each key is looked up again just before its press, since a keypad may shuffle after
  each one, and pressed with a person's mouse events (`pressElement`). After each press
  the field must hold one more character, masked or not; otherwise the step stops as
  `fill-rejected`. A stop never presses again, never presses a clear key and never
  clicks the submit button. A key that shows its character only as an image without
  `alt` is never used.
- Nothing new leaves the device: the keypad's `id` or test ID goes to the service as
  any locator does; the value, the key labels, their order and which keys were pressed
  do not. Logs carry the codes `keypad-missing` and `keypad-key-missing` only.

## Consequences

- A page that takes a password or PIN only from its own keys can log in automatically
  when its keypad and field are as above.
- A keypad whose keys check `isTrusted`, or that keeps the value elsewhere and leaves
  the field unchanged, stops after its first press without submitting; the person enters
  the value. A single-character control elsewhere on the page, such as a "?" help
  button, makes the page have no keypad.
- An advance whose next step on the same path is a keypad field is not confirmed by that
  field, which the in-place check reads as writable inputs only (ADR 0013), and the
  checks of a sign-in form shown again (ADR 0029) do not count a read-only field.

## Alternatives

- Setting the read-only field's `value` and sending events: the least code, but most
  keypads keep the value in their own state or a hidden input, so the page would get no
  value or another one than it shows, and a wrong submission can lock the account.
- The model naming the keys, or a recipe storing the layout: sends the keypad's labels
  to the service and breaks on every shuffle.
- Leaving these pages to the person, as today.
