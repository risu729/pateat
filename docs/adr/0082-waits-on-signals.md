# ADR 0082: Waits for the page wait on signals, not on set times

Status: accepted by the owner on 2026-11-03 at 03:31 UTC, who wrote
「固定の待ちは基本的に 禁止します。」 (fixed waits are basically forbidden) after asking
at 03:20 UTC why logins are so slow. The rule is the owner's. Which signal replaces each
wait, and the order in which the waits are replaced, are Claude's and were not confirmed
one by one. The first replacements (below) are checked with local and CI tests only, not
yet on a real site. Amends [ADR 0010](0010-inference-field-hints.md) (the 500 ms before
the fill check), [ADR 0067](0067-software-keyboard-entry.md) (the keypad's 25 ms reads)
and [ADR 0070](0070-shadow-roots-as-page-content.md) (the half-second count of undefined
custom elements).

Date: 2026-11-03

## Context

In the 7 days before 2026-11-03, logins that needed no AI took 11.3 s at the median in
production, of which only 2.8 s were booked as the site's own time (`pageMs`, see
[Request and login timing](../architecture.md#request-and-login-timing)). An inventory
of the login path (`designs/fixed-waits-inventory.md` in the project files, from
`dd5a9f3`) found about 30 places where the extension waits a set time instead of a
signal: pauses for the page's handlers (500 ms before the fill check, 25 ms between
fields and after each value), "the DOM has been quiet for N ms" rules, settle periods
after a result (3 s, 1 s rechecks), and polls every 50, 100 or 500 ms whose interval
adds to every step. A pause sized for a slow page is paid in full by every fast one, and
a poll adds half its interval on average to every wait.

## Decision

1. The extension never waits a set time for the page to react. A wait for the page
   waits on a signal: an event, a mutation observer's record, a document or resource
   `load`, a frame the page renders, or a message's answer.
2. A timer is allowed only as the bound of a wait whose signal may never come. Reaching
   it is an outcome of its own (a timeout, a fallback), never the path a page that
   answers takes.
3. A wait for something to show, or for a condition on the page, checks at once and then
   again at each change of the page (`pageChange` in `src/page/page-change.ts`), until
   its bound. A change is: a DOM change in the document or any of its shadow trees (any
   node, text or attribute); a resource's `load` or `error`, a CSS animation or
   transition ending, a popover or `<details>` toggling, or a value typed or chosen, in
   the document or a shadow tree; the window's `load`, `resize`, `popstate`,
   `hashchange` or `pageshow`; a same-document navigation (Navigation API
   `currententrychange`); the document's ready state or visibility changing; or the page
   defining one of its custom elements. Changes are taken together until the page's next
   frame, so a page that changes all the time is checked at most once a frame.
4. A wait for the page's own handlers after Pateat's events (after a value's characters,
   between a fill's fields and a split code's digits, and before the fill check of ADR
   0010) waits for the page's next rendered frame (`nextFrame` in `src/page/frames.ts`):
   by then the handlers, their microtasks and the timers they set for now have run, and
   what they changed is rendered. A hidden page renders no frame and waits one task. A
   document that reads as shown but whose frame Chrome does not render, as an off-screen
   frame, gets no animation frame, so this wait has a 100 ms bound.
5. When the page defines a custom element it had not defined, the content script checks
   the page at the next frame. Chrome's isolated world has no `customElements` (it is
   `null` there), so the main-world script waits with `customElements.whenDefined` for
   each name the isolated world asks about and reports each definition with an event
   (`src/page/element-definitions.ts`). The events carry only the element's name, which
   the page itself holds, and nothing is read back but that a definition happened.

### Replaced on 2026-11-03

| Wait until then | Where | Now |
| --- | --- | --- |
| 500 ms before the fill check (`fillSettleMs`) | `login/content.ts`, `login.execute` fill | Decision 4 |
| 25 ms between fields, digits and after each value (`FIELD_GAP_MS`) | `page/enter-value.ts`, `login/content.ts` | Decision 4 |
| 500 ms count of undefined custom elements, for ten seconds (`watchUpgrades`) | `login/content.ts` | Decision 5 |
| 100 ms debounce before the page watch's check (`schedule`) | `login/content.ts` | Next frame after a change |
| 50 ms polls of `login.await` and a `wait` step | `login/content.ts` | Decision 3 |
| 100 ms polls of the entry inspect and check and the switch's control and reaction | `login/content.ts` | Decision 3 |
| 100 ms poll of the URL after an entry press (`watchPressedUrl`) | `login/content.ts` | `popstate`, `hashchange`, `currententrychange` |
| 100 ms debounce of the look after a same-document route (`urlChanged`) | `login/content.ts` | Next frame after a change |
| 50 ms and 25 ms polls of a software keypad's keys and field | `page/keypad-typing.ts` | Decision 3 for the keys; each rendered frame for the field, as a keypad's script may write it with no event or DOM change |

Their bounds stay: `LOGIN_STEP_WAIT_MS`, each step's `timeoutMs`, `KEYPAD_OPEN_MS` and
`KEYPAD_PRESS_MS`, `LOGOUT_REACTION_MS`.

### Still to replace

These waits remain set times and fall under the rule; each is replaced in its own
change, in the order of the inventory (largest added time first):

- The 3 s observation budget of a result no marker proves, `WATCH_SETTLE_MS`,
  `SIGN_IN_RECHECK_MS` and the cross-origin move's readings (`quietMove`) after a
  submission ([ADR 0027](0027-per-account-login-routes.md),
  [ADR 0029](0029-local-sign-in-state.md),
  [ADR 0022](0022-login-attempts-per-tab-and-origin.md)).
- The shown-account check's `accountQuietMs`/`accountWaitMs` before a password-only
  fill, and the same quiet after an in-place account switch
  ([ADR 0078](0078-the-pages-own-account-switch.md)).
- `CODE_SETTLE_MS` of a code fill ([ADR 0027](0027-per-account-login-routes.md)): a page
  that verifies a code late may give no earlier signal, so a shorter residual bound may
  have to stay; that is the owner's call.
- `SWITCH_QUIET_MS` and `SWITCH_POLL_MS` of an account switch
  ([ADR 0063](0063-switch-accounts-from-the-popup.md)).
- The background's reconcile poll intervals, the 100 ms poll for a page's conditional
  passkey request, and the 500 ms retry of a start announcement.
- The offer decision's quiet DOM (`offerQuietMs`, `offerWaitMs`) is the owner's own rule
  of [ADR 0057](0057-decide-no-input-pages-when-the-dom-is-quiet.md); changing it needs
  the owner's word.

## Consequences

- Each preparing fill is about 0.5 s faster, and each field about 50 ms; a page whose
  form or next step shows after a change is checked within a frame instead of up to
  50-500 ms later.
- A page validator that shows its error only after a debounce longer than a frame shows
  it after the click, not before; the click then meets the page's own refusal, as a
  person's would, instead of the fill ending `fill-rejected` before it.
- A change that sends none of the signals of decision 3, as a shadow root attached to an
  element already defined with no other change, a stylesheet rule changed through the
  CSSOM or a Web Animations API animation ending, is seen at the page's next signal, or
  not before the wait's bound. Before, a poll saw it within its interval.
- Bitwarden's autofill waits 20 ms between actions; Pateat waits for a frame instead
  ([differences](../bitwarden-differences.md)).
- The main world's events tell a page that Pateat is installed, as its main-world click
  already does.
