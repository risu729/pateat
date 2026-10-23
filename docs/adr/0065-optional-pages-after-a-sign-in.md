# ADR 0065: Optional pages after a sign-in end the login as signed in

Status: accepted by the owner on 2026-10-23 at 12:27 UTC, who chose option B of the
proposal: treat the account as signed in, leave the page as it is and press nothing.
Implemented (local tests and a paid judge benchmark on hand-built pages; not checked on
a real site). A first version that pressed a learned button (option A, below) was built
ahead of the decision under the owner's 2026-10-23 rule to set the phases aside and
decide afterwards ("フェーズは一旦無視して、ある程度決め打ちで進め、後から判断") and was
replaced before merging. The proposal, in Japanese, is
`designs/optional-page-after-login-proposal-ja.md` in the project files. Amends
[ADR 0029](0029-local-sign-in-state.md) (a new judge answer and its outcome) and
[ADR 0027](0027-per-account-login-routes.md) (a watched login completes on it).

Date: 2026-10-23

## Context

Some sites show a page after the sign-in that the person may put off: GitHub's periodic
"Verify your two-factor authentication (2FA) settings" with "Remind me later", offers to
add a passkey ("Add a passkey?", "Not now"), a phone number or recovery details. The
owner wants Pateat to get past them (2026-10-12 04:08 UTC) with a general rule, not per
site ([ADR 0033](0033-no-site-specific-features.md), 13:46 UTC).

Before this ADR (read from the code on 2026-10-23):

- Such a page shows none of [ADR 0029](0029-local-sign-in-state.md)'s signs (S1 to S5)
  and usually no evidence (E1 to E3), so it goes to the sign-in judge. On 2026-10-12 the
  judge answered `challenge` for GitHub's page, which ends the login there, watched,
  with the yellow "!" ([ADR 0027](0027-per-account-login-routes.md)). Had it abstained
  (`unclear`), the login would complete unconfirmed (ADR 0029's 2026-10-14 amendment),
  also with the yellow "!".
- A `signed-in` answer learns a marker on the page. A marker learned on a prompt page,
  such as its "Remind me later" button, may never show on the usual signed-in page.
- [ADR 0007](0007-existing-passkey-assertions.md)'s "Registration after a sign-in"
  covers only a `navigator.credentials.create` call that lists a passkey of the vault
  just used. A page that asks "Add a passkey?" with buttons is not covered and is not
  changed here.

## Decision

1. **A judge answer `optional`.** The judge may answer `optional`: the page's content is
   only an offer or reminder the person may put off, with a way to skip it or decide
   later, and the person is already signed in and could reach the account without acting
   on the page. A signed-in page that only shows such an offer beside its usual content
   is still `signed-in`. A page that asks for a choice of how to sign in, a password, a
   code, a CAPTCHA, an approval on another device, a confirmation of the sign-in or
   another step before the account opens is still a `challenge`, as is a security notice
   about this sign-in (a new device, a new location, suspicious activity), even one with
   Dismiss. The answer names no element. The prompt version changes, so each recipe's
   pages, a stop's pages too, are judged once more.
2. **It fails closed.** The judge role reads `optional` as `challenge` when the page has
   any input the person could type into other than a search box (a `text` input whose
   input mode is `search`, or whose label or placeholder says search, with no
   `autocomplete` other than `off`): a page that only offers something has buttons and
   links, and a field on it may be a step of the sign-in. The extension completes on it
   only when all of these hold, and otherwise ends the login `challenge`, except as the
   first says:
   - this attempt already sent the account's credential: its latest effect step
     submitted after a route step that typed the password or a second factor's handler.
     The page after an identifier's Next, or after a handler's button that goes on to
     the password ([ADR 0048](0048-password-method-button.md)), is judged too but is no
     page after the sign-in: there an `optional` answer is not known to be signed in and
     settles as an undecided page does without completing (`unknown-submit`);
   - the page confirmed no sign and no evidence before the request (S1 to S5, E1 to E3:
     the `judge` reading), the loaded document still shows none after the answer, on the
     same path, and the description left out no disabled field;
   - the login is not stopped before its item's missing password
     ([ADR 0036](0036-passkey-after-the-identifier.md)): such a login goes on to its
     stop as after an undecided answer, since only `signed-in` proves the stop's page.
3. **The login completes as signed in.** `authenticated`, confirmed: no `unconfirmed`
   flag, the green badge, a pending account choice is saved as after `signed-in`. On the
   `password` route, in a watched login too
   ([ADR 0027](0027-per-account-login-routes.md): a later page of the origin that the
   judge finds `optional` completes it), since the judge found the person signed in. The
   `passkey` route never completes on a judged page that its own checks do not prove
   (ADR 0027), and `optional` does not change that. A login whose tab moved to another
   origin of the site (ADR 0022) completes on it as on `signed-in` when the description
   left out no disabled field, the attempt already submitted the item's password or a
   TOTP code (a move within the site may follow an identifier's Next) and it has no
   stop, after the move's own re-check: the page is still loaded, shows no password
   field, code input or CAPTCHA, and asked for no passkey since the step the move
   follows. Nothing is pressed and the page is left to the person.
4. **Nothing is learned, and nothing is reused.** The service keeps `optional` as the
   path's latest verdict and learns no marker and no handler from the page. Not
   confirmed by the owner, chosen as the safe and simple reading: a marker comes only
   from a page judged `signed-in`, so an element that shows only on the prompt page
   never becomes the recipe's evidence and never keeps the usual signed-in page from
   being recognised; a login that reaches the usual page is judged there and learns its
   marker as before. The verdict is not reused either: a later login that reaches the
   path is judged again, since another page of the same path, as a single-page sign-in
   shows, may ask for a step. An `optional` answer on a description that left out a
   disabled field is kept as `partial`, as an abstention there is (ADR 0029).

## Consequences

- GitHub-like prompts end the login with the green badge and the prompt still on screen;
  the person dismisses it. Each login that meets the prompt makes one judge call, which
  counts toward the recipe's daily judgement limit; past it the page is
  `judgement-limit`, which completes unconfirmed as before.
- A recipe whose logins always land on the prompt never gets a marker, so each such
  login sends the page to the judge instead of completing locally.
- A model error that answers `optional` for a real challenge with no input (an approval
  on a phone, an emailed link, a button that sends a code) completes the login while the
  person still has a step to take. The page is left on screen either way; the badge says
  signed in. The judge benchmark of 2026-10-23 found no such answer on its challenge
  pages, including such pages with no field.
- A model error the other way (`challenge` for an optional page) keeps today's yellow
  "!" and watched login, as does an optional page with a field, such as a phone number
  to add.

## Alternatives

- **A. Press a learned button that puts the page off.** The judge names the button
  (Skip, Not now, Remind me later); the service keeps it as a `skip` handler only when a
  shared English and Japanese word list accepts its text, and the extension presses it
  after reading the live text again. Built first and rejected by the owner on
  2026-10-23: it presses a button on the person's account page, a wrong press (such as
  "Skip and sign me out", which passed the word list in review) acts on the account,
  and it needed a word list per language.
- **C. Leave it as before.** No code; GitHub's page ends `challenge`, or unconfirmed
  when the judge abstains, both with the yellow "!".
- **`signed-in` with a marker on the prompt.** Rejected: the marker may not show on the
  usual signed-in page (Decision 4).
