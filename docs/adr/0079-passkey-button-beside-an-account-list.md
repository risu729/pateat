# ADR 0079: A chooser layout holds the passkey button shown beside its list

Status: accepted by the owner on 2026-10-25 (00:16 UTC, decision card
「パスキーボタンの横に一覧があるページを、どう直しますか?」, option 「案 A:
一覧にボタンを持たせる」), after the owner asked at 2026-10-24 22:44 UTC for the
replacement of the button by a list to be fixed
(「これは修正すべきだと思いますが、どうすればいい？」). The proposal the owner read is
`designs/passkey-beside-list-proposal-ja.md` in the project files. Amends
[ADR 0053](0053-passkey-only-generation.md) (decision 7's implementation),
[ADR 0028](0028-account-chooser-login-pages.md),
[ADR 0060](0060-recipe-layouts.md) (the chooser layout's members) and
[ADR 0041](0041-repair-stale-recipes.md) section 6.

Date: 2026-10-25

## Context

ADR 0053 decision 7 (owner, 2026-10-19): on a page that shows a passkey button beside an
account list (ADR 0028), an item with a discoverable passkey for the RP ID uses the
button and another item uses the list. A path holds one recipe, and a recipe is a login
recipe, a chooser or an entry, never two of them (`storedLoginRecipeSchema`). So the
implementation chose between them for all items:

- Beside a list by names only, the page was sent as a passkey-only page only when every
  URI-matching item held a discoverable passkey, else as a list. An item without a
  passkey that matched later could not run the passkey-only recipe; since
  [#1052](https://github.com/risu729/pateat/pull/1052) such a page is refused at once
  with `no-route`. Which way the page went also told the service whether every matching
  item held a passkey, a fact decision 2 keeps on the device.
- A list by email went first (`no-input-offer.ts`), so decision 7 never applied to it.
- Beside a list, items with a passkey used the list, signing in with a passkey only when
  the page made its own request (ADR 0034) or after the list click (ADR 0036).
- A list repair (ADR 0041 section 6) replaces a login recipe with a chooser, so sending
  a passkey-only recipe's page as a list would drop the button for every item
  ([#1044](https://github.com/risu729/pateat/pull/1044), closed).

## Decision

1. **Shape.** A chooser layout may hold `passkey`: a passkey-only route body (ADR 0053
   decision 6: `passkeyOnly: true`, `slots: []`, one `submit` click on the button, the
   same button as its `passkey` member, `maxSubmissions: 1`) whose button is on the
   chooser's path. It keeps its own handlers and signed-in markers, as a branch does.
2. **Choice.** On the list, an item with a discoverable passkey for the RP ID, on a page
   the passkey scripts run on ([ADR 0050](0050-http-pages-for-http-items.md)), takes
   the layout's `passkey` route; any other item takes the list as before. This is the
   same choice a login recipe makes between its `passkey` and `password` routes
   (`chooseLoginRoute`).
3. **Branch.** The route is the chooser branch `passkey`, named `<key>:passkey`
   (`recipeBranchSchema`), so its use records, handlers and markers are written to it as
   to `account` and `other`.
4. **Generation.** A page that shows a passkey button beside a list, by names or by
   email, is sent as a list, with the button among its candidates; the answer may name
   it as `passkeyButton`, which the service stores as the layout's `passkey`. The page
   is never sent as a passkey-only page, so the "every item" rule and its second vault
   lookup go.
5. **Repair.** A list repair of a passkey-only recipe whose button the answer names
   again carries that layout, with what it learned, into the chooser layout's
   `passkey`. A list repair of a chooser whose list's buttons a layout already has adds
   or replaces only that layout's `passkey`.

Claude's choices beyond the owner's answer, not confirmed by the owner:

- After a logout ([ADR 0021](0021-account-choice-outside-settings.md) D) the list page
  showing again asks for an account and presses nothing, as for any passkey route.
- An item whose passkey sign-in on the route fails ends as a passkey-only route's does
  (`challenge`), without falling back to the list: the route has no `password` variant
  to fall back to, and the list is a separate route of the chooser. The item can sign in
  by hand, or a later visit takes the route again. (This replaces an earlier choice here
  that it would fall back to the list.)
- The route is chosen only when the account's plan on the list and its plan on the
  route name the same item and the button shows at that moment (otherwise the list is
  used), before any list click; a resumed login keeps the click it
  recorded (`passkey`), and a passkey-route run is not treated as a run on the list.
- A button-only page keeps ADR 0053 decision 2: one matching item with a passkey is
  enough. A list by names whose shown texts name no matching item's username and that
  shows no control for another account cannot be sent as a list (ADR 0028), as those
  texts may be no list at all, such as a heading: that page is sent for its button alone
  under decision 2, and with no item holding a passkey it is logged as the list alone
  (`no-listed-account`).
- The list observation carries every enabled button that names a passkey or security
  key and not its registration, by its lasting locator (an ID, a name or a test ID) when
  no unique text names it, as an icon-only button; one that is or holds a list control
  is sent once.
- A passkey-only recipe's page that shows a list beside its button (by
  `login.entry.check`'s new `list`) is claimed and sent for repair as a list, as the
  first page's list would be: the texts that name a matching item's username are hidden
  (or all of them beside a control for another account), and a list by names that names
  none and has no such control is not sent (`recipe.repair` `skipped`,
  `no-listed-account`).
- The answer's `passkeyButton` is kept only when it is a button of the page that names a
  passkey or security key and not its registration, and is neither list control;
  otherwise it is dropped and the list is stored without it, as a form plan's passkey
  button is (ADR 0027). The list's prompt line asks for it, so the list's prompt version
  changes, and the shared answer format makes every generation prompt version change.
- A list repair whose answer names no button leaves a layout's `passkey` as it is.
- Provenance ([ADR 0060](0060-recipe-layouts.md#generation-provenance)): the route's
  units are `passkey/page:0`, `passkey/handler:<i>` and `passkey/marker:<i>`. The call
  that names the button records `passkey/page:0`; a carried layout's handlers and
  markers keep the rows of the calls or devices that made them. A call's write drops the
  rows of units its document no longer holds, as those of a route put in place of
  another.
- The route is stored whole: a request for a page after it (`<key>:passkey` as `branch`)
  is refused with `recipe-conflict` before any call.
- The stored route must be a sign-in route and must not press the list's `other` or
  `continue` button.
- `/manage` shows the button as the chooser's "Passkey sign-in".

## Consequences

- Both kinds of item log in on the same page, each with the way in it can use.
- The request of a page with a button beside a list says nothing about the matching
  items' passkeys.
- A build older than this one cannot parse a chooser with `passkey`: its sync leaves
  that recipe out and moves past it, as for any change it cannot read
  ([#959](https://github.com/risu729/pateat/pull/959)), so that page has no recipe on it
  until it is updated, and its generation answer for such a page is refused. No
  compatibility is kept for the owner's own data.

## Delivery

In two PRs:

1. The shape, its projection (`chooserRoute`), the branch name, the generation answer
   (`packages/inference`), the service's write and repair merge
   (`packages/generation`, `chooserRepairWrite`, `listPasskeyRoute`), and `/manage`.
   Nothing sends such a request yet: the extension still sends a page with the button
   beside a list as ADR 0053's implementation note says. Local tests only.
2. The extension: the list observation carries the passkey buttons, the page is sent as
   a list (`no-input-offer.ts`, `runtime/admit-recipe.ts`), the route choice on the list
   (`runtime/admit-start.ts`), and the repair of a passkey-only recipe's page as a list
   (`runtime/repair-run.ts`). Local tests only; a real site in the owner's Chrome is
   unchecked.

## Alternatives

- **Always a chooser beside a list** (option B on the card): smaller, but items with a
  passkey never press the button, against decision 7.
- **One document holding a login layout and a chooser layout:** the closest to ADR
  0060's "first layout the account can run", but it needs a union across recipe kinds
  and a ranking across them.
- **Two recipes on one path:** breaks the one-recipe-per-path assumption of generation,
  repair and `/manage`.
