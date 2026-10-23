# Split personal-detail answers of the completion judge, paid run

Date: 2026-10-23. Branch `claude/project-thread-quolpf-split`, with the split-value
instructions of [ADR 0061](../adr/0061-personal-details-during-a-login.md) (decided 7).
Synthetic pages only (`*.example` origins, invented labels); total cost about $0.68 by
the run's own estimate from returned usage.

## Setup

As in the [earlier run](2026-10-23-detail-judge-eval.md): `createCompletionJudge`
unchanged (production instructions, response schema, `interpret` and `detailInputs`),
production limits, and the model built as `createClaudeGenerationModel` builds it,
changing only the model ID and effort. Settings: Opus 5.5 at effort `low` (production),
Sonnet 5.5 and Haiku 5.5 at `low`. Selects reach the judge as the signed-in extractor
now describes them: role `select`, a label and a place, no options.

## Results

Ten pages, one call per page and run. Opus ran four times while the changes below were
made, the third time on four pages only; the table shows its last run. Sonnet and Haiku
ran once, midway, with the select default and the first instruction change.

| Case | Expected | Opus, final | Sonnet | Haiku |
| --- | --- | --- | --- | --- |
| Birth date in year, month and day selects (English labels) | three `birth-date` parts | right | right | right |
| The same in Japanese, labels from the text before each select | three parts | right | right | right |
| Birth year and month selects, or phone last 4 (MUFG-like) | two parts, `phone-last-4` | right | `unclear` | `unclear` |
| Card number in four boxes of 4 | `card-number` parts 1 to 4 | right | right | right |
| Card expiry month and year selects | `card-expiry` month and year | right | right (`yy`) | right (`yy`) |
| PIN in four one-digit password boxes | `pin` parts 1 to 4 | right | right | right |
| Birth date in text boxes of 4, 2 and 2 | three parts | right | right | right |
| One input each: `yyyymm` and phone last 4 | as before, no parts | right | right | right |
| Signed-in settings page with language and country selects | `signed-in`, no details | right | right | right |
| Era-year birth date selects | no detail | right (`unclear`) | right (`unclear`) | right (`unclear`) |

Opus named every part right but often left out a date part's format: in 2 of its 5
split dates in the first run, 4 of 5 in the second, and all 8 in the third, which had
an instruction that every date part names its format. Without a default the `format`
check dropped the whole value. Sonnet and Haiku named a format every time. Per call,
Opus cost about $0.015, Sonnet $0.007 and Haiku $0.003 or less, at 1.5 to 6 s.

## Changes made

- A date part named without a format takes `yyyy`, `mm` or `dd`, or `yy` for a card
  expiry year in a two-character input; an input's `maxlength` must still hold it. A
  select is matched by number, so its format matters only for a year.
- The instructions say that every date part names its format and that a select, whose
  options the judge does not see, takes `yyyy`, `mm` and `dd`.
- A four-digit year matches an option that says only its last two digits when no
  option says the whole year, as Sonnet and Haiku named `yy` for an expiry select whose
  options the judge cannot see.

## Open

- Sonnet and Haiku answered `unclear` on the MUFG-like page that mixes selects with the
  sign-in form's own fields; Opus, in production, answered it right each time.
- Live pages, and pages judged beside the sign-in form, were not run.
