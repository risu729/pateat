# ADR 0064: A form that shows no button is submitted by Enter in its last field

Status: proposed, implemented ahead of the owner's decision. On 2026-10-23 at 05:28 UTC
the owner said to set the phases aside for such work, proceed on a working rule and
decide afterwards, as for the other open PRs (「フェーズは一旦無視して、ある程度決め打ちで
進め、後から判断」); this ADR is that working rule, and its PR is left for the owner to
merge. Found on x.com
([#860](https://github.com/risu729/pateat/issues/860)). Amends
[ADR 0018](0018-recipe-generation-route.md) (what a plan's action may be).

Date: 2026-10-23

## Context

x.com's sign-in (`/i/jf/onboarding/web?mode=login`, checked in cloud Chrome 156 on
2026-10-23) shows a username field, "電話番号で続ける" and "Appleで続ける" buttons
(`type="button"`), and under the field a grey "続ける" that is a `<div><p>`, no button.
Only once the field has a value does the page add `<button type="submit">続ける</button>`,
twice (one 0x0, one 370x48). The page described for generation therefore has no control
that goes on with the username, and the generation role abstained with
`insufficient-evidence`. A person presses Enter, or the button that appears.

The official Bitwarden extension's auto-submit, which runs only for its "automatic app
login" policy, fills the form and then clicks a submit or login button it finds in the
form, else calls `requestSubmit()` on it
([auto-submit-login.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/content/auto-submit-login.ts#L111-L142)).

## Decision

1. **Plan.** When the form the plan fills shows no button that advances or submits, the
   generation role names the plan's last filled field as the action (one instruction
   line; the answer format is unchanged). The local check accepts the action equal to a
   filled field only when it is the last of the plan's fields, inside a `<form>` (the
   observation's `group`) and not a code field; its `advance` or `submit` is read from
   the page as for a button (#834).
2. **Recipe.** Such a plan becomes the usual preparing fill and then a click with
   `press: "enter"` whose target is that field:

   ```json
   { "kind": "fill", "path": "/i/jf/onboarding/web",
     "fields": [{ "slot": "username", "target": { "by": "id", "value": "jf-input-username_or_email" } }] },
   { "kind": "click", "path": "/i/jf/onboarding/web",
     "target": { "by": "id", "value": "jf-input-username_or_email" },
     "purpose": "advance", "press": "enter" }
   ```

   The contract allows `press: "enter"` only on a field locator, right after a preparing
   fill on the same path whose last field is that target, and never for the `totp` slot.
   Everything else treats it as a click: the submission budget, a CAPTCHA left to the
   person, the result checks and retries, a fill-only login stopping before it, and a
   later page on the same path continuing it.
3. **Executor.** The field must be the one element the target names, writable and
   filled by this attempt since the last effect, inside a form. The form's default button
   is read then: its first submit button (`<button type=submit>`, `<input type=submit>`
   or `type=image`) in tree order, as Enter uses. That button is pressed with `click()`,
   as Enter does; with none, the form gets `requestSubmit()`, Bitwarden's fallback. The
   step fails `target-missing` without submitting when the default button is disabled
   (Enter does nothing then), is only associated with the form from outside it (`form=`),
   or was already shown when the attempt's fill began: such a button was on the page the
   model saw and did not name. A form the page's own constraint validation refuses is not
   submitted (`fill-rejected`). Before submitting, the checks of a click run: the
   destination of the default button, or of the form without one
   ([ADR 0051](0051-form-destinations-by-item-uri-match.md)), the form still holding the
   values filled into it, and a CAPTCHA.

## Consequences

- x.com's first page gets a recipe: with this rule the production generation role
  (`claude-opus-5-5`, effort `low`) answered the observation above with the username field
  as the action and purpose `advance` in 3 of 3 calls on 2026-10-23 (about $0.013 each),
  and with an added "次へ" button it named that button instead (2 of 2). Signing in on
  x.com itself is not tested; it needs the owner's account.
- A page whose only submit button stays visible from the start, such as a form with a
  "Sign up" submit before the login fields, is never submitted this way: the login ends
  `structural-mismatch` (`target-missing`) after the fill, as a click that finds no
  button does.
- A form that a person can only submit through a script button outside the form, or
  that has no `<form>`, still gets no recipe.
- `requestSubmit()` goes beyond what Enter does in one case: a form with no submit button
  and several text inputs, which HTML does not submit on Enter. Bitwarden submits it.
- Logs and outcome causes gain no new value.

## Alternatives

- **A fill step that submits through a new `event: "submit"`**: refused by its review.
  An effectful fill counts as submitted before anything is typed, a fill-only login would
  never fill the field, and the contract forbids a click after such a fill on the same
  path, which x.com's password page on the same path needs.
- **A new step kind `submit`**: equivalent to the click with `press: "enter"`, but every
  place that treats a click as the submission (budget, CAPTCHA hold, retries, code steps)
  would need it added.
- **Bitwarden's keyword search for a login or "next" button**: language word lists are a
  site-specific style of rule (ADR 0033) and the model already judges the buttons it sees.
- **Typing a real Enter key**: a content script cannot send a trusted key press;
  `click()` on the default button is what the browser's implicit submission does.
