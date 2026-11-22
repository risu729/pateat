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

Amended on 2026-11-08 (owner, 02:58 UTC): a passkey answer counts as the sent credential
on any route; see
[the amendment below](#amendment-2026-11-08-a-passkey-answer-counts-as-the-sent-credential).
Amended on 2026-11-22 (owner, 20:32 UTC): a native login presses Yes on a stay-signed-in
question under the IdP step's local reading of
[ADR 0026](0026-sign-in-through-identity-providers.md); see
[the amendment below](#amendment-2026-11-22-a-native-login-presses-yes-on-a-stay-signed-in-question).

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
   links, and a field on it may be a step of the sign-in. The description has no role
   for a radio button, a select or a text area, so the extension says when the page
   shows one, or an ARIA radio, radio group, combo box, list box or text box, that is no
   part of a site search (`inputLeftOut`), as in "send the code to [SMS] [Email]
   [Continue]". A disabled one counts, and so does a transparent, tiny or unrendered one
   under a label or container that shows, as a styled radio under its label "card". One
   in a search landmark, a search box itself, a select or combo box of a small search
   form (at most four controls, every typed input a search box), and a select or combo
   box in the page footer (`contentinfo`, or a `footer` outside an article, section,
   dialog or form), such as a language picker, do not; a footer's radio buttons and text
   areas still count. The extension completes on it only when all of these hold, and
   otherwise ends the login `challenge`, except as the first says:
   - this attempt already sent the account's credential: its latest effect step
     submitted after a route step that typed the password or a second factor's handler
     (a handler missing from the recipe does not count).
     The page after an identifier's Next, or after a handler's button that goes on to
     the password ([ADR 0048](0048-password-method-button.md)), is judged too but is no
     page after the sign-in: there an `optional` answer is not known to be signed in and
     settles as an undecided page does without completing (`unknown-submit`);
   - the page confirmed no sign and no evidence before the request (S1 to S5, E1 to E3:
     the `judge` reading), the loaded document still shows none after the answer, on the
     same path, the description left out no disabled field, and the page shows no such
     radio button, select, text area or widget. The same-path check is for `optional`
     only: an undecided page keeps ADR 0029's rule, as on a single-page app that routes
     on while it is judged;
   - the login is not stopped before its item's missing password
     ([ADR 0036](0036-passkey-after-the-identifier.md)): such a login goes on to its
     stop as after an undecided answer, since only `signed-in` proves the stop's page.
3. **The login completes as signed in.** `authenticated`, confirmed: no `unconfirmed`
   flag, the green badge, a pending account choice is saved as after `signed-in`. On the
   `password` route, in a watched login too
   ([ADR 0027](0027-per-account-login-routes.md): a later page of the origin that the
   judge finds `optional` completes it), since the judge found the person signed in. The
   `passkey` route never completes on `optional`, even after a learned handler sent a
   second factor, as it never completes on a judged page its own checks do not prove
   (ADR 0027). A login whose tab moved to another origin of the site (ADR 0022)
   completes on it as on `signed-in` when the description left out no disabled field
   and no radio button, select or text area, the attempt already submitted the item's
   password or a TOTP code (a move within the site may follow an identifier's Next) and
   it has no stop, after the move's own re-check: the page is still on the path it was
   judged on and loaded, shows no password field, code input or CAPTCHA, and asked for
   no passkey since the step the move follows. Nothing is pressed and the page is left
   to the person. Since 2026-11-08 (ADR 0022) such a move within 30 seconds of the
   password or code completes on a quiet page without the judge, so this applies to a
   frame login's watch past those 30 seconds.
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
  signed in. The paid judge benchmark of 2026-10-23 on the final prompt (44 cases,
  effort low, about $0.72) found no such answer: 43 of 44 correct, no false signed-in
  and no `optional` on any challenge page, including four challenge pages with no field
  (a "Send code" button, a number to match on a phone, a recovery address to confirm,
  a choice of passkey or password before the sign-in). The one miss was a timeout on
  `en-method-chooser`, as in earlier runs. After main changed the prompt's sentence on
  code pages ([#985](https://github.com/risu729/pateat/pull/985)), the 15 optional,
  offer and new challenge cases were run again on the merged prompt: 15 of 15 correct,
  about $0.16.
- A model error the other way (`challenge` for an optional page) keeps today's yellow
  "!" and watched login, as does an optional page with a field, such as a phone number
  to add, or with a radio button, select or text area outside the page footer, such as
  a language picker in the header, a native select hidden behind a custom dropdown or
  a CAPTCHA's hidden answer area.

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

## Amendment 2026-11-08: a passkey answer counts as the sent credential

Owner, 2026-11-08 at 02:58 UTC, 「同様に意味もなく認証方法で分けてあるのをすべて直して」
after choosing one move rule for every sign-in method (ADR 0022's amendment of that
day). Decision 3's "the `passkey` route never completes on `optional`" had no reason of
its own: it followed ADR 0027's settlement of that route, which ADR 0029's amendment of
2026-10-24 already replaced for undecided pages. Now Pateat's answer to the passkey
request of the attempt's step counts as its sent credential, as a submitted password or
TOTP code does, on any route, so an `optional` page after that answer completes the
login under the same conditions; before it, the page is still not known to be signed
in. A move judged `optional` (ADR 0022) counts the answer the same way.

## Amendment 2026-11-22: a native login presses Yes on a stay-signed-in question

Owner, 2026-11-22 at 20:32 UTC, choosing 「SSO と同じ条件 (見出し、ユーザー名の表示、Yes
ボタン 1 つ) で押します。条件が合わなければ今と同じく本人待ちです。」 Implemented, with
local runtime tests and Chromium component tests on a synthetic page; not checked on a
real site.

Evidence, 2026-11-21 on the production build
([issue #1772](https://github.com/risu729/pateat/issues/1772)): UNSW Connect signs in on
its own Microsoft Entra External ID page (`https://unswconnect.ciamlogin.com`). Pateat
filled the email and password and submitted; the next page, titled "Sign in to your
account", was Microsoft's "Stay signed in?" question: that heading, the account's email
in an identity banner, "Do this to reduce the number of times you are asked to sign
in.", a "Don't show this again" checkbox and the buttons No and Yes. The judge answered
`challenge`, as Decision 1 and the judge corpus's `en-stay-signed-in` case expect, so
the login waited the 600 seconds for the person, on both attempts. The SSO flow already
presses such a question on an IdP's page (ADR 0026); a site's own sign-in did not.

1. **The page is read locally before the judge.** In a login of the site's own account,
   the page after a step that sent the account's credential (Decision 2's first
   condition, or a passkey answer since the amendment of 2026-11-08) is first read in
   its document with the reading ADR 0026's IdP step uses, before it would go to the
   judge. It is a stay-signed-in question only when the page's own title or a visible
   heading asks it (such as "Stay signed in?" or サインインの状態を維持しますか),
   nothing on the page shares the account or grants access and no permission or
   account-creation page shows, it shows no other or masked account and shows the
   login's own exactly, and it has exactly one button labelled Yes or はい. The reading
   needs the login's username, read from the vault as a move's E2 check reads it; it is
   used in the document only and never sent to the service or logged.
2. **Pateat presses Yes, once, under the IdP step's checks.** The button is prepared
   first; its form's destinations off the page's origin must pass the login item's
   destination rule ([ADR 0051](0051-form-destinations-by-item-uri-match.md)); and the
   document reads the page again with the same checks, finds the same element and
   destinations, and asks the worker to authorize, before the pointer events and again
   before the click. The worker authorizes each phase once, only for the login's current
   document while its policy holds; the document refuses the press for a native attempt
   the SSO coordinator cancelled there. A preparation lasts at most 30 seconds, and the
   press waits on the page's own events, never a set time
   ([ADR 0082](0082-waits-on-signals.md)). A login presses at most one such question, in
   any document and also when the press failed, so a question shown again, as by a
   sign-in that loops, goes to the judge; a document allows one press too. Only the
   tab's page on the recipe's own origin is read, for a login that is not watched (a
   watched login only reads its pages, ADR 0027), has no stop
   ([ADR 0036](0036-passkey-after-the-identifier.md)), does not only fill, and is not an
   SSO flow's IdP login, whose flow presses the question itself. The rule names no
   provider, page or URL ([ADR 0033](0033-no-site-specific-features.md)).
3. **Nothing is judged or learned for that page, and the login goes on.** The page is
   not sent to the judge; the log says so as a `recipe.judge` `not-sent` line with
   reason `stay-signed-in`. The login is not settled on it: the page after the press, in
   a new document or the same one, gets the step's usual budget and is then completed by
   its own evidence or judged as any page after the credential. A press whose answer is
   lost because the document went away, as a form that posts to the same URL takes it,
   counts as made only once the worker authorized its click; the tab's next page then
   resumes the login.
4. **Any other page waits for the person as before.** A page that does not read as such
   a question, such as one with two Yes buttons, one that asks with a "Keep me signed
   in" checkbox and a Continue button, or one that shows no account, and a press that
   fails go to the judge as before, whose `challenge` answer for a stay-signed-in page
   stays; the judge's prompt and corpus are unchanged.

Not confirmed by the owner, chosen by an agent as the narrowest reading of the choice:
the press is spent per login even when it failed, a fill-only login never presses,
and the log uses the existing judge line rather than a new event. Pressing Yes asks the
site to keep its session on this browser longer, as the SSO flow's press already does;
"Don't show this again" is left as it is.
