# ADR 0061: Personal details asked during a login, filled from a linked vault item

Status: accepted by the owner on 2026-10-23 ([decided](#decided-by-the-owner) 6 to 11).
Claude built it ahead of those decisions on best guesses, as the owner asked at 05:28
UTC. The design was reviewed against the code by another AI before it was built.
Deliveries 1, 2, 3 and 4 are implemented; the others are not ([Delivery](#delivery)).
Implements the
[phase 2](../plan.md#phase-2-use-it-and-fix-what-comes-up) item on personal details
asked for during a login. Amends [ADR 0027](0027-per-account-login-routes.md) (a fourth
handler kind, what the judge may name, and which pages are judged),
[ADR 0013](0013-service-held-recipes-and-settings.md) (the owner's settings link a login
item to the items that hold its details) and
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
   site once the owner confirms it (05:27 UTC). So each link is confirmed once, not at
   every login, and a link belongs to one site and one login item: two accounts on a
   site are linked separately.
3. The link is stored like an account binding, in the owner's settings on the service,
   never in a shared recipe ([plan](../plan.md#phase-2-use-it-and-fix-what-comes-up)).
4. Each kind of value has its own fill rule, as passwords and TOTP codes have; a card
   code goes only into a password or short numeric input.
5. Values never leave the device; the service and the AI see only which kind of value a
   page asks for.
6. A link may name a custom field, and the field's name is stored in the owner's
   settings on the service as binding references are, even when the name says something
   about the person, as a field named after its secret question does (2026-10-23 11:17
   UTC, 「このままでよい」).
7. Every model call gets the same account information unless a reason to differ is
   recorded (11:19 UTC:
   「ページによって送る情報変えてるとか、妥当な理由が無ければ全部直して」). Delivery 6
   gives the judge the account's slots, as generation has them.
8. Every linked value is filled automatically, whole card numbers, expiry dates and PINs
   included (11:41:30 UTC, choosing the option 「全部」: 「2. a.
   全部いれていい基本。ただしログインしてるかの追跡はログアウト後の自動ログインやめる(別で検討中)でも残るはずなので、ログイン完了後の確認画面で自動入力までに止めるのはそのままでいいと思います、たぶん」).
   A confirmation screen after a completed login is unchanged: Pateat still stops at the
   fill there. Delivery 5 adds those values.
9. A page that shows the sign-in form again with a detail form beside it is judged
   (12:25 UTC, 「判定に送る」), amending ADR 0027's rule that a page showing a route
   fill field is never judged ([below](#judging-a-page-beside-the-sign-in-form)).
10. A value split over several inputs is filled, a birth date in year, month and day
    selects and a card number, PIN or expiry date over several boxes included (12:26
    UTC, 「全部入れる」). Delivery 8 builds it.
11. The guess of the vault item also compares the masked last four digits and the card
    brand that the page shows with the vault's cards, on the device (12:26 UTC,
    「下 4 桁とブランドも見る」). Delivery 7 builds it.

## Decision

### The values Pateat knows

A fixed list, so the service can check every handler and the extension knows how to
make each value. A page that asks for anything else stays `challenge`.

| `detail` | Read from | Filled as | Into |
| --- | --- | --- | --- |
| `birth-date` | a Text or Hidden custom field named as one (below) | the date in the input's `format` | a text, tel or number input |
| `phone-last-4` | `identity.phone`, or a Text or Hidden custom field named as one (below) | its last four digits | a text, tel or number input |
| `card-last-4` | `card.number` | its last four digits | a text, tel or number input |
| `card-code` | `card.code` | as it is, 3 or 4 digits | a password input, or a text or tel input with `maxlength` 3 or 4 |
| `secret-answer` | a Text or Hidden custom field of the login item named as the question (below) | as it is, trimmed, 1 to 128 characters | a text or password input |
| `member-id` | a Text or Hidden custom field of the login item named as a member ID (below) | as it is, trimmed, 1 to 64 characters | a text, tel or number input |

These rules replace the Hidden-field rule for these values: a birth date kept in a
Hidden field may go into a text input. `format` is one of `yyyymmdd`, `yyyymm`,
`yyyy-mm-dd`, `yyyy/mm/dd` and `mmdd`. A stored birth date is read, after NFKC, as year,
month and day from `1990-04-01`, `1990/4/1`, `1990.04.01`, `1990年4月1日` or
`19900401`; any other text is not a date. Digits are what is left after removing all
but ASCII digits (after NFKC); fewer than four is not a value. The value is made in the
service worker right after the vault read: the whole phone or card number never reaches
the page's content script.

### Secret-question answers and member IDs

Claude added both on the recipe-schema plan's §2.6 (its option b); decided 6 and 8 keep
them. Bitwarden keeps neither in a fixed field, so both are read only from custom fields
of the login item itself, never another item, and only after the owner confirmed the
field in the popup once (as every link). A Hidden field may fill a visible input here
too, an exception to [ADR 0013](0013-service-held-recipes-and-settings.md)'s
Hidden-field rule like the birth date's.

- `member-id`: a field whose name, after NFKC and without case, holds `id`, `number`,
  `no`, `番号`, `会員`, `お客様`, `customer`, `member` or `契約`, and none of `暗証`,
  `pin`, `pass`, `パスワード`, `code`, `コード`, `card`, `カード`, `phone`, `電話`,
  `hidden` or `note`. The popup proposes these fields but selects none, as their names
  say little.
- `secret-answer`: people name the field after its question (a Hidden field named
  「母親の旧姓は？」). The link names the field, as bindings do; no question text is
  stored anywhere new. A site that asks one of several questions has one link per
  question field, and the settings' duplicate check keys `secret-answer` links by field.
- Which answer: the worker sends the names of the linked fields to the input's document
  (`login.detail.question`); the document answers which one is shown. It reads the
  rendered text of the input's nearest ancestor that holds no other fillable input,
  stopping at the form, at most 4,000 characters; it compares both after NFKC, without
  case, with curly apostrophes made straight, white space collapsed and a trailing `?`
  or `:` removed. The longest name of at least 4 characters contained in that text is
  the question; none, or two of that length, fills nothing and the login ends
  `challenge` (`detail-unlinked`), so a generic label such as 「回答」 never picks an
  answer. Page text never leaves the document.
- The fill carries the field's name, and the content script checks again, in the same
  task as the typing, that the input still asks it, so a question changed between the
  read and the fill gets no answer.
- The popup offers, for an answer input, only the login item's field named as the
  page's question; a page whose question matches no field name offers none, so the
  field must be named after the question.
- Refusal: the handler's page shown again after an answer is a refusal of that answer
  only while the page asks the same question, or one the item has no field for. A page
  that now asks another of the item's questions keeps the first link, ends `challenge`,
  and the popup proposes the field for the new question. A rejected login removes the
  answer link it used, as for every detail.
- The judge names `secret-answer` for an input that asks the answer to a question shown
  on the page, and `member-id` for a member, customer or contract number that is not
  the account's sign-in ID. An answer input located by its label is refused
  (`label-locator`): the label may be the account's own question, which a shared recipe
  never holds.

Security notes:

- The model picks the page input; the content script checks only its type, its
  `maxlength`, that it is no sign-in field and, for an answer, that the question beside
  it is the field's name. An answer can still land in an input that shows it on screen.
- A compromised page on the same origin (XSS) can read a filled value, as it can read a
  password today, and could show another question's text to obtain that answer; an
  answer goes only beside its own question's text.
- Links are per login item and are not slots, so `templateLoginBinding`, which copies a
  binding's same-named slots to another account, never copies them: every account
  confirms its own fields.
- The names of the linked fields are stored in the owner's settings on the service as
  references, as binding references to custom fields already are. A field named after
  its question therefore puts the question's text on the service, though never the
  answer; decided 5 holds for values. The owner accepted this (decided 6).

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
  `username`, `email`, `current-password`, `new-password` or `one-time-code`, with a
  declared `maxlength`, when it has one, that holds the value (`yyyymm` needs 6), and in
  the button's form; no input or the button is a route step's element or fill field, the
  recipe's `totp` code field there, or another element the recipe checks; no input is
  the one the judge names as the page's code, sent or not, or one of a split code's
  inputs (`code-field`); no route step fills a slot named `detail`, the handler's own;
  and the path has no `detail` handler yet.

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
phone or card number, a card's expiry date, a PIN, a password or a code sent to the
person) has no `details`, that a birth date split over several inputs or written in a
form no `format` matches (a two-digit or era year, a separator it lacks) is none either,
and that a card's security code is a detail, never a `code`. Inputs that fail the checks
above are dropped and logged by reason, as `totpDropped` is. A paid run on synthetic
pages ([results](../research/2026-10-23-detail-judge-eval.md)) gave the expected answer
on every requested page with four model settings; the split-date line came from it.
Deliveries 5 and 8 widen what has `details`.

### Judging a page beside the sign-in form

Delivery 2 builds this.

After an effect step, a page that still shows a route fill field on a route path is not
judged today. It is judged when it also shows, in another form than every route fill
field, a text, tel or number input that is no route fill field, with a button in that
form. Only a `password` login without a chooser or a stop sends it, from the tab's top
document on the recipe's own origin, once its sign-in state is read and shows no failure
beside the sign-in fields. The request says so (`beside: true`). Like a stop's page
([ADR 0036](0036-passkey-after-the-identifier.md)), it is judged under its own prompt
version and instructions, and the service keeps only a `detail` handler from it: its
other answers, and a `challenge` that adds no `detail` handler, are kept and answered as
`unclear`. It is judged once per recipe revision, origin and path, as every page is.

A `detail` handler on a route path is not entered for the first time while the sign-in
form there shows a failure beside its fields: the password was wrong, and the login ends
`credential-rejected`.

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
   and under the rules above: identity items, and Text or Hidden custom fields whose
   name contains `phone`, `tel` or `電話`, for `phone-last-4`; Text or Hidden custom
   fields whose name reads as a birth date (contains `birth`, `dob`, `生年月日` or
   `誕生日`, in any case) for `birth-date`; card items for `card-last-4` and
   `card-code`. A link reads only such a field, so a link edited elsewhere never types
   another custom field, such as a PIN, into the page. An item whose name holds a run of
   three or more ASCII letters or digits found in the page's host name, or which appears
   whole in the page's title, comes first.
3. The popup's "This page" section shows what the page asks for and the candidates, the
   first one selected, for example "This page asks for your birth year and month." and
   "本人 › 生年月日", with **Fill**.
4. **Fill** fills the input in the tab's current document, checking its choosing radio,
   when that document is the login's, the tab's login is still the one that stopped
   there, the site and the login item are still allowed, and the page still shows the
   input writable and the button; it does not press the button. The person checks the
   value and submits. One link is kept per handler: a second **Fill**, as after choosing
   the other radio, replaces the first. The link is kept for that tab in
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
one is, the link stays in the settings and the log says so (`detail-kept`), but the
device uses it no more: it is kept in session storage as refused, and its removal is
tried again each time a login ends. Choosing the same detail's field again in the popup
lifts it.

### Logs

`login.handler` gains the `detail` kind and the outcomes `detail-manual` (never used
since card codes are filled; kept for a detail that a later owner decision stops
filling), `detail-unlinked`, `detail-unreadable` (the linked value is not a date or has
too few digits) and `detail-unavailable` (the vault could not give the linked value at
the fill); a login that meets either stops as a changed policy (`field-unavailable`).
About links it gains `detail-saved` (a link filled from the popup was saved after the
login was confirmed), `detail-not-saved` (it could not be written, as while another
tab's login runs; it is dropped), `detail-forgotten` (a refused value's link was
removed) and `detail-kept` (that removal could not be written now). The judge's log
keeps `details` with each ID that is not a candidate replaced by `?`. Never a value or
an item name.

## Delivery

1. The `detail` handler, the judge's `details`, and the extension ending such a login
   `challenge` with `detail-unlinked`.
2. Judging a page beside the sign-in form (`beside`, decided 9).
3. Links, the value rules, choice radios, the popup's proposal, and removal on refusal.
4. Secret-question answers and member IDs, read from the login item's custom fields.
5. Whole card numbers, card expiry dates and PINs (decided 8).
6. The judge's account slots (decided 7) and its secret-question pairing.
7. The card guess from the last digits and brand the page shows (decided 11).
8. Values split over several inputs and selects (decided 10).

## Not covered

- An input disabled until its radio is chosen is not entered while disabled.
- A value filled from the popup that the site refuses, when the person then types the
  right one in the same document and the login succeeds, is saved; the next login
  submits it once, and its refusal removes the link.
- No icon or badge says that the popup has a proposal; the login's ending as
  `challenge` is what shows ([ADR 0038](0038-login-status-badge.md)).
- Whether MUFG keeps the sidebar sign-in form shown behind the lightbox, and the order
  of its radios and inputs, needs a check in the owner's Chrome.
