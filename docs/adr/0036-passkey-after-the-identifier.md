# ADR 0036: Items without a password go on to a passkey after the identifier

Status: accepted by the owner on 2026-10-13 at 02:10 UTC (option A, "進めて答える", of
the proposal `designs/email-then-passkey-proposal.md` in the project files, reviewed
against the code by a subagent three times before it was put to the owner). Amends
[ADR 0027](0027-per-account-login-routes.md) (route choice, the end at `challenge`),
[ADR 0034](0034-answer-page-passkey-requests.md) (rules 3 and 5),
[ADR 0029](0029-local-sign-in-state.md) (E2 and an undecided answer),
[ADR 0022](0022-login-attempts-per-tab-and-origin.md) (moves) and
[ADR 0021](0021-account-choice-outside-settings.md) D (fill only).

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
   - the recipe has no `alternatives`, is not a chooser recipe (ADR 0028), and the
     login runs in the tab's top document;
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
   (ADR 0027, ADR 0034 rule 5).
5. **Signed in or not.** For these logins the username in the header or navigation (ADR
   0029 E2) is not taken as a sign-in, also while watched and on a move to another
   origin of the site (ADR 0022): a page after the identifier has no password field and
   may show the username before the sign-in. Signed-in markers (E1) and the other rules
   stay. The judge decides instead, within its limits; an undecided answer does not
   complete the login but ends it `challenge`, watched, while a path the judge found
   signed in before (`judged-signed-in`) completes it, on the same origin as on a move.
   A move after a passkey answer completes as ADR 0022 says.
6. **Unchanged.** Recipes, generation and continuation, and saved bindings stay as they
   are; the binding keeps naming the empty password field, so the item signs in with
   its password once it has one. Fill only after a logout (ADR 0021 D) fills the
   identifier and presses nothing. A login that switched to the `passkey` route because
   its start page asked never falls back to this; it ends `challenge`. A "use a passkey"
   button beside the password field is not clicked: that page is not judged, so no
   handler is learned for it. (Amended on 2026-10-13 by the owner's decision at 04:42
   UTC, below: a login of a variant that ends at Continue asks for the recipe to be
   continued, and offers the `password` slot.)
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
   taken over. A continued page with a password field is not judged, so a "use a
   passkey" button beside it is still not clicked (rule 6).
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

## Consequences

- A passkey-only account on a site that asks for the identifier first, such as OpenAI
  Platform, signs in with its passkey.
- On a site that sends a code by email after the identifier, each such login sends
  one. The same tab never sends the identifier again by itself; during the watch, its
  sign-in pages ask for an account and fill only when one account is to be used
  (ADR 0021 D); a new tab after the watch, with no release in between, starts again.
- Pages after the identifier are judged by the model more often, within the limits of
  ADR 0029.
- A login of an item without a password on a recipe that ends at Continue sends the page
  after Continue for continuation, a paid call (ADR 0018), once per final advance; the
  recipe is shared, so later logins of any account reuse the continued steps.
- What OpenAI shows after the email is not known yet; the Bot's first login after this
  change shows it.
