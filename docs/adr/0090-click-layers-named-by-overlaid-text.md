# ADR 0090: A click layer named by the text laid over it

Status: accepted by the owner on 2026-11-28 (decision card answered "採用して実装する"
at 00:53 UTC). At 00:54 UTC the owner added 「クリック時の照合も入れて。」 (also check
at click time). Implemented. Tested only with local and synthetic tests; not yet tried
on the real page. Found on UNSW's Endeavour sign-in
(`https://unsw.openacademies.com/Apps/Endeavour/`). Amends
[ADR 0018](0018-recipe-generation-route.md) (what a plan's action may be). Points marked
"agent's choice" below go beyond the owner's answers and are not confirmed by the owner.

Date: 2026-11-28

## Context

Endeavour's sign-in opens after "click here to begin". It is a dialog drawn entirely in
absolutely placed `<div>`s. There is no `<form>`, no `<button>`, no `role` and no
`<label>`. The two inputs are `input#232:credentialElement` (`autocomplete="username"`)
and `input#240:credentialElement` (`type="password"`,
`autocomplete="current-password"`). The "log on" control is a stack of sibling layers
inside one container:

```html
<div id="214:spaceElement">
  <div id="274"><div id="274:areaElement" tabindex="-1" style="cursor: pointer; pointer-events: auto"></div></div>
  <div id="276">…background, z-index 2, pointer-events: none…</div>
  <div id="284">…the text "log on", z-index 6, pointer-events: none…</div>
</div>
```

`274:areaElement` takes the click but holds no text. The text that names it sits in a
sibling that clicks pass through. Every element in the app carries `tabindex="-1"`. The
login description therefore had the two inputs and no button. The generation role
answered Enter in the password field, and the plan check refused it as
`duplicate-candidate`, because Enter is taken only in a field inside a form
([ADR 0064](0064-enter-in-a-form-without-a-button.md)). This happened at 2026-11-12
16:20 and 16:32 UTC and at 2026-11-28 00:38 UTC (`inference_log`
`01a21f96-8ce2-775b-85b3-6d9cf701fc31`).

Results in cloud Chromium 156 on 2026-11-28, with a made-up account:

| What was done                                                      | Result                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Fill both inputs, then script `.click()` on `274:areaElement`       | `POST /Commander/command.api`, "Authentication failed"     |
| Fill both inputs, then dispatch `keydown`/`keypress`/`keyup` Enter | Nothing is sent: "You must enter your password"            |

So pressing Enter cannot fix this page; clicking the layer can. The ids were the same
across loads at 1920×1080 and 1100×800. They look like a counter in document order (214,
232, 240, 244, 259, 274, 326), though, so a site update may shift them.

## Decision

1. **Click layer.** An element is a click layer when all of these hold:
   - It has no `role`, and its `tabindex` attribute is a negative integer.
   - It is no form control, `<a>`, `<label>` or `<summary>`, it is not editable, and it
     is not inside an `<a href>`.
   - It sets `cursor: pointer` itself, rather than inheriting it.
   - It is shown, and it holds no text and no control, link, `role` or `tabindex`
     element.

   Requiring a `tabindex` keeps the search to the elements the extractor already looks
   at (`[role], [tabindex]`). A negative `tabindex` together with the pointer is a
   stronger signal than the pointer alone (agent's choice, from the design review).
2. **Its text.** A click layer is named by the text of its nearest ancestor, at most
   three levels up, that renders text. That ancestor is neither the body nor the root,
   and it must meet these conditions:
   - Every shown text node in it has its centre inside the layer's box.
   - It holds no control, link or `role` element.
   - It holds no other element that sets the pointer cursor.
   - Its text, redacted and collapsed as a label is, is 1 to 120 characters.

   That text is the layer's overlaid text (`overlaidLabel`).
3. **Description.** A login page describes click layers only when both hold:
   - It has fields outside every form.
   - No button candidate sits in the area around those fields (`formlessFieldsArea`, or
     the whole page when that area reaches the body).

   It then searches that area outside every form. A click layer becomes a candidate when
   the page's hit test at its centre lands on it or inside it, so clicking its text
   reaches it. The candidate is a `button` with the overlaid text as its `label` and
   `overlaid: true`. It is located like any script button, never by text, and is left
   out when nothing locates it. On Endeavour the description gains four candidates:
   "exit", "recover profile", "log on" and "×". A layer outside the viewport, or one
   covered at its centre when the page is read, is not described. A layer whose label
   shows the account's username is left out rather than hidden as `[account]`, since its
   label is compared as shown when it is pressed (agent's choice).
4. **Plan and recipe.** Only a plan's action may be a click layer. Its click step
   records the label as `shows`:

   ```json
   { "kind": "click", "path": "/Apps/Endeavour/",
     "target": { "by": "id", "value": "274:areaElement" },
     "purpose": "submit", "shows": "log on" }
   ```

   `shows` is set only on a click that presses no key, and its target is never a text or
   name locator. A click layer with no label, or named as an account switch, refuses the
   plan (`incompatible-role`). A click layer named as a passkey, password or
   authenticator button, a code's or details' submit, an SSO entry or a handler's button
   is left out or refused, and the SSO click and a start alias never take one: a start
   alias reuses a recipe only when the page's layer shows the step's `shows` (agent's
   choice, from the code review).
5. **Click-time check (owner, 00:54 UTC).** Readiness counts a click layer as
   clickable. The executor clicks one only when the step has `shows` and the element's
   overlaid text equals it at that moment. A step without `shows` never clicks a click
   layer. Either mismatch fails `target-missing` without clicking. This check does no
   hit test, so a dialog outside the viewport is still pressed.

## Consequences

- If the site's counter ids shift and the stored id names another layer, such as "exit",
  the click-time check refuses the step instead of pressing it.
- No submit-destination check applies to these clicks, because they submit no form. The
  same is true of every script button
  ([ADR 0051](0051-form-destinations-by-item-uri-match.md)).
- An invisible click layer over a card's text is described only when the fields beside
  it show no other button, so the change reaches only pages that had no action before.
- The labels "username" and "password" on Endeavour are still not read. The inputs'
  `autocomplete` tokens are enough.
- A signed-in page with nothing else to describe that shows such a layer may complete
  the login unconfirmed
  ([ADR 0029 amendment of 2026-11-28](0029-local-sign-in-state.md#amendment-a-page-with-nothing-to-describe-completes-unconfirmed-2026-11-28)).
  The layer is not described there and never becomes a signed-in marker.
