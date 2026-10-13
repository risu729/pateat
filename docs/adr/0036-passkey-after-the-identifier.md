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
   handler is learned for it.
7. **Logs.** `login.attempt` names the stop (`stop=password`), and the `challenge` at
   the stop names `password-empty`. The fact shows in the log as the `no-route` detail
   already does (ADR 0027 keeps facts out of logs otherwise); no value does.

## Consequences

- A passkey-only account on a site that asks for the identifier first, such as OpenAI
  Platform, signs in with its passkey.
- On a site that sends a code by email after the identifier, each such login sends
  one. The same tab never sends the identifier again by itself; during the watch, its
  sign-in pages ask for an account and fill only when one account is to be used
  (ADR 0021 D); a new tab after the watch, with no release in between, starts again.
- Pages after the identifier are judged by the model more often, within the limits of
  ADR 0029.
- What OpenAI shows after the email is not known yet; the Bot's first login after this
  change shows it.
