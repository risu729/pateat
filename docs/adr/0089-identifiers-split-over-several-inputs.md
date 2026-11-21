# ADR 0089: An identifier split over several inputs

Status: accepted by the owner on 2026-11-21 (decision card answered option A at 19:00
UTC), with the condition written at 18:59:58 UTC:
「Aでいいと思うが、1桁ずつのtotpとは別のものとして扱ってね。判定とか。入力とかで共通化はしていいけど」
(A is fine, but treat it as something separate from the one-digit-per-input TOTP: its
detection and so on. Sharing the typing code is fine). Implemented; local and synthetic
tests only, not yet tried on the real page. Found on ゆうちょダイレクト
([#1758](https://github.com/risu729/pateat/issues/1758)). Amends
[ADR 0016](0016-recipe-generation-trigger.md) (a page that asks for an identifier
alone), [ADR 0018](0018-recipe-generation-route.md) (what a plan's field and action may
be) and [ADR 0064](0064-enter-in-a-form-without-a-button.md) (where Enter is pressed);
kept apart from [ADR 0027](0027-per-account-login-routes.md)'s split code inputs and
[ADR 0061](0061-personal-details-during-a-login.md)'s split values. The points marked
"agent's choice" below go beyond the owner's answer and are not confirmed by the owner.

Date: 2026-11-21

## Context

ゆうちょダイレクト's first login page (`U010101WAK.do`) asks for the customer number in
three `type="text"` inputs, `okyakusamaBangou1` to `okyakusamaBangou3`, with `maxlength`
4, 4 and 5, in one `<form>`, under the sentence
「以下の欄に、お客さま番号を入力してください。」. The inputs have placeholders
(「半角数字4桁」) and no `<label>`, ARIA name, `autocomplete` or `inputmode`; their ids
(`focus1`, `focus2`, `focus3_off`) are not numbered alike. The form also holds a
checkbox that saves the number and two buttons, 「ログインパスワードを
入力してログイン」 and 「アプリでログイン」; the password page is on another origin
(`direct2`), which already had its own recipe. The Bitwarden item holds the number as
one username, `NNNN-NNNN-NNNNN`.

Pateat filled nothing there, for two reasons. The page was never sent:
`identifierInput` returns `sole` only for a page with exactly one text-like input, and
the owner's Chrome logged `recipe.generate` `skipped` (`no-listed-account`) and
`login.refused` `recipe-not-found` on every visit. And a recipe could not have filled
it: a plan and a recipe fill step map one slot to one input, and the same slot twice is
refused (`duplicate-slot`, `Duplicate fill slots`). Before this ADR, only a `totp`
handler's code typed one digit per input (ADR 0027) and only a `detail` handler split a
value, by the judge naming each part (ADR 0061).

## Decision

1. **A group.** 2 to 6 inputs are one split identifier when they are shown and writable,
   of type `text` or `tel` (a `number` input ignores `maxlength`), in one form (or all
   outside every form), side by side among that form's shown text-like inputs (`text`,
   `email`, `tel`, `number`, `url`, `password`, `search`), named, by `name` or else by
   `id`, as one stem followed by the numbers 1, 2, 3… in order, and each with a
   `maxlength` of 2 to 8. A run of such names longer than six is no group. No site is
   named ([ADR 0033](0033-no-site-specific-features.md)). The rule
   (`apps/extension/src/page/split-identifier.ts`) is its own, apart from the split code
   inputs of ADR 0027: an input of one character is never a part, and the split code's
   detection and its checks do not read this rule, as the owner asked.
2. **The trigger.** For ADR 0016's page that asks for an identifier alone, a group
   counts as one input, its first. When it is the page's only text-like input, no part
   carries an autofill field name, it is in no sign-up form and it names an identifier,
   the page is `sole` and is sent. It names one by the same words as one input: by its
   parts' own names, ids, placeholders, `aria-label`s and labels, and their shared stem
   (`tel` of `tel1` to `tel3`), or else by the text that labels the group by layout,
   read from the parts' nearest common ancestor by the rule a single field's label is
   read with (`groupLabel`). The number words of the 2026-11-09 amendment of ADR 0016
   and their exclusions apply, so `電話番号`, `郵便番号` or a `tel` or `zip` stem keeps
   a group out. Agent's choice: a checkbox or radio button beside the group, such as
   ゆうちょ's 「お客さま番号を保存する」, does not stop that reading, as another field
   does.
3. **The description.** A login page's description keeps one candidate per input and
   marks each part of a group that names an identifier by the trigger's words of 2
   (agent's choice, so a phone number, postal code or date in boxes is never marked and
   generation's sentence of 4 holds) with `split: { group, part, of }` (`group` `s1`,
   `s2`… in page order; `part` from 1; `of` the group's size). Only the login page's
   description carries it, so the judge of ADR 0061, which names each part of a card
   number or date itself, reads descriptions without it. Agent's choice: the first part,
   when it has no label of its own, takes the group's label, so the model reads what the
   boxes are for. The contract (`observedCandidateSchema`) accepts the mark only on a
   `text` or `tel` field with a `maxLength` of 2 to 8, and every group must list its
   parts 1 to `of` once each, in page order and in one form. A marked part is never a
   code input (`isCodeField`), whatever its type or `inputmode`, so a group of `tel`
   boxes left empty after its first does not make the click a submission, and Enter may
   be pressed in its last part.
4. **The plan.** The answer's shape is unchanged: the identifier slot maps to the
   group's first part. Generation's instructions say: "Elements with split are the parts
   of one identifier typed in turn into consecutive inputs without its spaces and
   hyphens: map its slot to part 1 alone, never another part." Clef's questions show the
   first part with the parts' total `maxLength` and say it is the first of the group's
   inputs, show the others as parts, and ask no question of the others. The plan check
   refuses any slot in a part other than the first, and any slot but an identifier in a
   group (`incompatible-role`, agent's choice for the second). The device's value check
   (`checkPlanValues`) compares the value with the parts together.
5. **The recipe.** The fill field keeps `target`, the first part, and gains `split`:
   each part's `maxlength`, from the description, never from the model:

   ```json
   { "slot": "username", "target": { "by": "id", "value": "focus1" }, "split": [4, 4, 5] }
   ```

   `split` holds 2 to 6 lengths of 2 to 8; a field never has both `split` and a `keypad`
   ([ADR 0067](0067-software-keyboard-entry.md)), and only a preparing fill has one.
   Everything that reads `field.target`, as readiness, the start check and repair
   ([ADR 0041](0041-repair-stale-recipes.md)), reads the first part.
6. **The value.** After the vault read, on the device only, the value is taken in NFKC
   with every space and every hyphen or dash taken out (ASCII, full-width once in NFKC,
   and U+2010 to U+2015 and U+2212, agent's choice for the last), then every part but
   the last takes exactly its length and the last the rest, 1 character up to its
   length. Letters stay, unlike a card number's digits in ADR 0061. A value that does
   not fit fills nothing: the login ends `challenge` with the cause `identifier-unfit`
   before the page gets the step, as a `detail` value that fits none of its inputs does.
   The value is never logged or sent.
7. **The fill.** The content script finds the other parts from the first by the rule of
   1, and fills nothing unless it finds as many parts as `split` names, each with the
   `maxlength` `split` gives (`structural-mismatch`, `split-mismatch`, agent's choice of
   code), and the value's parts fit them. Each part is typed as a field is
   ([typing](../architecture.md#background-execution)), in order, one frame apart, with
   the field's checks after every wait and each part still the group's. The page's own
   validation after the fill reads every part. A login, a fill-only login and the
   popup's **Log in now** and **Fill** ([ADR 0088](0088-popup-manual-login.md)) all fill
   a recipe step this way. So do the passive fills of
   [ADR 0035](0035-page-kinds-per-site.md), a sign-in fill and a confirmation fill (the
   latter also from the popup's **Fill** on a confirmation page), with every part as the
   field's input: a value kept in any part, or any part the person edited, keeps the
   whole field; each part is claimed and protected as the one input would be; and once
   the form's destinations change, every part the person has not edited gets back its
   value from before the fill ([ADR 0051](0051-form-destinations-by-item-uri-match.md)).
   A sign-in fill's value that does not fit ends `identifier-unfit` as in 6, since it
   runs the recipe's steps as a login does. A confirmation fill's value that does not
   fit never reaches the page: the fill stops before it sends the step, as a
   confirmation fill that cannot go on does, with no cause of its own. The account check
   that a fill leaves to the next press clears every part on another account
   ([ADR 0049](0049-start-at-a-later-step.md)).
8. **Enter.** A form without a button to press is submitted by Enter in the group's last
   part (ADR 0064): the plan's last field may be the group's first part, or the model
   may name its last part as the action; the click step names the last part.

## Consequences

- ゆうちょダイレクト's first page is sent once its item matches, and a plan fills the
  number and presses its advance button; the password page on `direct2` then starts its
  own login, as Mizuho Direct's two origins do (the first ends `left-origin` after its
  `advance` click, ADR 0016 amendment of 2026-11-09).
- `login.attempt` gains the cause `identifier-unfit`, and the step's page reasons gain
  `split-mismatch`; both are codes in the first-login result
  (`loginOutcomeCauseSchema`).
- A phone number in `tel1` to `tel3` or a postal code in `zip1` and `zip2` is a group
  by the rule of 1, but it names no identifier: it is neither marked nor sent as a page
  that asks for an identifier alone.
- A page that asks for a split identifier beside a password field is sent as any login
  page is; its group is marked the same way.

Known misses:

- Inputs numbered from 0 (`no0`, `no1`), named with letters (`no_a`) or brackets
  (`no[1]`), with neither `name` nor `id`, or without `maxlength` are no group, and the
  page is not sent as one that asks for an identifier alone.
- A part whose `maxlength` is 1, as an identifier of one character per box, is left to
  ADR 0027's code rule and never filled as an identifier.
- A page that moves the focus to the next box itself once one is full is typed into as
  any page is; whether such a page's own checks pass is not tested on a real page.
- A page that disables or hides the next box until the previous one is full has no
  group, since every part must be shown and writable when the page is read: it is
  neither sent as one that asks for an identifier alone nor filled as a split
  identifier.

## Alternatives

- **B: the model names every part**
  (`{ "slot": "username", "candidates": ["c1", "c2", "c3"] }`), as ADR 0061's judge
  does. It works without numbered names, but Clef cannot answer that shape, so every
  such page would go to Claude, and both the instructions and Clef's questions would
  change. Can be added when a page the rule of 1 misses shows up.
- **C: custom fields per part** (`お客さま番号1` to `3` in the item), with only the
  trigger changed. It keeps the number twice and departs from the official clients' one
  username.
- **One candidate for the whole group** in the description, the first draft of A: the
  review found it would break ADR 0061's judge, which names each part.
