# ADR 0010: Inference field hints and local fill checks

Status: accepted by the owner on 2026-10-10. The hint contract, the shape derivation and
the local value check are implemented in `packages/contracts`. The executor runs both
checks. Automatic generation sends the username's shape when every matching item agrees
([ADR 0016](0016-recipe-generation-trigger.md#username-shape)). Amended on 2026-10-11 by
[ADR 0027](0027-per-account-login-routes.md) (implemented): generation offers custom
fields by `fieldName`, with `fieldPosition` (position and count) for a name several of
the item's custom fields share, and Text shapes when every matching item agrees; Hidden
fields are offered as a `hidden` slot kind, which never carries a shape. Amended on
2026-10-23 by [ADR 0067](0067-software-keyboard-entry.md): an empty read-only field
beside the page's software keyboard is described as a fill candidate with the keypad's
locator, and its value must have exactly one key per character before anything is
typed. Amended on 2026-10-23 by the owner's rule that every model call gets the same
information unless there is a sound reason: the judge request carries the login item's
slots with these hints too
([ADR 0061](0061-personal-details-during-a-login.md#the-judge-gets-the-accounts-slots)).

Amended on 2026-11-07 with fixed fill-rejection diagnostics (implementation detail;
see below). Amended the same day for cleared filled inputs and for the owner's
03:45 UTC separator-insertion decision, implemented below.

Date: 2026-10-10

## Context

[ADR 0003](0003-service-and-ai.md) keeps vault values out of inference. With slot
meanings alone, a model cannot tell apart pages whose fields differ mainly by length,
such as an unlabeled bank login asking for a 3-digit branch number and a 7-digit
account number. Bitwarden custom fields carry user-chosen names, and Text fields are
shown in clear in the Bitwarden UI, unlike Hidden fields. Some sites also reject a
value only through script after it is entered.

## Decision

A semantic slot may carry two optional hints:

- `fieldName`: the user's name for a vault field that the item policy allows for
  filling, of any field type including Hidden. Names follow the observed-text bounds
  (1-120 characters, no control, format or line separator characters). Users are
  assumed not to store credentials in field names; this is not enforced.
- `valueShape`: the UTF-16 length, the character classes present (ASCII digit, ASCII
  letter, ASCII symbol, fullwidth ASCII variant, whitespace, other) in a fixed
  canonical order, and whether the value is a valid email address. It never carries
  characters, their positions or their order. `valueShapeOf` accepts only
  `{ source: "username" | "text", value }`: the login username or a Bitwarden Text
  custom field, with a Linked field resolved to its source first. Hidden fields,
  passwords and TOTP never get a shape, and the contract rejects a shape on secret
  and one-time-code slots as a second guard.

Example slot as sent:

```json
{
  "id": "branch-number",
  "kind": "identifier",
  "description": "bank branch number",
  "fieldName": "支店番号",
  "valueShape": { "length": 3, "classes": ["ascii-digit"], "email": false }
}
```

Observations also carry `maxLength`, `minLength` and `inputMode` that the extractor
reads from DOM attributes; the model never derives them. The extractor omits a length
outside 1-1024 and omits both when `minlength` exceeds `maxlength`. `pattern` is
excluded because evaluating a page-supplied expression locally could hang the caller.

Two local checks gate a fill; neither sends anything to inference:

1. Before filling, `checkPlanValues` compares each mapped value with the observed
   element: present and non-empty, within `maxLength`/`minLength` (ignored on
   `number` inputs, as browsers do), and a valid email or number for those input
   types. A mismatch stops the attempt as a `value-mismatch` abstention.
2. After filling and before the click, the executor waits briefly for the page's own
   handlers and stops without clicking when a filled element fails
   `checkValidity()`, has `aria-invalid="true"`, or a new `role="alert"` or live
   region message appears. Error text can echo the value, so it stays local and is
   never sent for repair. No page script is analyzed.

Implementation choices in the executor, made on 2026-10-11 without a new owner
decision:

- Check 1 reads the real input's `type`, `maxlength` and `minlength` when the fill
  step runs, so it also covers recipes not generated from an observation. A mismatch
  fills nothing and ends the attempt as `value-mismatch` without a retry, since the
  same values would fail again.
- Check 2 runs after a fill that prepares a click, waiting 500 ms from the last field
  (since 2026-10-13 each field is focused, typed and blurred in turn; see
  [background execution](../architecture.md#background-execution)). It reads
  `validity.valid`, which fires no `invalid` event for the page to react to.
  `aria-invalid="true"` counts only when the fill turned it on, and a custom validity
  message only when it is new, so a mark left by an earlier failed sign-in that no
  script clears does not stop the fill. When a filled input was replaced or removed,
  for example by a page that signs in by itself, nothing is clicked and the attempt
  observes the page as after any uncertain fill.
- `role="alert"` and `aria-live="assertive"` regions count anywhere on the page.
  `role="status"` and `aria-live="polite"` regions count only inside the filled form
  or when a filled input names them in `aria-describedby` or `aria-errormessage`,
  since pages also use them for timers and search suggestions. A region that contains
  a filled input, and `log`, `marquee` and `timer` regions, are not read. A message
  counts as new only when its text differs from every message shown before the fill.
- A rejection ends the attempt as `fill-rejected` without a retry or the click. A fill
  that submits through its own input event gets only check 1.

## Consequences

Visible identifier values are no longer fully opaque to the provider: their length and
character classes are disclosed for every inference request that includes them. A
4-digit identifier reveals its length, which is accepted because Text fields are
already treated as non-secret. Secrets disclose nothing beyond their slot kind and,
when allowed, their field name.

The checks catch swapped mappings and values the page rejects, but cannot detect a
wrong mapping between two inputs with identical constraints and no page reaction.

## Alternatives

- Values never leave, with no shape: safest, but loses the main signal on unlabeled
  numeric pages. The local check alone can stop a wrong fill but cannot help choose.
- Shapes for every field, including Hidden and passwords: rejected; length narrows a
  secret, and Hidden marks the user's intent to conceal.
- Sending page `pattern` and evaluating it locally: rejected for the hang risk above.
- Analyzing page scripts for validation rules: rejected as heavy and brittle; the
  post-fill observation covers script validation generically.

## Amendment 2026-11-07: fixed causes for a rejected fill

The diagnostics work in [issue 1326](https://github.com/risu729/pateat/issues/1326)
exposes which existing check rejected the fill. This is an implementation choice within
the requested logging scope, not a new rule for accepting page rewrites. A typed refusal
reports `typed-refused`; constraint validation reports `input-` followed by its fixed
flag name (`value-missing`, `pattern-mismatch`, `type-mismatch`, `too-long`,
`too-short`, `range-underflow`, `range-overflow`, `step-mismatch`, `bad-input`, or
`custom-error`). New ARIA marks, alert text and relevant status text report
`aria-invalid`, `alert-shown` and `status-shown`. Enter's form check reports
`form-invalid`, and its attempt ends `structural-mismatch`. The first rejecting
input/check wins; existing feedback baselines and unchanged custom validity messages are
treated as before.

For a field-specific rejection, `fieldIndex` is its zero-based position in the recipe
fill step, including position zero for any digit of a split code. It is a bounded count,
not a DOM identifier, slot name or label. The execution result, attempt report, local
log and existing service problem-line allowlist carry it. Outcome and timing records
carry the fixed cause only; their schema and database need no additional column.
A keypad that already received a key retains its existing `keypad-pressed` cause so
the person is still told to reload before another attempt; a field-specific rejection
there keeps its `fieldIndex`.

The page's text, messages, labels and values stay in the content script. The checks
still stop the same fills, add no waits, and do not claim to verify any real site's
behavior. The inserted-separator exception came later, in the amendment below.

## Amendment 2026-11-07: a cleared filled input changes the form

The structural fix proposed in
[issue 1326](https://github.com/risu729/pateat/issues/1326) assumes that a filled input
the page emptied while it is still writable means the form needs repair, as the existing
pre-click check already treats it. This is a general form rule; it does not claim that
the issue's example site clears fields.

After a preparing fill's existing form-replacement check and before its rejection
checks, any filled input of the step that the page emptied while it is still writable
ends the step as `structural-mismatch` with `form-changed`, whatever rejection the
step's other inputs show. This permits the existing repair path rather than permanently
rejecting the value because the emptied input is required, newly ARIA-invalid, or has
new required-field feedback.
Hidden, disabled and read-only inputs do not trigger this rule. Code submission watches
keep their own rejection checks and submission priority. No wait is added.

## Amendment 2026-11-07: values formatted with inserted separators

The owner accepted the rule in
[issue 1326, part 4](https://github.com/risu729/pateat/issues/1326#issuecomment-6701829301)
on 2026-11-07 at 03:45 UTC: "spaces and hyphens only". A held value changed only by
inserting ASCII spaces (U+0020) and hyphen-minus (U+002D) is kept when removing only
those insertions leaves exactly the typed value. Every original character, including an
original space or hyphen, must remain in order. The held value, including the
insertions, must fit `maxlength`. Other inserted characters, including `/`, `.` and `(`,
get no exception.

Claude's implementation choices (2026-11-07, after review): an insertion must sit
between two typed characters, because a separator before the first or after the last
groups nothing and a leading hyphen can change the value; and a number input takes no
insertion, since a hyphen there only changes the number (`1e5` to `1e-5`). The rule
covers every typed field, password and code fields included, as the owner's rule names
no field kind; a one-character value, such as a digit of a split code, has nothing
between to take an insertion. Characters are compared as whole code points, so no
insertion can split a surrogate pair.

This applies to the settled check after the last character, including a cancelled
key the page wrote itself, and again after `change` and blur. Match raw characters
before any width folding so an inserted fullwidth space or hyphen cannot become an
allowed ASCII insertion. No site-specific rule or wait is added.

The existing 2026-10-18 02:07 UTC owner decision keeps width-only rewrites: fold only
U+3000 and U+FF01 through U+FFEF as Unicode NFKC does, then compose, so `１－２－３`
matches `1-2-3` and `ｶﾞ` matches `ガ`. This is an independent equality check;
combining width changes with inserted separators is outside the new exact-insertion
exception. It also requires the held value to fit `maxlength`.

The pre-existing same-length mask/case rule is preserved: with no cancelled key, a
same-code-point-length rewrite can still be kept even if neither equality check matches.
The new exception does not make deletions, reordering or other punctuation acceptable
when they change the value's length. The amendment of 2026-11-08 below narrows that
same-length rule. A field emptied on `change`/blur still reaches the separate
form-change checks above.

Consumer audit: `inputValueMismatch` and the per-character `between` checks compare
the planned value with the input's declared type and lengths, not with the held
value. The checks before a click read whether filled controls are empty or writable
and the page's native validity and feedback. `formAccounts`/`showsOtherAccount`
read rendered identifiers and hidden, read-only or disabled account inputs, never
the writable input's typed value. Sign-in state reads sign-in controls and compares
the username with rendered header/navigation text, not the filled field. Their
account-identity rules remain unchanged; separator insertion is local to typing.
`siteValueChoice`/`sameAccountValue` compare only page-owned values recorded before
Pateat starts acting; recording stops before it types. Code-submission checks read
emptiness, not equality with a typed value.

## Amendment 2026-11-08: same-length rewrites only change case, width or mask

The owner chose option A on
[issue 1368](https://github.com/risu729/pateat/issues/1368) on 2026-11-08 at 06:57
UTC: a held value of the typed value's code-point length is kept only when the
character at each position differs from the typed one only in case or between
full-width and half-width, or was replaced by a mask symbol. Any other substitution
or reordering, such as `1234` into `1235` or `1243`, refuses the value. Until then any
same-length value was kept when no key was cancelled.

Claude's implementation choices (2026-11-08): each held character is width-folded
as above and then compared with the folded typed character case-insensitively, so a
page may change both, as `a` into `Ａ`. The mask symbols are `*`, `＊`, `•`, `●`,
`·`, `∙`, `・` and `･`; a typed character may become any of them, and a value may be
masked only in part, as `••34`. A cancelled key still keeps only the width and
separator exceptions, since the page wrote the character itself. A rewrite neither
fold covers, such as hiragana into katakana or `-` into `ー`, is now refused. The
check runs after the last character and again after `change` and blur, together
with the `maxlength` limit and the separator exception above. No site-specific rule
or wait is added.
