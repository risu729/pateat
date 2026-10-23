# ADR 0036: Items without a password go on to a passkey after the identifier

Status: accepted by the owner on 2026-10-13 at 02:10 UTC (option A, "進めて答える", of
the proposal `designs/email-then-passkey-proposal.md` in the project files, reviewed
against the code by a subagent three times before it was put to the owner). Amends
[ADR 0027](0027-per-account-login-routes.md) (route choice, the end at `challenge`),
[ADR 0034](0034-answer-page-passkey-requests.md) (rules 3 and 5),
[ADR 0029](0029-local-sign-in-state.md) (E2 and an undecided answer),
[ADR 0022](0022-login-attempts-per-tab-and-origin.md) (moves) and
[ADR 0021](0021-account-choice-outside-settings.md) D (fill only). Amended on 2026-10-13
by the owner (05:39 UTC): at the stop, a passkey button beside the password field is
pressed when the item has a passkey (rule 6; implemented, with extensions by Claude that
the owner has not confirmed separately). Since the owner's
decision of 2026-10-13 06:32 UTC ([account lists](#account-lists), below), it also
amends [ADR 0028](0028-account-chooser-login-pages.md) (a login on a list of accounts).

Date: 2026-10-13

## Context

On the Grok Bot's computer, OpenAI Platform (`platform.openai.com/login`) logged
`login.refused` `no-route` `password-empty` (build 25b08b2, 2026-10-12 23:13 UTC): the
login item's password is empty. The owner's three OpenAI items each hold TOTP and one
passkey. The start page shows an email field, Continue, and buttons for Google, Apple,
Microsoft and a phone; no passkey button, and no passkey request of its own (the Bot,
2026-10-13). Such an account signs in after the email, with a passkey.

Pateat already answers a passkey request of a page after the username during a login
with that login's item (ADR 0027, executor 4), and clicks a learned `passkey` handler.
But the route choice never starts the `password` route for an item without a password
(`chooseLoginRoute`), even when the steps before the password need only the identifier.

## Decision

1. **Scope.** A login on the `password` route may start without the item's password
   when all of these hold:
   - the password fact is false because the item has no password (`password-empty`);
     an item whose password the account may not fill (`password-not-allowed`) still
     ends `no-route`;
   - the item holds a usable passkey for an RP ID the origin may use (the `passkey`
     fact; it need not be discoverable, since a page after the identifier usually
     names the account's credentials);
   - the recipe has no `alternatives`, ~~is not a chooser recipe (ADR 0028),~~ and the
     login runs in the tab's top document (Amended on 2026-10-13 by the owner's decision
     at 06:32 UTC, [below](#account-lists): a chooser recipe qualifies, and its click on
     the list is an `advance` before the stop);
   - the variant has a route step that fills the password, and at least one `advance`
     step comes before it, and no step before it fills a field the item lacks.
2. **The stop.** The login records, when it starts, the step that fills the password,
   and never runs it or any step after it. A worker restart or a vault sync that adds a
   password meanwhile does not change that: the attempt contract refuses those steps.
   The steps before it run as on any `password` login.
3. **Passkeys up to the stop.** From the login's start until it ends, a passkey request
   of its document is answered with its item. A request that shows a prompt is answered
   so today (ADR 0027). A `conditional` request is answered too, which amends rules 3
   and 5 of ADR 0034 for these logins only: the item's passkey need not be
   discoverable, and a request that came after the first submission waits
   until the login reaches the stop, and is answered there. The answer counts as a
   submission. While the sign-in form's password field still shows after the answer,
   the login waits for up to 15 seconds (`REQUEST_HOLD_MS`, as ADR 0034 rule 6 waits),
   then ends as below.
4. **The end.** At the stop, the login waits up to three seconds for a request, counting
   one that was already waiting. Without one it fills nothing and ends `challenge`, and
   is watched for ten minutes, as a top-level `password` login that stops at
   `challenge` is (ADR 0027). Requests during the watch are no longer the login's
   (ADR 0027, ADR 0034 rule 5). The watch's own pages are judged as any watched login's
   are, though the login has no step in flight.
5. **Signed in or not.** For these logins the username in the header or navigation (ADR
   0029 E2) is not taken as a sign-in, also while watched and on a move to another
   origin of the site (ADR 0022): a page after the identifier has no password field and
   may show the username before the sign-in. Signed-in markers (E1) and the other rules
   stay. The judge decides instead, within its limits; an undecided answer does not
   complete the login but ends it `challenge`, watched, while a path the judge found
   signed in before (`judged-signed-in`) completes it, on the same origin as on a move.
   A move after a passkey answer completes as ADR 0022 says.
6. **Unchanged.** Recipes, generation and continuation, and saved bindings stay as they
   are; the binding keeps naming the empty password field, so the item signs in with its
   password once it has one. Fill only after a logout (ADR 0021 D) fills the identifier
   and presses nothing. A login that switched to the `passkey` route because its start
   page asked never falls back to this; it ends `challenge`. ~~A "use a passkey" button
   beside the password field is not clicked: that page is not judged, so no handler is
   learned for it.~~ (Amended on 2026-10-13 by the owner's decision at 04:42 UTC, below:
   a login of a variant that ends at Continue asks for the recipe to be continued, and
   offers the `password` slot.) Amended on 2026-10-13 by the owner (05:39 UTC): a "sign
   in with a passkey" button beside the password field is pressed when the item has a
   passkey, as below in "A passkey button beside the password field" (the owner's
   answer, 「パスキーが登録されてるなら押したほうがいいのでは？」, to whether Pateat
   should press it).
7. **Logs.** `login.attempt` names the stop (`stop=password`), and the `challenge` at
   the stop names `password-empty`. A `no-route` refusal of an item without a password
   that does not go on names which condition failed after a colon, such as
   `password-empty:no-passkey` or `password-empty:no-advance` (added on 2026-10-13,
   after the Grok Bot's OpenAI Platform login on build 85085b7 still logged
   `no-route password-empty` with no reason). The fact shows in the log as the
   `no-route` detail already does (ADR 0027 keeps facts out of logs otherwise); no value
   does.

**Identifier-only recipes (owner, 2026-10-13 04:42 UTC, card 「進める」).** Option A
named OpenAI Platform as its goal. Its stored
recipe (revision 1) is identifier-first and ends at Continue: the page after the email
was never generated, so its variant fills no password, and build 85085b7 still refused
it `no-route` `password-empty`. A variant that fills no password at all and ends with an
`advance` step therefore also meets rule 1, when no step fills a value the item lacks
and no slot of its binding reads a password from another field (the `password` slot, a
field Linked to the password, or a hidden custom field; the detail is then
`password-field`). Its stop lies just past its last step (`stopAt` is the plan's step
count), and `login.attempt` names it `stop=password` too. Such an attempt gets one
submission more than the recipe's budget, kept for the answer at the stop (rule 3): a
generated recipe's budget counts only its own effects, so an email and Continue recipe
has one, which Continue spends. No step, handler or page's own submission may spend the
kept one, and a switch to the `passkey` route gives it back.

**Owner decision (2026-10-13 04:42 UTC).** The owner (risu) replaced this card's "no
continuation" wording: the page after the email is generated too, since it may ask for a
password or a passkey, and a passkey may need a button pressed first. After such a
variant's Continue, the login therefore goes on as follows:

1. A page that asks for a passkey after Continue (a request waiting, or one the passkey
   bridge answered) takes the login to its stop at once, where rules 3 to 5 apply.
2. Otherwise the page is sent to continue the recipe exactly as for an item with a
   password ([ADR 0018](0018-recipe-generation-route.md); a paid call, once per step,
   and the recipe is shared), offering the `password` slot though the item's password is
   empty; no value is ever sent. A continuation the login takes over (ADR 0027's "use
   immediately") moves the stop to its first step that fills a password, or past its
   steps again when they fill none and end with an `advance`; the kept submission then
   goes into the continued budget, which counts the password's own submission. That step
   and every later one never run, whatever the item holds later. A continuation the stop
   cannot be moved into, as one that first fills another value the item lacks, is not
   taken over. A continued page with a password field is not judged after Continue; its
   "use a passkey" button is pressed at the stop instead (rule 6, as amended at 05:39
   UTC).
3. A page that does not qualify for continuation, as one with only a button to use the
   passkey, is judged once the step's 10-second wait runs out (ADR 0029). A `passkey`
   handler the judge learns is entered before the stop, which moves along, and pressed;
   the request that follows is answered with the item as any login's is.
4. When the continuation fails or abstains, no handler is learned and the page is not
   found signed in or rejected, the login goes on to its stop past the plan's last step:
   it waits up to 3 seconds for a request, answers it, or ends `challenge`, watched, as
   `password-empty`. The identifier page still showing is never sent to the judge (its
   sign-in field shows), and an advance the record cannot go on from ends `challenge`
   unjudged.

With no stop step, rule 3's hold after an answer applies while the page stays, in the
same document, on the path the answer was given on: for up to 15 seconds, or longer
while it shows nothing, as ADR 0034 holds the `passkey` route's page. After that it is
observed as after any answer, under rule 5. A `no-route` refusal of such a variant names
why after the colon too (rule 7), with `no-password-step` for a route that fills no
password and does not end with an `advance`. `password-not-allowed` stays out of scope.

**A passkey button beside the password field.** Amended on 2026-10-13 by the owner
(05:39 UTC), answering whether Pateat should press a "sign in with a passkey" button
beside a password field: 「パスキーが登録されてるなら押したほうがいいのでは？」 (if a
passkey is registered, it should press it). So at the stop, a login of an item with a
usable passkey presses such a button, and nothing at or after the stop runs and the
password is never filled, as before. How it does so:

1. A `passkey` handler of the recipe whose button shows on the page at the stop is
   entered before the stop step, and the stop moves along with the plan as for any
   handler entered before it. Its button is pressed once, and the passkey request that
   follows is answered with the item, as any login's (ADR 0027, executor 4). This needs
   no model call, so later logins of such items press a button learned before.
2. Without one, a page that still shows the stop step's password field on its path,
   where the recipe has no `passkey` handler yet, is sent once to be judged, so a
   handler can be learned for the button. The service judges such a page though it shows
   the route's password field, but never one without it, with a signed-in marker, or on
   a path that has a `passkey` handler already, and keeps only a `passkey` handler from
   it, with the usual checks (a button that registers or adds a passkey is refused, and
   so on); never a signed-in marker or a rejection. The attempt records the judgement
   (`stopJudged`) before the request, so a restart does not send it again.
3. A handler learned so is taken over by the running login and entered as in 1.
4. With no button learned (the judge abstains, names none, or the service refuses or is
   busy), the login ends as before: `challenge`, watched, `password-empty`.

Claude extended the owner's answer as follows to implement it, and the owner has not
confirmed these points separately:

- The button is looked for only once the stop's 3-second wait for the page's own passkey
  request (rule 4) ran out with none, also for a button learned before.
- Learning the button costs a paid judge call that the owner's answer did not name: once
  per recipe revision, page path and judge prompt version, within ADR 0029's limits (20
  judgements per recipe a UTC day, which this one counts toward) and $5 a day. The
  stop's page is judged with its own instructions and prompt version (the usual ones
  plus asking only for a button that signs in with a passkey or security key instead of
  the password), so a stop's judgement never answers another login's page of the path,
  nor the reverse.
- The request says it comes from such a stop (`stop: true`). Like the `passkey` route's
  name (ADR 0027), it tells the service that the login's item has no password but has a
  passkey, and it is stored in the request JSON of the inference log (ADR 0012). The
  model's instructions name no fact of the account.
- No `totp` handler is entered or learned at the stop; a code the judge names there is
  logged as not kept (`stop`).
- A login that may still type its password (on the `password` route, without a stop)
  never enters a `passkey` handler on a path where its plan still has a route step to
  run that fills the password, nor while a fill field of the route shows on that path,
  so such a button never pre-empts a password that is typed, even while an in-place form
  swaps its identifier for its password field. A route step still to run there that
  fills only another slot, such as the route's own code step after the password, does
  not keep the handler out, so a security-key page that another account gets there in
  its place is handled as before. Once the password steps ran and the fields are gone,
  as on a second-factor page on the same path, the handler is entered as before. The
  gate is the stop rather than the item's current password, since the stop is recorded
  when the login starts and kept whatever a later vault sync adds.
- The pressed button's click is held while its button shows, as any handler's (ADR
  0027), for up to two minutes; a site that does not move on is then left to the person
  as a plain `challenge`, watched, not `password-empty`.

Known gap: the service matches the stop's password field to the route's fill target by
its exact locator. If the page description gives that field another locator than the
recipe's step, the stop's page answers `not-judgeable` and no button is learned there.
`password-not-allowed` is still out of scope.

### Account lists

**Account lists (owner, 2026-10-13 06:32 UTC, card 「進める」).** At 06:29 UTC the
owner's Chrome showed `https://platform.openai.com/login` as a page that starts with
buttons: a row for a remembered account, and "Continue with email", Google and others.
It was generated as a list of accounts (ADR 0028, logged `page: accounts`), and the
passkey-only item's login was refused `no-route` `password-empty:chooser` with nothing
pressed. The owner answered:

- Question:
  「保存済みアカウントの一覧ページでも、パスワードのないアカウントで先へ進めますか？」
  ("On a page that lists saved accounts, does an account without a password go on too?")
- Chosen option:
  「該当アカウントの行（なければ「別のアカウント」）を押します。次のページの手順を生成し（有料、サイトごとに
  1 回）、passkey を待ちます。」 ("Press the matching account's row, or 'another
  account' when there is none. Generate the next page's steps (paid, once per site) and
  wait for the passkey.")

As implemented (local tests only):

1. **Scope.** Rule 1 applies to a chooser's route (`chooserRoute`): the click on the
   list, then the steps of the branch it leads to. The click is the `advance` before the
   stop. It is chosen exactly as ADR 0028 chooses it for any item: the account's row (or
   its `continue` button), else the `other` button, else `account-not-listed` with
   nothing pressed. The other conditions of rule 1 hold unchanged: the item's password
   is empty (`password-empty`), it holds a usable passkey for an RP ID the origin may
   use, and the login runs in the tab's top document; a frame still ends
   `password-empty:frame`.
2. **The stop.** As ADR 0028 plans a login on the list, the stop is found first on the
   account branch's route and, when the list leads to `other`, again on that branch's
   route. When the account branch cannot take the stop (item 3), the list is still read,
   on the click alone, so that an account the list does not show goes on through `other`
   as the owner's option says. A stored branch stops at its first step that fills the
   password. A stored branch that fills none and ends with an `advance`, such as an
   email and Continue after "another account", stops just past its last step, and the
   identifier-only rules above apply. Without its branch the route is the click alone,
   so the stop lies just past the click: the page after it goes on as the page after
   Continue does above (a passkey request takes the login to the stop; otherwise the
   page is continued as the branch's first page, a paid ADR 0018 call, offering the
   `password` slot, and the stop moves into the continued branch).
   *Claude's reading, not confirmed by the owner separately:* the owner's option says
   「有料、サイトごとに 1 回」 (paid, once per site). In fact each branch
   (`afterAccount` and `afterOther`) is generated once, so a site can take up to two
   such calls, and an identifier-only branch takes one more for the page after its own
   Continue: one login through `other` with no stored branch can make two paid calls
   (ADR 0018's once per final advance).
3. **A branch that cannot take a stop.** *Claude's extension, not confirmed by the owner
   separately:* a stored branch that cannot take the stop, as one that first fills a
   code the item lacks, is never run. When the list leads to it (the account's row or
   its `continue` button for the account branch, `other` for the other branch), the
   login is refused `no-route` with the `password-empty:<why>` detail, as a recipe
   without a list is, and nothing on the list is pressed. When the list shows no account
   that fits and has no `other` button, the login ends `account-not-listed` as any
   chooser login does. A generated branch that cannot take the stop is not taken over;
   the login ends at its stop past the click, `challenge`, watched, and the
   `login.attempt` entry then names why as `password-empty:<why>` (such as
   `password-empty:fills-lacking`) instead of the bare `password-empty`. That log detail
   applies to every continuation that a stop past the plan cannot be moved into, with or
   without a list. It is kept in memory only, in the document that asked for the
   continuation: a later document of the login, or the same one after a worker restart,
   names `password-empty`.
4. **Submissions and restarts.** A chooser's route has the branch's submissions plus one
   for the click, which the click spends as on any chooser login; a stop just past the
   plan keeps its one more submission for the answer, as above. The attempt records the
   stop when the login starts, and the attempt contract now accepts a stop on a chooser
   login, so a restart after the click never runs the password step or a later one.
5. **Unchanged.** Passkey requests follow rules 3 and 4 from the login's start, also one
   that comes right after the click; with a discoverable passkey, a request on the list
   before the click takes the `passkey` route first, as ADR 0034 does for any chooser
   login. Rule 5 decides whether the login signed in. A login that only fills after a
   logout presses nothing on the list (ADR 0021 D). `login.start` names the click
   (`list`), and `login.attempt` names `stop=password`; the `password-empty:chooser`
   detail is no longer logged.
6. **A passkey button at the stop.** A branch's stop is its password fill, so the rule
   of 05:39 UTC above ("A passkey button beside the password field") applies there too:
   a `passkey` handler that the branch already holds, such as one learned when the
   branch's page was judged after an earlier step, and that shows on the page at the
   stop is entered before the stop and pressed, and the request that follows is answered
   with the item. *Claude's extension, not confirmed by the owner separately:* the page
   at a chooser login's stop is not sent to be judged for such a button, because the
   service built for 05:39 judges no stop's page of a chooser (`not-judgeable`); the
   extension logs `not-sent` with `chooser` instead of asking. Judging it per branch
   would need a service change and its deployment, and is not proposed here.

When the click loads a page of another origin, as OpenAI's row does
(`auth.openai.com/auth_challenge/passkey` in the owner's Chrome on 2026-10-13 at 08:51
UTC), the login is moved off its origin as any chooser login is (ADR 0022): it ends
`left-origin`, or `authenticated` when the move rules find the account signed in. It
does not continue its branch there (the service assembles a page only for the recipe's
origin, `origin-mismatch`), and the login itself does not answer a passkey request
there; a page of that origin is handled as any page of that origin, so ADR 0034 may
answer its request. Since the owner's 「完了扱い」 (13:54 UTC, amending ADR 0022), a
page of another origin of the site that asks for a passkey keeps the login, and a
passkey answered there with the login's item lets the tab's next quiet page, back on the
login's origin too, complete it. Until then this limit was Claude's decision: the login
ended `left-origin` on that page.

## Consequences

- A passkey-only account on a site that asks for the identifier first, such as OpenAI
  Platform, signs in with its passkey.
- On a site that sends a code by email after the identifier, each such login sends
  one. The same tab never sends the identifier again by itself; during the watch, its
  sign-in pages ask for an account and fill only when one account is to be used
  (ADR 0021 D); a new tab starts again, both after the watch with no release in
  between and during it, where its sign-in page ends the watch first (#472).
- Pages after the identifier are judged by the model more often, within the limits of
  ADR 0029.
- A login of an item without a password on a recipe that ends at Continue sends the page
  after Continue for continuation, a paid call (ADR 0018), once per final advance; the
  recipe is shared, so later logins of any account reuse the continued steps.
- What OpenAI shows after the email is not known yet; the Bot's first login after this
  change shows it.
- A password page that offers a passkey button is judged once for each recipe revision
  whose passkey-only login stops there, a paid call; the handler it learns is shared
  with every account of the recipe, and only logins with a stop press it while the
  password field shows.
- On a list of accounts, a passkey-only item's first login on a branch that is not
  generated yet sends the page after its click for continuation: paid, once per branch
  (and once more after an identifier-only branch's Continue), shared by later logins of
  any account (item 2 of [account lists](#account-lists)).
