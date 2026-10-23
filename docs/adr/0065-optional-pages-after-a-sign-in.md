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

1. **A judge answer `optional`.** The judge may answer `optional`: the person is signed
   in and the page's content is only an offer or reminder they may put off, with a way
   to skip it, decide later or go on. A signed-in page that only shows such an offer
   beside its usual content is still `signed-in`, and a page that asks for a password, a
   code, a CAPTCHA, a confirmation of the sign-in or another step before the account
   opens is still a `challenge`, as is a security notice about this sign-in (a new
   device, a new location, suspicious activity), even one with Dismiss. The answer names
   no element. The prompt version changes, so each recipe's pages, a stop's pages too,
   are judged once more.
2. **It fails closed.** The judge role reads `optional` as `challenge` when the page
   shows a sign-in field (a password input other than a new password, a field marked
   `username`, `current-password` or `one-time-code`) or a code field (`isCodeField`).
   The extension completes on it only when the page confirmed no sign and no evidence
   before the request (S1 to S5, E1 to E3: the `judge` reading), the loaded document
   still shows no sign after the answer and the description left out no disabled field,
   as for an undecided page; otherwise the login ends `challenge`.
3. **The login completes as signed in.** `authenticated`, confirmed: no `unconfirmed`
   flag, the green badge, a pending account choice is saved as after `signed-in`. On
   either route, before a stop ([ADR 0036](0036-passkey-after-the-identifier.md)) and in
   a watched login too, since the judge found the person signed in. A login whose tab
   moved to another origin of the site (ADR 0022) completes on it as on `signed-in`,
   after the same page re-check. Nothing is pressed and the page is left to the person.
4. **Nothing is learned.** The service keeps `optional` as the path's verdict and learns
   no marker and no handler from the page. A later login of the revision that reaches
   the path gets `judged-optional` without a model call and completes the same way. Not
   confirmed by the owner, chosen as the safe and simple reading: a marker comes only
   from a page judged `signed-in`, so an element that shows only on the prompt page
   never becomes the recipe's evidence and never keeps the usual signed-in page from
   being recognised; a login that reaches the usual page is judged there and learns its
   marker as before.

## Consequences

- GitHub-like prompts end the login with the green badge and the prompt still on
  screen; the person dismisses it. One judge call on the first login that meets the
  prompt on a revision, none later.
- A recipe whose logins always land on the prompt never gets a marker, so each such
  login asks the service (`judged-optional`, no model call) instead of completing
  locally.
- A model error that answers `optional` for a real challenge without a sign-in or code
  field (an approval on a phone, an emailed link) completes the login while the person
  still has a step to take. The page is left on screen either way; the badge says
  signed in. The judge benchmark of 2026-10-23 found no such answer on its challenge
  pages.
- A model error the other way (`challenge` for an optional page) keeps today's yellow
  "!" and watched login.

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
