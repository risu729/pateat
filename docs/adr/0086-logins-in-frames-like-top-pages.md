# ADR 0086: Logins in frames are treated like logins in the tab's page

Status: accepted by the owner on 2026-11-07 at 13:06 UTC, who chose 「案A:
同じように扱う」 on a decision card asking whether a login inside a frame should be
treated like one in the tab's top page. The proposal was reviewed against the code by a
subagent first. The delivery order, the item-URL condition on the tab's new page and the
visibility condition below were in the proposal; details marked "chosen by an agent"
were not asked. Amends [ADR 0016](0016-recipe-generation-trigger.md) (frames are sent,
delivery 3), [ADR 0017](0017-login-forms-in-frames.md) (a whole-tab navigation after a
frame's login), [ADR 0022](0022-login-attempts-per-tab-and-origin.md) (moves),
[ADR 0027](0027-per-account-login-routes.md) (which logins are watched) and
[ADR 0029](0029-local-sign-in-state.md) (frames are read).

Delivery 1, the reading after a step and the tab's new page, and delivery 2, the popup,
are implemented. Delivery 3 is not.

Date: 2026-11-07

## Context

Apple Account's sign-in, `https://account.apple.com/sign-in`, has no sign-in form in the
tab's page. The form is in
`<iframe id="aid-auth-widget-iFrame" src="https://idmsa.apple.com/appleauth/auth/authorize/signin?...">`:
an identifier input `#account_name_text_field` (`type=text`, `autocomplete=off`), a
password input `#password_text_field` inside an `aria-hidden` region, and a Continue
button `#sign-in`. After Continue, the password input shows in the same frame document
on the same path (checked in cloud Chromium on 2026-11-07 at 12:58 UTC with a synthetic
address, without Pateat). After the sign-in the frame hands its result to its page
(`response_mode=web_message`), and the page, a single-page application, changes its URL
in place to `/account/manage` (a client-side redirect from `/account/manage` to `/` was
observed without a navigation request).

The owner reported in [#1378](https://github.com/risu729/pateat/issues/1378) that the
login stayed at the identifier step. No recipe of `https://idmsa.apple.com` existed on
the service (checked in production D1 on 2026-11-07 at about 13:05 UTC), because
frames are never sent for generation (ADR 0016). Even with a recipe, a login in a frame
was neither read after its steps (ADR 0029) nor watched (ADR 0027), and the page that
replaced the frame's page ended it `cancelled` (ADR 0017), so it could never be
recorded as signed in nor save its account choice.

## Decision

A login inside a frame is treated as one in the tab's page wherever both of these hold;
otherwise nothing changes for that frame:

1. The login's item matches both the frame's URL and the tab's URL (ADR 0017's rule for
   every fill, now also for generation).
2. For sending a page for generation: the frame's element is shown in the tab's page
   (delivery 3), so a hidden or prefetched sign-in frame is never sent.

| Tab URL | Frame URL | Item URI (base domain) | Result |
| --- | --- | --- | --- |
| `https://account.apple.com/sign-in` | `https://idmsa.apple.com/appleauth/auth/authorize/signin` | `apple.com` | sent for generation, logged in, read |
| `https://evil.example/` | `https://idmsa.apple.com/appleauth/auth/authorize/signin` | `apple.com` | nothing (the tab does not match) |
| `https://news.example/` | `https://ads.example/frame` | none | nothing, as before |

### Delivery 1: reading after a step and the tab's new page

- A login in a frame reads its sign-in state after an effect step (ADR 0029) in the
  frame's document, as a top-level login reads its page: a code input, a CAPTCHA or a
  password input continuing, the form shown again with a failure rejecting. The first
  new document of the same frame after a password submission is read as `reshown`, as
  the first new top document is for a top-level login.
- A `password` login in a frame whose result stops at `challenge` or settles as unknown
  is watched (ADR 0027) for the same 10 minutes, and so is one whose wait for the site
  runs out (ADR 0022, amended 2026-11-03): it holds its origin against other tabs for
  the watch, as a top-level login does. Showing the route's first step again in a new
  document of the same frame abandons the watch, as in the tab's page.
- When the page around the frame is replaced, by a new top document or by a URL change
  of the same document whose frame no longer shows a document, the page there is read
  for the login's result, as a top-level login's page of another origin of the site is
  right after a password submission (ADR 0022), when:
  - the login's last effect step, other than a passkey's, or a code it entered ran at
    most 30 seconds before (`SITE_MOVE_MS`), or the login is watched and its watch still
    lasts, as while the person enters a code the site sent to a device; and
  - the login's item matches the new page's URL (chosen by an agent in place of
    "the same site as the frame", since a bank page may embed a sign-in frame from a
    vendor's own site).

  Whether the frame still shows a document is asked by its frame ID alone, which every
  document answers from its start (`login.frame.present`, answered by the
  `document_start` content script), so a frame that moved to its next document is still
  there once that document starts; a frame that does not answer within a second counts
  as still there, as for a new page (ADR 0017). The frame is asked the same way when the
  tab's top page announces while the worker knows no document of the frame, as after a
  worker restart during the watch (chosen by an agent after review). The move is kept
  until a hello of the tab's top page ends the login, so the page announcing again
  during the check, or going away before it was read, still leaves the login to the
  tab's page.

  The page then completes the login when it is quiet and shows the account's username,
  or else when the judge answers `signed-in` once (`judgeMove`), and the account choice
  is saved under the frame's origin. Pateat fills and clicks nothing there. Otherwise
  the login ends without resubmitting, `cancelled` as before (ADR 0017), and a watched
  one ends where it stopped. Each miss is logged as `login.move`, with `no-vault-match`
  for a page the item does not match.
- After the sign-in form showed again with nothing else in a frame, the tab asks for an
  account again (ADR 0021 D) in that frame, whose document is asked to announce again,
  as the tab's page is for a top-level login. Until delivery 2 the login stayed watched
  instead (chosen by an agent).

### Delivery 2: the popup

- While a login in a frame of the tab waits for an account, the popup offers the
  choice for the frame's origin, so a person with two Apple items can pick one. The
  choice says the sign-in form is embedded in this page from the frame's host, lists
  the frame origin's default first, and "Make it the default for" names the frame's
  host, since the pick's default is saved for the frame's origin (ADR 0017). The page's
  own default list stays beside it (chosen by an agent). The choice answer carries
  `frame`, and so does `login.popup`.
- A frame refused because only its own URL matches the item (`frame-top-mismatch`) is
  explained in the popup: the sign-in form embedded in this page (`idmsa.apple.com`) is
  not logged in to because this page (`evil.example`) does not match the item. The
  page's status carries the frame's origin as `mismatchedFrame`, and the page section
  shows the line under the login's.

### Delivery 3: generation

- A frame's page is sent for generation under ADR 0016's conditions, with the two
  conditions above. Only the frame's document is described, under its own origin and
  path (`https://idmsa.apple.com`, `/appleauth/auth/authorize/signin`), without its
  query, and the recipe made there is the frame origin's, as ADR 0017's recipes are. The
  tab's page is still sent only when it shows a sign-in input itself.
- A recipe's continuation after an `advance` (ADR 0018), its handlers' buttons (ADR
  0048, ADR 0081), automatic repair (ADR 0041) and the judge run in a frame as in the
  tab's page.

## Consequences

- A sign-in form in a frame of an item's site works like one in its page, at the same
  cost of one generation per page (Clef first, then Claude, ADR 0083).
- A frame's page goes to the service only when the item matches both the frame and its
  page, so an embedding page of another site gets nothing, and an advertisement frame
  costs one message on load, as before.
- Base-domain matching lets any page of the item's registrable domain embed the frame,
  as it already lets it fill one (ADR 0017).
- Until delivery 3, a frame logs in only with a recipe made for its origin some other
  way, as before.
- A watched login in a frame reads only new documents of its frame and the tab's new
  page: a change in place inside the frame's document, as Apple's code page, is not read
  again, so its result comes from the page that replaces the frame's page.
- A worker restart forgets the step's time, so after a restart within 30 seconds of the
  step the tab's new page is refused as busy until the login's site wait settles it; it
  is then watched, and the page's next announcement is read for its result.
- Whether a frame is gone is told only by Chrome answering that no document of it
  listens; a document that went away before it answered leaves the frame there.

## Alternatives

- Keep frames out of generation and only explain in the popup that the form is in a
  frame. No new send and no new cost, but Apple Account and banks with a sign-in frame
  would never log in. The owner chose the option above.
- Require the tab's new page to be on the same site as the frame. Apple's page and frame
  are both on `apple.com`, but a page embedding a vendor's frame would never complete.
