# Personal-data autofill

Researched: 2026-10-11, from public documentation, the official Bitwarden clients
source at `df96418` (main as fetched on 2026-10-11) and the pinned
`@bitwarden/sdk-internal@0.2.0-main.1100` type declarations. Nothing below was
tested in a browser. It answers the owner's request of 2026-10-11 to research the scope
of personal-data autofill and the existing extensions for it. It is not a decision:
Pateat implements none of it, and nothing here grants a capability. A follow-up the
same day, asked for by the owner, looked closer at Japanese forms
([Japanese forms](#japanese-forms)); it used Chromium main at `4afca57` and read the
code of the extensions named there without installing or running them.

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
  The keywords taken from the page are reduced to `[a-zA-Z0-9]` before matching, so a
  label such as `フリガナ`, `氏名` or `郵便番号` becomes an empty string and matches
  nothing (see [Japanese forms](#japanese-forms)). The community workaround is a custom
  field named after the input's `id`
  ([forum](https://community.bitwarden.com/t/autofill-of-my-name-address-etc-is-not-happening/55346)).
- Beside the heuristics, the clients contain "Fill Assist" targeting rules: a per-domain
  forms map fetched every 6 hours from `https://fillassist.bitwarden.com`, with card,
  identity and address qualifiers including birth date and split phone parts
  ([`targeting-rules-data.service.ts`](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/autofill/services/targeting-rules-data.service.ts)).
  It is behind the feature flag `fill-assist-targeting-rules` (default off), an
  organization policy and a user setting. It is the closest Bitwarden counterpart to
  Pateat's per-site recipes. The forms map published on 2026-10-08 (build
  `v20261008.1`) holds 32 hosts, none under `.jp`.
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
part of the page; see [Browser agents](#browser-agents)).

### Other extensions

- Other password managers have identity items too, but read only their own vaults, and
  Pateat supports Bitwarden only. Their Japanese support is covered under
  [Japanese forms](#japanese-forms).
- Rule-based form fillers keep their own profile store. The two policies checked first
  state local or Chrome-sync storage, with an encryption key stored next to the data
  ([Smart IP AutoFill policy](https://sites.google.com/view/smartipautofill/home)) or
  unspecified encryption
  ([Easy Autofill](https://extensionauditor.com/scan/easy-autofill-secure-profile-based-fill-out-and-fo-djbjhloefcdkjfpcbibdfoajmcddmcle)).
  They duplicate the personal data outside the vault, with weak or unstated key
  storage. Lightning Autofill (about 600,000 users) and AutoFill Forms (about 100,000)
  fill from rules the user writes.
- A first Japanese web search (`フォーム 自動入力 Chrome 拡張機能 住所 フリガナ`) found
  no Japanese-specific form filler of note. The closer search in
  [Form-filler extensions](#form-filler-extensions) supersedes it: small ones exist.

## Japanese forms

The owner sees Japanese forms as a good fit for Pateat rather than Bitwarden or Chrome:
furigana fields and addresses split across several inputs. A typical sign-up form asks
for:

```text
姓 [山田]  名 [太郎]
セイ [ヤマダ]  メイ [タロウ]            (or ふりがな in hiragana, or one field)
郵便番号 [123]-[4567]                   (or one field, often with a lookup script)
都道府県 <select: 東京都 …>
市区町村 [千代田区]  番地 [1-2-3]  建物名 [サンプルビル101]
電話番号 [03]-[1234]-[5678]
生年月日 <select 年> <select 月> <select 日>
```

The values above are synthetic. Pateat's own corpus and tests use synthetic data only.

### Chrome on Japanese forms

Documented by Google and tested by others:

- Name readings. Chrome fills family, given and full readings when the labels or `name`
  attributes show them (`セイ`, `メイ`, `セイメイ`, `姓ふりがな`, `family-name-phonetic`
  and similar), in katakana when the label contains katakana and in hiragana otherwise
  ([Chrome developers, 2026-04-15](https://developer.chrome.com/blog/japanese-phonetic-name-autofill)).
  A press report says Chrome 147 on Windows, Mac, ChromeOS and Android, rolled out in
  stages ([helentech, 2026-04-24](https://helentech.jp/news-chrome-85295/)); Google
  gives no version.
- A test in Chrome 147 on macOS filled `セイ`/`メイ` and `せい`/`めい` fields and
  `*_kana` inputs labelled `姓（フリガナ）`. `autocomplete="furigana"` stopped the
  whole form from filling, kanji name fields included, and vague labels got no
  suggestion. A single reading field was not tested
  ([Classmethod, 2026-04-28](https://dev.classmethod.jp/articles/chrome-japanese-phonetic-name-autofill/)).
- Addresses. On the Apple Store and Google Store Japan forms, Chrome on Android filled
  the prefecture but not the city or the building name; on Apple the city went into the
  first address line. Safari on iOS filled both forms
  ([knis, 2022, updated 2023-05-17](https://blog.knis.jp/autocomplete/)). No 2025 or
  2026 measurement of Japanese addresses was found.

In the source:

- Chromium has address models for AU, BR, CA, DE, FR, IN, IT, MX, NL, PL and US and a
  generic one, but none for Japan (`kAutofillModelRules`). Google's address data for
  Japan has no city field
  ([`fmt 〒%Z%n%S%n%A%n%O%n%N`](https://www.gstatic.com/chrome/autofill/libaddressinput/chromium-i18n/ssl-address/data/JP)),
  so `市区町村` has no stored value of its own.
- A Japan-only rule for postal codes split into 3 + 4 inputs (with an optional `〒` and
  full-width digits) exists but is behind `kAutofillSupportSplitZipCode`, which is
  disabled by default (`autofill_features.cc`); whether a field trial enables it was not
  found.
- Split phone inputs are classified by US-oriented grammars (3/3/4, with `maxlength`
  limits), and the local number is split into a 4-digit suffix and a prefix. Inferred:
  a 4-digit middle input such as `03`-`1234`-`5678` may not be recognised. Not tested.
- No conversion to full-width digits on fill was found.

Open bug reports on the [Chromium tracker](https://issues.chromium.org/) (status as
returned on 2026-10-11):

- [338601199](https://issues.chromium.org/issues/338601199) "Autofill doesn't work well
  for Japanese websites", assigned, filed 2024-05-04, last updated 2025-12-03: family
  and given names swapped and the same partial address repeated across lines on IKEA
  Japan.
- [40216608](https://issues.chromium.org/issues/40216608) "Japanese address data is
  missing 'City'", assigned, filed 2022-02-28 against Chrome 99, last updated
  2026-06-25.
- [40144549](https://issues.chromium.org/issues/40144549) "Support phonetic names in
  Chrome Autofill", still assigned (filed 2020-08-13) although readings shipped.

### Bitwarden on Japanese forms

From the source at `df96418` (`autofill.service.ts`; inferred effects were not tested
in a browser):

- Japanese labels never match: page keywords are reduced to `[a-zA-Z0-9]`
  ([L2003-L2010](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/autofill/services/autofill.service.ts#L2003-L2010)),
  so only ASCII attribute and label text can (`id`, `name`, `autocomplete`, `type`,
  ASCII parts of labels and placeholders).
- Matching is by substring, and the checks meant to fill a kind of field once
  (`!filledFields.postalCode`, `!filledFields.phone`, `!filledFields.address`) never
  stop a second match: `filledFields` is keyed by Bitwarden's internal field ID such as
  `__12`, so `filledFields.postalCode` is always undefined.
  Inferred: `zip1` and `zip2` both get the whole postal code, `tel1` to `tel3` the whole
  phone number, and `last_name_kana` the kanji family name. Bitwarden's open issue
  [#23356](https://github.com/bitwarden/clients/issues/23356) (2026-09-22) reports the
  same flaws on another site, with two unmerged community fixes.
- A `maxlength` does not shorten the value
  ([`fillByOpid`](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/autofill/services/autofill.service.ts#L3136-L3138)
  truncates to the value's own length).
- A full-name field gets `first middle last`, never family name first; a generic
  address field gets `address1, address2, address3`.
- The state is filled only when it has 2 characters or fewer, or is a US or Canadian
  name
  ([`makeIdentityStateFillScript`](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/autofill/services/autofill.service.ts#L2393-L2415)),
  so a stored `東京都` is never filled, as text or as a `<select>` option (`東京` would
  be filled as text). The state keywords hold no `pref` or `prefecture`, so a
  `name="pref"` input is matched only through `autocomplete="address-level1"`.
- No full-width/half-width conversion exists.
- Custom fields reach Japanese labels: a custom field whose name equals an input's
  `id`, `name`, label or placeholder (for example `フリガナ`), or uses a `label=`,
  `regex=` or `csv=` prefix, is filled first. Inferred: the identity heuristics do not
  skip inputs a custom field already filled, so a custom field on `last_name_kana` is
  then overwritten by the family name. The reporter of
  [#2286](https://github.com/bitwarden/clients/issues/2286) saw a custom field fail the
  same way on a card form.

Reports and requests: GitHub and community searches for furigana, kana, prefecture and
split postal codes or phone numbers found none. The closest are
[Add missing fields in Identity item types](https://community.bitwarden.com/t/163)
(birthday, gender; 2018, open, 28 votes) and
[Customizable vault item templates](https://community.bitwarden.com/t/1959) (2018,
open, 209 votes). The one Japanese-form bug found,
[#2286](https://github.com/bitwarden/clients/issues/2286) (a card expiry on Stripe's
Japanese form), was closed as stale in 2025.

### Other password managers

- Proton Pass identities have no reading field; first and last names are split from the
  full name on spaces, and each field kind fills once per form section, so only the
  first input of a split postal code or phone number is filled (source: `item-v1.proto`
  and `autofill.identity.ts` in
  [ProtonMail/WebClients](https://github.com/ProtonMail/WebClients) at `c8393e3`). Its
  field detection holds German, French and Spanish words but no Japanese.
- 1Password documents no reading field or Japanese address format
  ([item categories](https://support.1password.com/item-categories/)). No
  documentation or user report about Japanese forms was found for Dashlane, NordPass or
  Keeper.

### Form-filler extensions

Checked on the Chrome Web Store on 2026-10-11, reading each package's `manifest.json`
and code:

| Extension | Users, updated | How it finds fields | Japanese handling | Storage |
| --- | --- | --- | --- | --- |
| [Lightning Autofill](https://chromewebstore.google.com/detail/nlmmgnhgdeffjkdckmikfpnddkbbfkkk) | ~600k, 2025-11 | Rules the user writes (text, regex, CSS, XPath) | None built in | Local, "not encrypted" per the listing; paid sync to Google Sheets |
| [AutoFill Forms](https://chromewebstore.google.com/detail/focmhibpdifbdjacabpgnifhdalgfogg) | ~100k, 2025-11 | Regex profiles | None found | `chrome.storage.local`, plaintext (inferred) |
| [SimpleFill](https://chromewebstore.google.com/detail/pjdkmeabgpggjenaichdfjhdckcejjik) | ~8k, 2025-06 | None; the user picks a value per field | Manual | Local |
| [Inquiry Assist](https://chromewebstore.google.com/detail/oaefgonljjamdngmmdjjajfnbgjibahm) | 80, 2025-11, paid | Fixed Japanese keyword lists | Readings in katakana or hiragana | Local and sync; built for sending contact-form sales messages |
| [就活フォーム自動入力](https://chromewebstore.google.com/detail/hbnndiicbpcaacoknnhjincbhhdlebjb) | 3, 2026-06 | Label text near the input, regex by priority ([write-up](https://dev.to/bokuwalily/building-a-local-only-chrome-extension-that-autofills-job-application-forms-4f8a)) | Readings with width conversion, postal 3 + 4, phone splits, birth-date selects | `chrome.storage.local`, plaintext (inferred) |
| [Formin_free](https://chromewebstore.google.com/detail/camnmhjpllcibkgcpfoaimfkjimpojam) | 424, 2026-04 | Up to 16 items the user labels, and replay of past entries per URL | None found | `chrome.storage.sync` |
| [Fillify](https://chromewebstore.google.com/detail/mhhcjilkgnegleamofnbeacpnblblkhn) | ~1k, 2026-06 | An LLM with the user's API key | None found | Mostly sync; page content goes to the LLM provider |

No widely used extension handles Japanese readings and split fields. The one with the
most complete Japanese handling has 3 users. Every one keeps the personal data in its
own store, mostly unencrypted, and most inject a script into every page.

### Site scripts that change fields

- [YubinBango](https://github.com/yubinbango/yubinbango) looks up the address on
  `keyup` of the postal-code input only, so a value set by a script with `input` and
  `change` events triggers no lookup. When a lookup runs, it first empties the
  prefecture, city, street and building inputs, so anything filled before is lost.
- [ajaxzip3](https://github.com/ajaxzip3/ajaxzip3.github.io) is usually called from an
  inline `onKeyUp` and overwrites the named fields once 7 digits are present.
- Automatic reading scripts such as vanilla-autokana derive the reading from IME key
  input while the name field has focus. Inferred from the code: a name set by a script
  produces no reading, and focusing the field later can change the reading field.
- Japanese entry-form optimisation services (Gyro-n EFO, f-tra EFO, EFO CUBE) list
  postal-code lookup, automatic readings and full/half-width conversion
  ([ITreview](https://www.itreview.jp/products/gyro-n-efo/feature)); how they react to
  script fills was not found.

So a script fill that sends only `input` and `change` events triggers no lookup on these
keyup-based scripts, and every address part has to come from the vault. If a lookup can
run (the filler sends key events, or the site listens for `input` or `change`), the
postal code has to be filled first and the lookup awaited, because the lookup empties
the address inputs. The reading needs its own value rather than relying on the page to
derive it.

### Browser agents

- [Claude in Chrome](https://support.claude.com/en/articles/12902428-using-claude-in-chrome-safely)
  works from screenshots of the tab and asks before entering sensitive information.
- Gemini's form filling in Chrome Canary draws on Chrome's autofill data, opt-in
  ([PiunikaWeb, 2026-07-21](https://piunikaweb.com/2026/07/21/chrome-gemini-fill-forms-gmail-photos/)).
- At launch, ChatGPT Atlas's agent mode could not use saved passwords or autofill data
  ([Simon Willison, 2025-10-21](https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/)).
- Chrome's suggestion list is browser UI, not page content. The DevTools protocol's
  `Autofill.trigger` fills only data the caller passes in, and extensions' debugger
  access does not include that domain
  ([chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)).
  Inferred: an extension-driven agent cannot pick Chrome's saved addresses.

None of them documents handling of readings or split fields.

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
- **Japanese forms are the hard part**, and the part existing tools cover least (see
  [Japanese forms](#japanese-forms)): split postal codes and phone numbers, a prefecture
  `<select>`, readings in katakana or hiragana, family name first, width conversion, and
  postal-code lookups that, when they run, empty and rewrite the address. A recipe would
  name each input's part (for example `identity.postalCode` digits 1-3 and 4-7), the
  step order and a wait, as for login forms that appear later
  ([ADR 0013, recipe lookup](../adr/0013-service-held-recipes-and-settings.md#recipe-lookup)).
- **Card forms in third-party frames.** Payment providers render card inputs in their
  own cross-origin frames. [ADR 0017](../adr/0017-login-forms-in-frames.md) fills a
  frame only when both the frame URL and the tab URL match the chosen item's URIs, and
  cards have no URIs, so that rule does not carry over. A card recipe would need an
  equivalent that binds the tab's origin (from the recipe) and an explicitly allowed
  provider-frame origin.

## Recommendation

Keep it out of the current work, but treat Japanese forms as the first candidate if
identity filling is designed later:

- Japanese forms are a real gap. The official Bitwarden extension cannot match a
  Japanese label, fills split inputs with whole values and skips the prefecture.
  Chrome fills readings since 2026 but has no Japanese address model, no city value and
  split postal codes behind a disabled flag, with Japanese bug reports open since 2022
  and 2024. No widely used extension covers them. This supports the owner's view that
  Japanese forms are where Pateat could add the most: AI-generated recipes that name
  each input's part and the fill order, which could be filled from the Bitwarden
  vault. Bitwarden identities lack a reading and a birth date, so those values would
  come from custom fields on the identity item.
- Elsewhere, existing options are enough for forms a person fills: Chrome's built-in
  autofill for names, and the official Bitwarden extension for cards and
  generated passwords. Forms a browser agent operates are the case
  [ADR 0001](../adr/0001-local-login-boundary.md) already found the official autofill
  and interactive extension UI unreliable for, and an extension-driven agent cannot pick
  Chrome's saved addresses (inferred above). Whether agents stall on sign-up or
  checkout forms in daily use would show how much that matters.
- Generated passwords belong with Bitwarden writeback. When vault create/update is
  built, a candidate is the SDK's `GeneratorClient` (already part of the approved SDK,
  [ADR 0005](../adr/0005-bitwarden-local-crypto.md)), honouring `passwordrules` through
  `password_rules`, with the new login saved in the same step. Without writeback, a
  Pateat-generated password would be lost or would need the official extension to save
  it. Email aliases from forwarders (SimpleLogin, addy.io and the others) would bring in
  third-party providers with their own API tokens, which is an owner choice.
- A design would start from a corpus of real Japanese sign-up and address forms, as the
  login work did, and needs the owner's approval before any ADR or code.
