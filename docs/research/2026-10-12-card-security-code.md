# Card security code after login

Researched: 2026-10-12, from the repository at `5d3904a` (main). Nothing was built or
tested in a browser. On 2026-10-12 the owner reported that on エポスNet
(`https://www.eposcard.co.jp`) Pateat filled the ID and password and the next page asked
for the card's security code, where the login stopped. The owner keeps the card in
Bitwarden as a card item and asked whether Pateat could take the code from there, and
whether linking a site to the right card would be too much work. The owner said it can
wait (2026-10-12 04:18 UTC). This note is a feasibility check, not a decision or a
design.

## What Pateat reads today

- The crypto Worker already decrypts card items. It accepts item types 1 to 4 (login,
  secure note, card, identity) and builds a field snapshot for each
  (`apps/extension/src/crypto/worker.ts`). The field resolver lists
  `card.cardholderName`, `card.expMonth`, `card.expYear`, `card.code`, `card.brand` and
  `card.number`, all as kind `text` (`packages/bitwarden/src/fields.ts`). No SDK change
  or new SDK call is needed to read `card.code`.
- Only login items have URIs, so a card item is never a site candidate. An account
  binding names one vault item
  ([ADR 0013](../adr/0013-service-held-recipes-and-settings.md#recipes-and-account-bindings)),
  and a recipe slot can only read a field of that login item. Nothing can read a field
  of a second item today.
- A Hidden custom field on the login item is already offered to generation as a
  `hidden` slot (`apps/extension/src/login/generation-slots.ts`) and may fill a
  password input or a short numeric input (`apps/extension/src/login/inputs.ts`). A
  3- or 4-digit code fits that rule.
- A page after the password step that asks for something else is judged `challenge`.
  Without a handler for it the login ends `challenge`
  ([ADR 0027](../adr/0027-per-account-login-routes.md)); the only handlers are `passkey`
  and `totp`. So even a code copied into a Hidden custom field would not be filled on
  エポスNet's second page today (inferred from ADR 0027; not tried on the site).

## What it would take

1. **A handler for a code page.** Like the `totp` handler, the judge would name the
   code field and its submit button on a `challenge` page, and the handler would fill a
   value from the vault once per login. It shares one piece with ADR 0027 delivery 4's
   deferred part, a `totp` handler that reads a field the binding names: a binding that
   names a field for a handler. The rest differs. That deferred part has to make a code
   from a TOTP seed and fill it under the TOTP rule, while a card code is a raw value
   filled under the Hidden-field rule.
2. **A fill rule for card values.** `card.code` is kind `text` in the snapshot, so it
   would need the Hidden-field rule (password or short numeric input only), and
   `card.number` stricter rules or none (see the
   [personal-data note](2026-10-11-personal-data-autofill.md#fit-with-pateats-design)).
3. **A link from the site to the card**, one of:

| Option | What is stored | Tradeoff |
| --- | --- | --- |
| A. Copy the code into a Hidden custom field of the login item | Nothing new; the binding names the field (`{ "custom": "セキュリティコード" }`) | Works with step 1 alone and needs no second item. The code is kept twice, and a reissued card leaves a stale copy |
| B. A Text custom field on the login item that names the card item (`pateat-card` = `エポスカード`) | The field name, as for any binding | The owner sets it once in Bitwarden. A name that matches no card item, or several, must stop the step |
| C. Ask once in the popup and remember, as account choice does ([ADR 0021](../adr/0021-account-choice-outside-settings.md)) | A second item reference in the binding, e.g. `{ "slot": "card-code", "itemId": "<card item UUID>", "itemName": "エポスカード", "field": "card.code" }` | No Bitwarden edit; synced like other item references ([ADR 0023](../adr/0023-synced-vault-policy.md)). Needs a card chooser and a binding shape change |
| D. Match by brand or issuer | Nothing | Bitwarden cards have `brand` (`Visa`, `JCB`, …) but no issuer, so only the item name could hint at エポス. A wrong card spends a code attempt, and card sites lock accounts after a few. Only useful to preselect a choice in C |

The service and the AI would see no card value in any option. As for other slots, the
AI would receive field names (such as a custom field named `セキュリティコード` in option
A) and never values; the service would store, at most, the card item's ID and name in
the owner's binding.

## Other sites

Only エポスNet has asked for a card value at login so far. Whether other card sites
(Vpass, MyJCB, My Digital Connect, JP BANKカードWEB, Global Pass) ask for one at login
was not checked.

## Recommendation

Leave it for later, as the owner said. When it is built, the binding that names a field
for a handler can be designed once for both step 1 and the deferred `totp` binding
field; option A then needs only the handler and no link to a second item. Option C is
the one to design if keeping the code only in the card item matters, with D at most
preselecting the card in the chooser.
