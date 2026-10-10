# ADR 0009: Field names and visible value shapes as inference hints

Status: accepted by the owner on 2026-10-10. The contract, shape derivation and local
value check are implemented offline in `packages/inference`; the vault adapter and
extension runtime do not supply hints yet.

Date: 2026-10-10

## Context

[ADR 0003](0003-service-and-ai.md) keeps vault values out of inference. With slot
meanings alone, a model cannot tell apart pages whose fields differ mainly by length,
such as an unlabeled bank login asking for a 3-digit branch number and a 7-digit
account number. Bitwarden custom fields carry user-chosen names, and Text fields are
shown in clear in the Bitwarden UI, unlike Hidden fields.

## Decision

A semantic slot may carry two optional hints:

- `fieldName`: the user's name for an allowed vault field. Only fields the item policy
  allows for filling contribute names. Names follow the observed-text bounds (1-120
  characters, no control, format or line separator characters). Users are assumed not
  to store credentials in field names; this is not enforced.
- `valueShape`: the UTF-16 length, the character classes present (ASCII digit, ASCII
  letter, ASCII symbol, fullwidth ASCII variant, whitespace, other) in a fixed
  canonical order, and whether the value is a valid email address. It never carries
  characters, their positions or their order. Only the login username and Bitwarden
  Text custom fields may supply a shape. Hidden fields, passwords and TOTP never do;
  a Linked field follows its source field's type. The contract rejects a shape on
  secret and one-time-code slots as a second guard.

Observations also carry page-declared `maxLength`, `minLength` and `inputMode`.
`pattern` is excluded because evaluating a page-supplied expression locally could
hang the caller.

Before filling, the trusted side checks a validated plan against the real values:
present and non-empty, within the page's length bounds, and a valid email or number
where the input type requires one. A mismatch stops the fill and is reported as a
`value-mismatch` abstention. Values stay local; the check never sends them anywhere.

## Consequences

Visible identifier values are no longer fully opaque to the provider: their length and
character classes are disclosed for every inference request that includes them. A
4-digit identifier reveals its length, which is accepted because Text fields are
already treated as non-secret. Secrets disclose nothing beyond their slot kind.

The local check catches swapped mappings and values the page would reject, but cannot
detect a wrong mapping between two inputs with identical constraints.

## Alternatives

- Values never leave, with no shape: safest, but loses the main signal on unlabeled
  numeric pages. The local check alone can stop a wrong fill but cannot help choose.
- Shapes for every field, including Hidden and passwords: rejected; length narrows a
  secret, and Hidden marks the user's intent to conceal.
- Sending page `pattern` and evaluating it locally: rejected for the hang risk above.
