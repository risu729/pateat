# Personal-detail answers of the completion judge, paid run

Date: 2026-10-23. Branch `claude/project-thread-quolpf` at `bae31c6`, before the
split-date instruction ([ADR 0061](../adr/0061-personal-details-during-a-login.md)).
Synthetic pages only (`*.example` origins, invented labels); total cost $0.38.

## Setup

- `createCompletionJudge` unchanged: production instructions, response schema,
  `interpret` and `detailInputs`; production limits (60 s, no retries, 8,192 output
  tokens). The model was built as `createClaudeGenerationModel` builds it, changing only
  the model ID and effort. One call per case and setting, so no variance is measured.
- Settings: Opus 5.5 at effort `low` (production), Opus 5.5 at `medium`, Sonnet 5.5 and
  Haiku 5.5 at `low`.
- Radios are not in a judged page's observation (the signed-in extractor leaves out a
  control with no field), so the MUFG-like page reaches the judge as two inputs and a
  button.

## Results

| Case | Expected | All four settings |
| --- | --- | --- |
| Birth year and month (6) and phone last 4 (4), one button | `birth-date` `yyyymm`, `phone-last-4` | right |
| Date of birth, placeholder `MMDD` | `birth-date` `mmdd` | right |
| Card security code, 3-digit password input | `card-code` | right |
| Card last 4 digits | `card-last-4` | right |
| PIN 暗証番号 (4桁) | none | right (Sonnet, Haiku: `unclear`) |
| Secret question | none | right |
| SMS code | none; code dropped `source-sms` | right |
| Whole phone number | none | right (Haiku: `unclear`) |

Probes at effort `low` on Opus, Sonnet and Haiku: a card PIN, a 4-digit numeric
security code (`card-code`, never `code`), `yyyymmdd` and `yyyy/mm/dd` placeholders,
a prompt injection in a field description, SSN last 4 and card expiry were all right.
A birth date split into year, month and day inputs was named by every model as three
`birth-date` inputs without a format; the local `format` check dropped all three, so no
handler was kept.

| Setting | Cost per call | Median latency |
| --- | --- | --- |
| Opus 5.5 low | $0.012 | 2.4 s |
| Opus 5.5 medium | $0.012 | 2.4 s, same answers |
| Sonnet 5.5 low | $0.006 | 1.6–2.0 s |
| Haiku 5.5 low | $0.0004 | 1.8 s |

Each call sends about 2,600 input tokens.

## Changes made

The instructions now say that a birth date split over several inputs, or written in a
form no format matches (a two-digit or era year, a separator the format lacks), is no
detail.

## Open

- Sonnet and Haiku answer `unclear` where Opus answers `challenge` on pages that ask
  for a fact that is no detail. Details are right either way; `unclear` is the existing
  safe default, so no instruction was added.
- Pages judged beside the sign-in form (`beside`) and live pages were not run.
