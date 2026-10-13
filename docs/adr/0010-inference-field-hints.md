# ADR 0010: Inference field hints and local fill checks

Status: accepted by the owner on 2026-10-10. The hint contract, the shape derivation
and the local value check are implemented in `packages/contracts`. The executor runs
both checks. Automatic generation sends the username's shape when every matching item
agrees ([ADR 0016](0016-recipe-generation-trigger.md#username-shape)). Amended on
2026-10-11 by [ADR 0027](0027-per-account-login-routes.md) (implemented): generation
offers custom fields by `fieldName`, with `fieldPosition` (position and count) for a
name several of the item's custom fields share, and Text shapes when every matching item
agrees; Hidden fields are offered as a `hidden` slot kind, which never carries a shape.

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
