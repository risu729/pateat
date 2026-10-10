# ADR 0010: Inference field hints and local fill checks

Status: accepted by the owner on 2026-10-10. The hint contract, shape derivation and
local value check are implemented offline in `packages/inference`. The vault adapter
does not supply hints yet, and the executor does not run either check yet.

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
