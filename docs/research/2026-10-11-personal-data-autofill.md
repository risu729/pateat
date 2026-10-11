# Personal-data autofill

Researched: 2026-10-11, from public documentation, the official Bitwarden clients
source at `df96418` (main as fetched on 2026-10-11) and the pinned
`@bitwarden/sdk-internal@0.2.0-main.1100` type declarations. Nothing below was
tested in a browser. It answers the owner's request of 2026-10-11 to research the scope
of personal-data autofill and the existing extensions for it. It is not a decision:
Pateat implements none of it, and nothing here grants a capability.

## Scope

"Personal-data autofill" means filling forms that are not login forms with values the
owner already keeps:

| Kind | Typical forms | Values |
| --- | --- | --- |
| Contact and address | Sign-up, shipping, membership, reservation | Name, name reading (furigana), email, phone, postal code, prefecture/state, city, address lines, company |
| Payment card | Checkout | Card number, holder, expiry month/year, security code, brand |
| Identity documents | KYC, travel | Passport, licence or national ID numbers |
| New account credentials | Sign-up, password change | A generated password, a generated or aliased email/username |

Each kind differs from login in two ways that matter for Pateat:

- The form is not tied to an account Pateat already holds for that site. A login item
  is chosen by URI match; an address or card is used on any site, so the vault item
  cannot be chosen by the site's URI.
