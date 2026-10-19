# ADR 0057: Pages without a sign-in input are decided once the DOM is quiet

Status: accepted by the owner on 2026-10-19. At 20:22 UTC the owner chose the decision
card's option 「DOM が静かになったら」 (once the DOM is quiet), described as 「1
秒変化が無ければ決める (最大 10 秒)。入口とアカウント一覧も速くなる。」 (decide when
nothing has changed for one second, at most 10 seconds; entries and account lists get
faster too), and at 20:23 UTC added 「動きがあっても5秒でいい」 (5 seconds is enough
even if it keeps changing), which sets the limit to 5 seconds instead of 10. Implemented
in the extension (local tests only; not yet checked in the owner's Chrome). Amends
[ADR 0016](0016-recipe-generation-trigger.md),
[ADR 0028](0028-account-chooser-login-pages.md) and
[ADR 0031](0031-sign-in-entry-pages.md).

Date: 2026-10-19

## Context

On a page the background may send for generation (ADR 0016), the content script waited a
fixed 10 seconds, the step wait (`LOGIN_STEP_WAIT_MS`), before deciding what a page that
shows no sign-in input is: a list of accounts (ADR 0028), a site's sign-in entry
(ADR 0031), a page that asks for an account identifier alone (ADR 0016), or nothing to
send (logged as `nothing-offered`). A page that had finished rendering at once still
waited the full 10 seconds before its first generation started. The same wait also
ended the window in which a page that shows a sign-in input is sent.

## Decision

- The wait begins when the content script learns that its page may be sent. It ends
  once the page's DOM has not changed for 1 second, or 5 seconds after it began even if
  the DOM keeps changing. Then the page is decided exactly as before.
- Not confirmed by the owner: a DOM change is what the content script's existing
  `MutationObserver` reports while it watches for a recipe's first step (added or
  removed nodes, text changes, and changes of the attributes that can change whether a
  target matches, shows or accepts input, such as `class`, `style`, `hidden` or
  `value`), plus a same-document URL change (`popstate` or the Navigation API's
  `currententrychange`). The background answering the page again while it waits does
  not move the 5-second limit.
- Not confirmed by the owner, added so that ADR 0016's window stays as it was: this wait
  only decides what a page without a sign-in input is. When it finds a list of accounts,
  a sign-in entry or an identifier input, the page is sent at once and nothing else is
  offered for it. Otherwise a page that shows a sign-in input within 10 seconds of the
  wait's start is still sent as a sign-in page, and the `nothing-offered` log is still
  written at those 10 seconds, with the reason as it stands then.
- Not confirmed by the owner: the 5-second limit and the 10-second window are timers
  started once when the wait begins; the quiet second is a timer started again on each
  DOM change.
- The other 10-second waits do not change: a login step's wait for its elements, the
  log's `not-started` for a sign-in input that shows without a ready first step, and the
  checks on the page after an entry press.

## Consequences

- A still page without a sign-in input is decided about a second after the content
  script starts watching. In the synthetic browser test, the entry page reached the
  synthetic model about 1.2 seconds after navigation began, and one whose text changes
  every 200 ms about 5.2 seconds after, instead of over 10 seconds for both.
- A page that renders its account list, entry link or identifier input only after a
  quiet pause of more than a second, such as after a slow request, or later than 5
  seconds, is decided before it shows them and is not sent for them on that visit; it is
  logged as `nothing-offered` (`no-list`) at 10 seconds unless a sign-in input shows
  first. A later visit that shows them in time is sent as before. A sign-in form shown
  after such a pause, but within 10 seconds, is still sent, as the synthetic browser
  test with a form shown after 2.5 quiet seconds checks.
- Changes outside the observed attributes, such as a canvas drawing or a CSS animation
  that changes no attribute, do not count, so such a page is decided after a second.

## Alternatives

- A fixed 3 seconds for passkey-only pages only, other pages keeping 10 seconds: faster
  only for those pages, and a page-kind rule to keep up.
- Keep the fixed 10 seconds: no early decision, but every first visit to such a page
  waits 10 seconds.
- The card's own limit of 10 seconds for a page that keeps changing: replaced by the
  owner's 5 seconds.
