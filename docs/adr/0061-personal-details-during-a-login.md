# ADR 0061: Personal details asked during a login, filled from a linked vault item

Status: proposed by Claude on 2026-10-23 and not confirmed by the owner. The owner asked
on 2026-10-23 (05:28 UTC) for this work to go ahead on best guesses, left to the owner
to decide afterwards; each guess is listed under [Assumed](#assumed-not-confirmed), and
the owner's own decisions under [Decided by the owner](#decided-by-the-owner). The
design was reviewed against the code by another AI before it was built. Implements the
[phase 2](../plan.md#phase-2-use-it-and-fix-what-comes-up) item on personal details
asked for during a login, in parts (see [Delivery](#delivery)). Amends
[ADR 0027](0027-per-account-login-routes.md) (a fourth handler kind and what the judge
may name), [ADR 0013](0013-service-held-recipes-and-settings.md) (the owner's settings
link a login item to the items that hold its details) and
[ADR 0036](0036-passkey-after-the-identifier.md) (a second kind of page judged while it
still shows the sign-in form).

Date: 2026-10-23

## Context

Some sites ask for a fact about the person during a login, after the ID and password:

- MUFG Card NEWS+PLUS (`https://www2.cr.mufg.jp/newsplus/`, live DOM read on 2026-10-21
  for [#832](https://github.com/risu729/pateat/issues/832)): pressing ログイン copies
  the ID and password into hidden inputs of a second form in a lightbox,
  追加確認項目の入力:

  ```html
  <form id="loginFormNaviPU" action="/newsplus/loginaction.html" method="POST">
    <dl id="authID" style="display:none"> <input id="webId2" name="webId"> </dl>
    <dl id="authPW" style="display:none"> <input id="webPassword2" type="password" name="webPassword"> </dl>
    <input type="radio" name="webAddAuthType" value="2"> 生年月日（西暦）の生年月 <input name="webBirthDay" maxlength="6">
    <input type="radio" name="webAddAuthType" value="3"> 電話番号下4桁 <input name="webPhoneNum" maxlength="4">
    <input id="submit" type="submit" value="ログイン">
  </form>
  ```

  The sign-in form in the sidebar most likely still shows behind it.
- エポスNet asks for the card's security code after the password (owner, 2026-10-12).

Before this ADR such a page ended the login: a page that still shows the route's
sign-in fields is never judged (`sign-in-shown` in the extension, `not-judgeable` on the
service), and a judged page that asks for a detail gets no handler. The value is not in
the login item: Bitwarden keeps a phone number in an identity item (`identity.phone`), a
card's number and code in a card item (`card.number`, `card.code`), and has no birth
date field, so a birth date sits in a custom field, usually of an identity item. The
crypto Worker already decrypts identity and card items and lists their fields in the
catalog ([feasibility note](../research/2026-10-12-card-security-code.md)).

## Decided by the owner

1. Login-time personal details are one need: birth dates, card codes and similar facts
   asked as extra verification (2026-10-12 05:29 UTC). They belong to the `sign-in`
   page kind ([ADR 0035](0035-page-kinds-per-site.md), 21:12 UTC).
2. The value is in another item, so the login is linked to it. Pateat guesses the item
   from the site and what its pages show, proposes it, and records the choice for the
   site once the owner confirms it (05:27 UTC).
3. The link is stored like an account binding, in the owner's settings on the service,
   never in a shared recipe ([plan](../plan.md#phase-2-use-it-and-fix-what-comes-up)).
4. Each kind of value has its own fill rule, as passwords and TOTP codes have; a card
   code goes only into a password or short numeric input.
5. Values never leave the device; the service and the AI see only which kind of value a
   page asks for.

## Decision

### The values Pateat knows

A fixed list, so the service can check every handler and the extension knows how to
make each value. A page that asks for anything else stays `challenge`.

| `detail` | Read from | Filled as | Into |
| --- | --- | --- | --- |
| `birth-date` | a Text or Hidden custom field | the date in the input's `format` | a text, tel or number input |
| `phone-last-4` | `identity.phone`, or a Text or Hidden custom field | its last four digits | a text, tel, number or password input |
| `card-last-4` | `card.number` | its last four digits | a text, tel, number or password input |
| `card-code` | `card.code` | as it is, 3 or 4 digits | a password input, or a text, tel or number input with `maxlength` 3 or 4 |

These rules replace the Hidden-field rule for these values: a birth date kept in a
Hidden field may go into a text input. `format` is one of `yyyymmdd`, `yyyymm`,
`yyyy-mm-dd`, `yyyy/mm/dd` and `mmdd`. A stored birth date is read, after NFKC, as year,
month and day from `1990-04-01`, `1990/4/1`, `1990.04.01`, `1990年4月1日` or
`19900401`; any other text is not a date. Digits are what is left after removing all
but ASCII digits (after NFKC); fewer than four is not a value. The value is made in the
service worker right after the vault read: the whole phone or card number never reaches
the page's content script.

### A `detail` handler

```json
{
  "kind": "detail",
  "path": "/newsplus/",
  "fields": [
    { "detail": "birth-date", "format": "yyyymm", "target": { "by": "name", "value": "webBirthDay" } },
    { "detail": "phone-last-4", "target": { "by": "name", "value": "webPhoneNum" } }
  ],
  "target": { "by": "id", "value": "submit" }
}
```

- `fields` lists one to three inputs, each with the value it asks for. A page that
  offers a choice, as MUFG's radio buttons do, lists each input.
- It is entered as other handlers are: its path matches and its button shows. A login
  fills the first input whose detail it has a value for (below), and only that one; that
  input must be writable, the others need not show. The chosen input is recorded with
  the entered handler, so the attempt's plan is the same after a service worker restart.
- Its steps are a fill of that input and a click on `target`. A login that only fills
  ([ADR 0035](0035-page-kinds-per-site.md)) fills it and does not press the button.
- It runs at most once per login, so a value the site refuses is never retried in that
  login; see [Refused values](#refused-values) for later ones.
- It comes after the `totp` handler in the order of handlers shown together.
- The service keeps it only when every input is a fill-role input of the page that the
  table admits for its detail, located by an attribute or its visible name, not marked
  `username`, `current-password`, `new-password` or `one-time-code`, with a declared
  `maxlength`, when it has one, that holds the value (`yyyymm` needs 6), and in the
  button's form; no input or the button is a route step's element or fill field, the
  recipe's `totp` code field there, or another element the recipe checks; and the path
  has no `detail` handler yet.

### Choice radios

A radio button chooses an input when it belongs to a group of two or more radios with
the same `name` in the input's form, comes before the input in document order, and no
other radio and no text-like input lies between them. Filling a detail input checks its
choosing radio first, when it has one and it is not checked, in the same task as the
fill, with a `click` so the page's handlers run. This is a property of the fill, not a
recipe step, and it is not a submission. A page whose radios all come before their
inputs has no choosing radio, and its input is filled only if it is writable as it is.

### What the judge names

On a `challenge` page the judge may also answer:

```json
{ "details": [{ "field": "c3", "value": "birth-date", "format": "yyyymm" },
              { "field": "c4", "value": "phone-last-4" }],
  "detailSubmit": "c5" }
```

Its instructions say what each value is, that a page asking for anything else (a whole
number, a PIN, a password, a secret question or a code sent to the person) has no
`details`, and that a card's security code is a detail, never a `code`. Inputs that fail
the checks above are dropped and logged by reason, as `totpDropped` is.

### Judging a page beside the sign-in form

After an effect step, a page that still shows a route fill field on a route path is not
judged today. It is judged when it also shows, in another form than every route fill
field, a text, tel or number input that is no route fill field, with a button in that
form. The request says so (`beside: true`). Like a stop's page
([ADR 0036](0036-passkey-after-the-identifier.md)), it is judged under its own prompt
version and instructions, and the service keeps only a `detail` handler from it: its
other answers are kept as `unclear`. It is judged once per recipe revision, origin and
path, as every page is.

### The link to the value

The owner's settings gain `detailLinks`, one per login item, site and detail:

```json
{
  "origin": "https://www2.cr.mufg.jp",
  "provider": "bitwarden",
  "userId": "...",
  "itemId": "<login item>",
  "detail": "birth-date",
  "source": { "itemId": "<identity item>", "field": { "custom": "生年月日" } }
}
```

`field` is `identity.phone`, `card.number`, `card.code` or a custom field by name, as
binding references name them. A link is per site, not per recipe, so a new recipe for
the origin keeps it, and it exists before the first binding is saved. It holds no item
name: a card item's name often carries its last digits, so names are shown from the
device's catalog only.

The linked item belongs to the same vault account as the login item. It has no URIs, so
it is exempt from URI matching; the confirmed link is what lets the login read it. It
must still be one the device may use: selected, not excluded, not quarantined or under
review, not in the trash and not archived, and so must its field. Otherwise the link
counts as missing.

### Guess, propose, confirm

When a `detail` handler shows and no link has a value for any of its inputs:

1. The login ends `challenge`, as before, with `detail-unlinked` in the log. It is
   watched afterwards as such a login is ([ADR 0027](0027-per-account-login-routes.md)).
2. Pateat lists candidates locally from the catalog, in the login item's vault account
   and under the rules above: identity items for `phone-last-4`; Text or Hidden custom
   fields whose name reads as a birth date (contains `birth`, `dob`, `生年月日` or
   `誕生日`, in any case) for `birth-date`; card items for `card-last-4` and
   `card-code`. An item whose name holds a run of three or more ASCII letters or digits
   found in the page's host name, or which appears whole in the page's title, comes
   first.
3. The popup's "This page" section shows what the page asks for and the candidates, the
   first one selected, for example "This page asks for your birth year and month." and
   "本人 › 生年月日", with **Fill**.
4. **Fill** fills the input in the tab's current document, checking its choosing radio,
   when that document is the login's and still shows the handler; it does not press the
   button. The person checks the value and submits. The link is kept for that tab in
   session storage and saved to the owner's settings only when the watched login ends
   `authenticated`, as an account chosen in the popup is
   ([ADR 0023](0023-synced-vault-policy.md)); otherwise it is dropped.
5. The popup also lists the site's saved links, each with **Remove**.

The popup shows nothing more when there is no candidate; the person types the value.

### Refused values

A link whose fill the site refuses (the login ends `rejected`, or the handler's page
shows again after its fill) is removed from the owner's settings, so the next login asks
again instead of submitting the same value on a site that may lock the account. Like
saving an account choice, the write waits for no other tab's login in progress: while
one is, the link is kept and the log says so (`detail-kept`).

### Logs

`login.handler` gains the `detail` kind and the outcomes `detail-manual` (never used
since card codes are filled; kept for a detail that a later owner decision stops
filling), `detail-unlinked`, `detail-unreadable` (the linked value is not a date or has
too few digits) and `detail-unavailable` (the vault could not give the linked value at
the fill); a login that meets either stops as a changed policy (`field-unavailable`).
About links it gains `detail-saved` (a link filled from the popup was saved after the
login was confirmed), `detail-forgotten` (a refused value's link was removed) and
`detail-kept` (it could not be written now). The judge's log keeps `details` with each
ID that is not a candidate replaced by `?`. Never a value or an item name.

## Assumed (not confirmed)

1. The values are the four in the table. Secret-question answers and member numbers are
   not in it: Bitwarden keeps them in no fixed place, and they are not facts about the
   person.
2. Card security codes are filled after the one confirmation, as ADR 0035 and the plan
   record. The owner's open card on which values may be filled on a page after the
   submission was answered by assumption elsewhere as "no card code"; if the owner
   chooses that, `card-code` joins `manualDetails` and is learned but never filled.
3. One confirmation per link, not per login: the owner's "records the choice once the
   owner confirms it".
4. A link is per site and login item, so two accounts on one site are linked separately.
5. The guess reads only item and field names and the page's host name and title; masked
   card digits and card brands on the page are not read.
6. Birth dates split across year, month and day selects are not filled: Pateat fills no
   selects.

## Delivery

1. The `detail` handler, the judge's `details`, and the extension ending such a login
   `challenge` with `detail-unlinked`.
2. Judging a page beside the sign-in form (`beside`).
3. Links, the value rules, choice radios, the popup's proposal, and removal on refusal.

## Not covered

- An input disabled until its radio is chosen is not entered while disabled.
- No icon or badge says that the popup has a proposal; the login's ending as
  `challenge` is what shows ([ADR 0038](0038-login-status-badge.md)).
- Whether MUFG keeps the sidebar sign-in form shown behind the lightbox, and the order
  of its radios and inputs, needs a check in the owner's Chrome.
