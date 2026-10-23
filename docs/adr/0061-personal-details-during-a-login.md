# ADR 0061: Personal details asked during a login, filled from a linked vault item

Status: accepted by the owner on 2026-10-23 ([decided](#decided-by-the-owner) 6 to 11).
Claude built it ahead of those decisions on best guesses, as the owner asked at 05:28
UTC. The design was reviewed against the code by another AI before it was built.
Deliveries 1 to 6 are implemented; the others are not ([Delivery](#delivery)).
Implements the
[phase 2](../plan.md#phase-2-use-it-and-fix-what-comes-up) item on personal details
asked for during a login. Amends [ADR 0027](0027-per-account-login-routes.md) (a fourth
handler kind, what the judge may name, and which pages are judged),
[ADR 0013](0013-service-held-recipes-and-settings.md) (the owner's settings link a login
item to the items that hold its details) and
[ADR 0036](0036-passkey-after-the-identifier.md) (a second kind of page judged while it
still shows the sign-in form).

Amended on 2026-10-23 by [ADR 0060](0060-recipe-layouts.md) (recipe layouts, accepted
by the owner at 11:41 UTC; merged with this ADR by Claude, local tests only): a `detail`
handler is learned into the layout the login ran, or that chooser layout's branch, like
any other handler. "The path has no `detail` handler yet" and "judged once per recipe
revision, origin and path" hold per layout (and branch), a page beside the sign-in form
included, and the service records which judge call made the handler, under the beside
prompt version for such a page, as that layout's `handler:<i>` unit.

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
   「ページによって送る情報変えてるとか、妥当な理由が無ければ全部直して」). The judge
   therefore gets the account's slots as generation does
   ([below](#the-judge-gets-the-accounts-slots)).
8. Every linked value is filled automatically, whole card numbers, expiry dates and PINs
   included (11:41:30 UTC, choosing the option 「全部」: 「2. a.
   全部いれていい基本。ただしログインしてるかの追跡はログアウト後の自動ログインやめる(別で検討中)でも残るはずなので、ログイン完了後の確認画面で自動入力までに止めるのはそのままでいいと思います、たぶん」).
   A confirmation screen after a completed login is unchanged: Pateat still stops at the
   fill there. So a page that asks for a whole card number or a PIN now has a detail;
   `manualDetails` stays empty.
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
| `card-number` | `card.number` | all its digits, 12 to 19 | a password, text, tel or number input whose `maxlength`, when set, holds it |
| `card-expiry` | `card.expMonth` and `card.expYear` of the same card item | month and year in the input's `format` | a text, tel or number input |
| `pin` | a Text or Hidden custom field of the login item or a card item named as a PIN (below) | its digits, 4 to 12 | a password, text, tel or number input whose `maxlength`, when set, holds it |
| `secret-answer` | a Text or Hidden custom field of the login item named as the question (below) | as it is, trimmed, 1 to 128 characters | a text or password input |
| `member-id` | a Text or Hidden custom field of the login item named as a member ID (below) | as it is, trimmed, 1 to 64 characters | a text, tel or number input |

These rules replace the Hidden-field rule for these values: a birth date kept in a
Hidden field may go into a text input. A birth date's `format` is one of `yyyymmdd`,
`yyyymm`, `yyyy-mm-dd`, `yyyy/mm/dd` and `mmdd`, a card expiry's one of `mmyy`, `mm/yy`,
`mmyyyy` and `mm/yyyy`; the contracts refuse a format on another detail. A stored birth
date is read, after NFKC, as year, month and day from `1990-04-01`, `1990/4/1`,
`1990.04.01`, `1990年4月1日` or `19900401`; any other text is not a date. For the last
four digits and a card code, digits are what is left after removing all but ASCII digits
(after NFKC), and fewer than the value needs (four, or a card code's three) is no value.
A card number or a PIN must be written, after NFKC, as digits alone, perhaps grouped by
spaces or hyphens; any other text, such as `12ab34` or a note beside the PIN, is no
value, and so are fewer or more digits than the table allows. An expiry month is 1 to
12, and a two-digit year is 20yy. No value is unreadable (`detail-unreadable`). A format
written with `/` or `-` never goes into a number input, which takes digits only. The
value is made in the service worker right after the vault read: a whole phone number
never reaches the page's content script, and a whole card number reaches it only for a
`card-number` input's fill. A card number, expiry date or PIN split over several inputs
is no detail, as a split birth date is, and Pateat fills no selects.

### Card numbers, expiry dates and PINs

Added on decided 8. A `card-expiry` link reads two fields; its `source` names the card
item and `card.expMonth`, and the extension reads `card.expYear` from the same item, so
the link keeps the one-field shape and both fields must be allowed. A `pin` is read from
a Text or Hidden custom field whose name, after NFKC and without case, holds `pin` as a
word of its own (not "shipping"), `暗証` or `passcode`; no other detail but an answer
named after its question reads such a field, so a PIN never fills a member ID's, birth
date's or phone number's input. Claude chose to read a PIN only from the login item
itself or a card item, never an identity or another login item: a PIN is a credential
of one account or card, and another item's PIN belongs to another account. A card
number and a PIN fill under their own input rule (`card-number`, `pin`), so they may go
into a password input, which no other detail but a card code takes. In the content
script, as on the service, no detail goes into an input whose `autocomplete` names a
sign-in or code field (`username`, `email`, `current-password`, `new-password`,
`one-time-code`).

Security notes:

- The model picks the page input, and the content script checks only its type, its
  `maxlength` and that it is no sign-in field. A whole card number or a PIN may
  therefore land in a wrong input that shows it on screen, such as a second password
  input the judge takes for a PIN's.
- A compromised page on the same origin (XSS) can read a filled card number, expiry date
  or PIN, as it can read a password today.
- This ADR changes nothing about pages after a completed login: on a confirmation screen
  after the login completes, Pateat still stops at the fill (decided 8).

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
  「母親の旧姓は？」). The link names the field, as bindings do. A field named otherwise
  is linked through the judge's pairing (below), and its link then also stores the
  question (`question`, in the compared form below, 4 to 200 characters), synced like
  field names. A site that asks one of several questions has
  one link per question field; the settings' duplicate check keys `secret-answer` links
  by field and, for links with a `question`, by question too.
- Which answer: the worker sends, for each linked field, its stored `question` or,
  without one, its name, to the input's document (`login.detail.question`); the
  document answers which one is shown. A link with a `question` is never matched by its
  field's name. The document reads the rendered text of the input's nearest ancestor
  that holds no other fillable input, stopping at the form, at most 4,000 characters,
  and compares after NFKC, without case, with curly apostrophes made straight, white
  space collapsed and a trailing `?` or `:` removed. A name counts when that text
  contains it. A stored question counts only as one whole question: equal to one text
  block of the region (a block element's run of text, inline elements included), or to
  such a block without a label of at most 40 characters before its first colon, as in
  「秘密の質問：」 or "Security question:". A block ending in a colon is a label, and a
  part of a block never counts, so a label or a fragment such as "your" is no question.
  The longest one of at least 4 characters that counts picks its link; none, or two of
  that length, fills nothing and the login ends `challenge` (`detail-unlinked`), so a
  generic label such as 「回答」 never picks an answer. Page text never leaves the
  document.
- The fill carries the same name or question, and the content script checks again, in
  the same task as the typing, that the input still asks it, so a question changed
  between the read and the fill gets no answer. Nothing is fuzzy.
- The popup offers, for an answer input, the login item's field named as the page's
  question, or the field the judge paired with it.
- AI pairing, Claude's design under decided 7: since the judge gets the slots, it may
  pair a question with a field, and the owner confirms the pairing once in the popup,
  as every link. The judge's `details` entry for `secret-answer` may
  name a `slot` (an index into the sent slots) and `shown`, the whole question sentence
  copied from the page without a label before it. The service hands them back as
  `questions` (input, slot ID, question) only beside a kept `detail` handler; they never
  enter the recipe, whose handler names only detail kinds and targets
  ([ADR 0027](0027-per-account-login-routes.md)). The extension maps the slot to the
  login item's custom field and keeps the pairing in the tab's detail offer, in session,
  with `shown` trimmed for the popup only. The login ends `detail-unlinked`; the popup
  reads "This page asks 「…」" with that text and proposes the field. Nothing is filled
  until the owner presses **Fill**, which first checks that the page still shows the
  question, in its compared form, as one whole question. Once the login is confirmed,
  the link stores that compared form; later logins look for it in the same way with no
  model.
- Refusal: the handler's page shown again after an answer is a refusal of that answer
  only while the page asks the same question, or one the item has no field for. A page
  that now asks another of the item's questions keeps the first link, ends `challenge`,
  and the popup proposes the field for the new question. A rejected login removes the
  answer link it used, as for every detail.
- The judge names `secret-answer` for an input that asks the answer to a question shown
  on the page, and `member-id` for a member, customer or contract number that is not
  the account's sign-in ID; it compares the slots' names and shapes with the inputs'
  labels to tell them apart. An answer input located by its label is refused
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
  A stored `question` is the same kind of text and is synced the same way.
- The pairing is the model's guess. A wrong one fills nothing by itself: the owner sees
  the question and the field and decides, once per link. A label in a block of its own
  with no colon (「秘密の質問」 above the question) still reads as a whole question; the
  popup shows it, so the owner can refuse it.

### The judge gets the account's slots

Owner, 2026-10-23 11:19 UTC (decided 7). The judge request carries `slots`, built with
the same schema and builder as a generation request's
([ADR 0010](0010-inference-field-hints.md),
[ADR 0027](0027-per-account-login-routes.md#custom-fields-in-generation)): the login
item's built-in fields it can fill, one slot per custom field it allows by `fieldName`
and position, the username's shape and the Text fields' shapes. `totp` only when the
page shows a code field (`slotsForPage`); Hidden fields are never shaped; never a value,
an item name or a binding. The slots come from the login's own item only, not every item
that matches the page. On the `passkey` route, which reads no vault value, they carry no
shapes. The username's shape comes from the read that hides the username from the page,
so it is read once, and the slots are built once the page counts as judged. The service
sends them to the model with the page and logs them with the request as generation's
are; the answer's log keeps each pairing's slot index and question. The page sample of
[ADR 0029](0029-local-sign-in-state.md#amendment-signed-in-page-samples-2026-10-18)
carries the same slots, so its logged request is the judge's. The prompt version
changed, so stored judgements of the earlier prompt are purged as for any prompt
change.

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
phone number, a password or a code sent to the person) has no `details`, that a birth
date split over several inputs or written in a form no `format` matches (a two-digit or
era year, a separator it lacks) is none either, nor a card number or expiry date split
over several inputs, that a PIN is never the account's password, and that a card's
security code is a detail, never a `code`. Inputs that fail the checks above are
dropped and logged by reason, as `totpDropped` is. A paid run on synthetic pages
([results](../research/2026-10-23-detail-judge-eval.md)) gave the expected answer on
every requested page with four model settings; the split-date line came from it. The
lines for decided 8's values have not been run against a model. Delivery 8 widens what
has `details`.

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

`field` is `identity.phone`, `card.number`, `card.code`, `card.expMonth` (for
`card-expiry`, whose year the same card item gives) or a custom field by name, as
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
   name contains `phone`, `tel` or `電話` and does not read as a PIN, for
   `phone-last-4`; Text or Hidden custom fields whose name reads as a birth date
   (contains `birth`, `dob`, `生年月日` or `誕生日`, in any case) and does not read as a
   PIN for `birth-date`; card items for `card-last-4`, `card-code` and `card-number`,
   and those whose expiry month and year are both allowed for `card-expiry`; Text or
   Hidden custom fields named as a PIN, of the login item or a card item, for `pin`. A
   link reads only such a field, so a link edited elsewhere never types another custom
   field, such as a PIN into a member ID's input, into the page. An item whose name
   holds a run of three or more ASCII letters or digits found in the page's host name,
   or which appears whole in the page's title, comes first.
3. The popup's "This page" section shows what the page asks for and the candidates, the
   first one selected, for example "This page asks for your birth year and month." and
   "本人 › 生年月日", with **Fill**.
4. **Fill** fills the input in the tab's current document, checking its choosing radio,
   when that document is the login's, the tab's login is still the one that stopped
   there, the site and the login item are still allowed, and the page still shows the
   input writable and the button, and the page shows no other account than the login
   item's, as for a login's fill; it does not press the button. The person checks the
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
since every linked value is filled; kept for a detail that a later owner decision stops
filling), `detail-unlinked`, `detail-unreadable` (the linked value is not a date or an
expiry month and year, or has too few or too many digits) and `detail-unavailable` (the
vault could not give the linked value at the fill); a login that meets either stops as a
changed policy (`field-unavailable`). About links it gains `detail-saved` (a link filled
from the popup was saved after the login was confirmed), `detail-not-saved` (it could
not be written, as while another tab's login runs; it is dropped), `detail-forgotten` (a
refused value's link was removed) and `detail-kept` (that removal could not be written
now). The judge's log keeps `details` with each ID that is not a candidate replaced by
`?`, and a pairing's slot index (`-1` for one not sent) and question. Never a value or
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
- A pairing arrives only with the login whose page the service judged: a page is judged
  once per revision and path, so a second account, or a worker restart before the
  offer is in session, gets none and needs a field named as the question.