- The flow continues into an action Pateat must not take on its own. A checkout ends in
  a payment and a sign-up in an account creation; the
  [product boundary](../architecture.md#product-boundary) keeps transactions and
  approvals as separately authorized later capabilities.

### Bitwarden as the source

Pateat's field resolver already decrypts the Bitwarden card and identity item types and
lists their fields (`packages/bitwarden/src/fields.ts`):

```text
card.cardholderName, card.expMonth, card.expYear, card.code, card.brand, card.number
identity.title, identity.firstName, identity.middleName, identity.lastName,
identity.fullName (derived), identity.address1..3, identity.city, identity.state,
identity.postalCode, identity.country, identity.company, identity.email,
identity.phone, identity.ssn, identity.username, identity.passportNumber,
identity.licenseNumber
```

Bitwarden identities have no field for a name reading, a birth date or a gender, and
one `phone` field. Japanese forms often ask for all of these. Custom fields on the
identity item can hold them (for example a Text field named `セイ` with value
`ヤマダ`); Pateat already resolves custom fields by name in account bindings
([ADR 0013](../adr/0013-service-held-recipes-and-settings.md)).

The Bitwarden clients source and the pinned SDK also declare newer item types,
`BankAccount` (6), `DriversLicense` (7) and `Passport` (8); `Passport` has
`dateOfBirth`, `sex` and `nationalIdentificationNumber`, and `DriversLicense` has
`dateOfBirth`. In the clients they sit behind the feature flag
`pm-32009-new-item-types`, which defaults to off. Their server rollout was not checked,
and Pateat's resolver rejects every type above 4 (`packages/bitwarden/src/fields.ts`).

The pinned SDK also contains a generator that Pateat does not call yet:
`PasswordManagerClient.generator()` returns a `GeneratorClient` with `password()`,
`passphrase()` and `password_rules(rules)`, which turns an HTML `passwordrules`
attribute such as `required: upper; required: digit; minlength: 12;` into a
`PasswordGeneratorRequest`. The SDK declares a `UsernameGeneratorRequest` type
(random word, `+` subaddress, catch-all domain, or forwarders: addy.io, DuckDuckGo,
Firefox Relay, Fastmail, Forward Email, SimpleLogin) but the WASM `GeneratorClient`
exposes no method for it.

A generated password is only useful once it is saved. Pateat reads the vault only, and
vault create/update is later work with separate grants per connection
([ADR 0001](../adr/0001-local-login-boundary.md)). Password generation therefore
depends on Bitwarden writeback, which the plan already records as later work.

## Existing options

### Official Bitwarden extension

[Bitwarden autofills cards and identities](https://bitwarden.com/help/auto-fill-card-id/)
from the popup's Autofill suggestions and, once enabled under Settings → Autofill, from
the inline menu ("Display identities as suggestions", "Display cards as suggestions").
Cards and identities are filled when the user picks one (inferred: the SDK has
`autofillOnPageLoad` only on the login view). The inline menu also offers a generated
password on a new-password field and then offers to save the login
([help](https://bitwarden.com/help/auto-fill-browser/),
[announcement](https://www.helpnetsecurity.com/2024/11/26/bitwarden-autofill-passwords/)).
Its username generator supports `+` subaddresses, catch-all domains and the email
forwarders above
([generator help](https://bitwarden.com/help/generator/#username-types)).

Gaps seen in the source at `df96418`:

- Heuristic identity field detection uses keyword lists over attributes such as `id`,
  `name`, `autocomplete`, `placeholder` and labels, in English and some German
  ([`IdentityAutoFillConstants`](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/autofill/services/autofill-constants.ts#L517)).
  The heuristic keyword lists contain no Japanese keyword and nothing for name
  readings, so a field labelled `フリガナ` or `セイ` is not recognised by them. The
  community workaround is a custom field named after the input's `id`
  ([forum](https://community.bitwarden.com/t/autofill-of-my-name-address-etc-is-not-happening/55346)).
- Beside the heuristics, the clients contain "Fill Assist" targeting rules: a per-domain
  forms map fetched every 6 hours from `https://fillassist.bitwarden.com`, with card,
  identity and address qualifiers including birth date and split phone parts
  ([`targeting-rules-data.service.ts`](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/autofill/services/targeting-rules-data.service.ts)).
  It is behind the feature flag `fill-assist-targeting-rules` (default off), an
  organization policy and a user setting. It is the closest Bitwarden counterpart to
  Pateat's per-site recipes; its coverage of Japanese sites was not checked.
- The browser extension does not read the `passwordrules` attribute (no match for
  `passwordrules` in `apps/` or `libs/` outside the Keeper importer), although the SDK
  can parse it.
- The untrusted-frame check
  ([`inUntrustedIframe`](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/autofill/services/autofill.service.ts#L1507),
  called at lines 779 and 986) runs only for login items, so a card or identity fill
  into a frame of another origin shows no untrusted-frame warning. Payment providers'
  card frames are often where a card fill is wanted, so this is a tradeoff rather than
  a plain defect.

The official extension 2026.6.1 was installed in the owner's default Chrome profile on
2026-10-10
([evidence](2026-10-10-feasibility.md#installed-chrome-provider-session-check-2026-10-10)),
so these features were available next to Pateat then.

### Chrome's built-in autofill

Chrome fills names, addresses, email, phone and payment cards from the Chrome profile
or Google Account ([help](https://support.google.com/chrome/answer/142893)). Since April
2026 it stores a name reading in hiragana or katakana and fills furigana fields
([Google Japan blog, 2026-04-24](https://blog.google/intl/ja-jp/feed/google-chrome-autofill-kana/),
[Chrome developers, 2026-04-15](https://developer.chrome.com/blog/japanese-phonetic-name-autofill)).
The detection is heuristic: HTML has no `autocomplete` value for a reading, and with a
non-standard `autocomplete` value Chrome does not fall back to heuristics. Google's
announcement covers names only; it says nothing about Japanese postal codes or
prefectures. Loyalty cards and travel and vehicle data need the setting "smarter form
understanding" to be turned on
([Google, 2025-12-05](https://blog.google/products/chrome/autofill-improvements/)).
Google Password Manager offers a strong password on sign-up fields and saves it
([help](https://support.google.com/accounts/answer/6208650)).

Gaps: the data lives in Google, not Bitwarden, so it is a second copy to keep current,
and payment cards are kept in Google Wallet or on the device. Suggestions appear in
browser UI after a click in the field; whether a browser agent such as Claude in Chrome
can see and pick them was not checked (inferred: probably not, since the list is not
part of the page).

### Other extensions

- Other password managers have identity items too, for example Proton Pass
  ([browser extension help](https://proton.me/support/pass-browser-extension)), but
  read only their own vaults; Pateat supports Bitwarden only.
- Rule-based form fillers keep their own profile store. The two policies checked state
  local or Chrome-sync storage, with an encryption key stored next to the data
  ([Smart IP AutoFill policy](https://sites.google.com/view/smartipautofill/home)) or
  unspecified encryption
  ([Easy Autofill](https://extensionauditor.com/scan/easy-autofill-secure-profile-based-fill-out-and-fo-djbjhloefcdkjfpcbibdfoajmcddmcle)).
  They duplicate the personal data outside the vault, with weak or unstated key
  storage.
- A Japanese web search (`フォーム 自動入力 Chrome 拡張機能 住所 フリガナ`) found no
  Japanese-specific form-filler extension of note; the one technical write-up found
  points to Chrome's built-in autofill
  ([Classmethod, 2026](https://dev.classmethod.jp/articles/chrome-japanese-phonetic-name-autofill/)).

## Fit with Pateat's design

If Pateat added this later, the existing pieces would carry over as follows:

- **Values stay in Bitwarden.** Identity and card items, plus custom fields for what
  Bitwarden lacks, are the source. The service would hold only form structure and slot
  names, as recipes do
  ([ADR 0013](../adr/0013-service-held-recipes-and-settings.md)), and the per-user
  choice of which identity or card item fills a slot, like an account binding. Values
  never go to inference; per [ADR 0010](../adr/0010-inference-field-hints.md) only
  slot meanings, allowed field names and, for non-secret Text fields, a value shape
  (length and character classes) do. Whether built-in identity fields such as a 7-digit
  postal code would get a shape is open.
- **Fill rules need new destinations.** Today a provider password goes only into a
  password input and a TOTP code only into a one-time-code or short numeric input. A
  personal-data fill would need its own rules, for example `card.number` and
  `card.code` only into the form the recipe names, and `identity.ssn`,
  `identity.passportNumber` and `identity.licenseNumber` never without a per-slot
  allowance.
- **Fill without submit.** The executor would fill and stop. Clicking "Pay" or
  "Create account" is a transaction or account creation and stays a separately
  authorized later capability.
- **A separate capability.** Item choice cannot come from URI matching, so this is a
  new grant per connection and per item type, not an extension of login. Adding it must
  not let existing login recipes reach card or identity values.
- **Japanese forms are the hard part**, and the part existing tools cover least:
  postal codes split into 3 + 4 digits, a prefecture `<select>`, readings in katakana
  or hiragana, names split into family and given name, phone numbers split into three
  inputs, full-width versus half-width digits, and postal-code lookups that rewrite the
  prefecture and city after the postal code is typed (so the fill order and a wait
  matter, as for login forms that appear later
  ([ADR 0013, recipe lookup](../adr/0013-service-held-recipes-and-settings.md#recipe-lookup))).
- **Card forms in third-party frames.** Payment providers render card inputs in their
  own cross-origin frames. [ADR 0017](../adr/0017-login-forms-in-frames.md) fills a
  frame only when both the frame URL and the tab URL match the chosen item's URIs, and
  cards have no URIs, so that rule does not carry over. A card recipe would need an
  equivalent that binds the tab's origin (from the recipe) and an explicitly allowed
  provider-frame origin.

## Recommendation

Defer, and rely on existing options until then:

- Use Chrome's built-in autofill for names, readings and addresses, and the official
  Bitwarden extension for cards, identities and generated passwords. This holds for
  forms a person fills. Forms a browser agent operates are the case
  [ADR 0001](../adr/0001-local-login-boundary.md) already found the official autofill
  and interactive extension UI unreliable for; whether an agent can use Bitwarden's
  inline menu or Chrome's suggestions was not checked.
- Generated passwords belong with Bitwarden writeback. When vault create/update is
  built, a candidate is the SDK's `GeneratorClient` (already part of the approved SDK,
  [ADR 0005](../adr/0005-bitwarden-local-crypto.md)), honouring `passwordrules` through
  `password_rules`, with the new login saved in the same step. Without writeback, a
  Pateat-generated password would be lost or would need the official extension to save
  it. Email aliases from forwarders (SimpleLogin, addy.io and the others) would bring in
  third-party providers with their own API tokens, which is an owner choice.
- Reconsider identity and card fill as its own later capability when either of two
  things shows up in daily use: a browser agent (Claude in Chrome, ChatGPT in Chrome)
  stops at sign-up or checkout forms because it cannot use Chrome's or Bitwarden's
  suggestions, or Japanese forms keep failing with both. Pateat's possible advantage
  there is the same as for login: AI-generated recipes that handle Japanese form
  structure, filled from the Bitwarden vault without a click.
