# Agent skills for pruning low-value tests

Researched: 2026-10-12, from public web pages and the repository at `e902ef3` (main).
The owner asked for a recent, well-known agent skill that removes the excess tests AI
agents write. Nothing was installed or run against Pateat; star and install counts are
the values the pages showed on 2026-10-12. The owner chose OpenClaw's `test-audit` on
2026-10-12 at 07:43 UTC; the plan is in [the roadmap](../plan.md#phase-1-usable).

## Pateat's test suite today

These numbers are a snapshot to compare against, not a target. The pruning work
re-measures them (counts and CI times) on the current main when it starts and again
after each batch (owner, 2026-10-12 07:48 UTC).

Counted at `e902ef3` from tracked `*.test.ts(x)` and `*.spec.ts(x)` files; "tests" are
`it(`/`test(` declarations including `.each`. Together they are 123 files, 58,717 lines
and about 2,150 tests, against 45,889 lines in the other tracked TypeScript files.

| Kind | Tool | Where | Files | Lines | Tests |
| --- | --- | --- | --- | --- | --- |
| Unit, in Node | Vitest | `apps/extension` (outside the three folders below), `packages/bitwarden`, `packages/contracts`, `packages/inference` | 78 | 40,292 | 1,601 (74%) |
| Service | Vitest with `@cloudflare/vitest-plugin` (Workers runtime, local D1) | `services/api` | 9 | 5,443 | 196 (9%) |
| In-browser component | Vitest Browser Mode on Playwright's Chromium | `apps/extension/src/{observation,page,diagnostics}`, `tests/options`, `tests/manage` | 21 | 6,610 | 232 (11%) |
| End-to-end, packaged extension | Playwright | `tests/extension` | 15 | 6,372 | 121 (6%) |

The suite is not end-to-end heavy; the largest single group is the extension's Node unit
tests (38 files, 23,806 lines, 888 tests).

In CI run [38219015105](https://github.com/risu729/pateat/actions/runs/38219015105)
(main at `e2ba5d1`), the whole workflow took 3 min 48 s. The `Verify` job, which runs
lint, typecheck, builds and every Vitest suite, took 2 min 58 s. The end-to-end tests
ran in six Linux shards of 52 s to 1 min 55 s each, and six Windows shards of 1 min 6 s
to 2 min 20 s, which run only on main since
[#300](https://github.com/risu729/pateat/pull/300). Coverage and CI duration are handled
separately in the roadmap; this note only covers the skill.

## Candidates

| Skill | Source | Popularity | Last change | What it does |
| --- | --- | --- | --- | --- |
| `test-audit` | [openclaw/openclaw `.agents/skills/test-audit`](https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit), MIT | Repository ~392k stars; [732 installs on skills.sh](https://skills.sh/openclaw/openclaw/test-audit), first seen 2026-08-11 | 2026-10-12 (history from 2026-08-10) | Gate for new tests plus a deletion workflow with evidence per test |
| `test-audit` (gstack) | [garrytan/gstack `test-audit/SKILL.md`](https://github.com/garrytan/gstack/blob/main/test-audit/SKILL.md), MIT | Repository ~136k stars | 2026-10-11 (created 2026-09-30, per skills-hub.ai) | Whole-repo sweep that only reports until the user approves a batch; a retirement card per test; runs through gstack's own scripts under `~/.claude/skills/gstack/bin/` (start/end, decision log, telemetry) and hands landing to its `/ship` |
| `test-audit` (BuilderIO) | [BuilderIO/agent-native#6643](https://github.com/BuilderIO/agent-native/pull/6643), opened 2026-10-02, not merged | One project | 2026-10-02 | Same structure as OpenClaw's (authoring gate, junk patterns, retention bar, campaign guide) |
| `test-sweep` | [LucasSantana-Dev/sharekit](https://claudskills.com/skills/test-sweep/) | Individual project; no counts shown | 2026-07-12 | Chains test-health → test-cleanup → mutation-test; stops if cleanup would remove more than 30% of tests; the listing does not state the deletion criteria |
| `test-driven-development` | [obra/superpowers](https://github.com/obra/superpowers) (reference `writing-good-tests.md`; formerly `testing-anti-patterns`), MIT | ~298k stars | — | Prevention only: test real behavior, not mocks; does not remove existing tests |
| `ln-55-test-suite-auditor` | [levnikolaevich/claude-code-skills](https://github.com/levnikolaevich/claude-code-skills), MIT | 575 stars | — | Reports risk coverage and maintenance value; "does not edit tests" |

[`claude-codex-settings-test-audit`](https://skills-hub.ai/skills/claude-codex-settings-test-audit)
on skills-hub.ai has the same description as OpenClaw's, no installs and is marked
unverified; it is not counted separately.

## OpenClaw `test-audit` in detail

The skill is three files: `SKILL.md` (57 lines), `CAMPAIGN.md` (whole-subsystem pruning)
and `references/audit.md`. Its commits are by OpenClaw's maintainers, starting with "add
test-audit authoring gate" (2026-08-10) and "prevent junk tests and add subsystem
test-pruning campaigns"
([openclaw#156316](https://github.com/openclaw/openclaw/pull/156316), 2026-09-23).

What it asks the agent to do:

- **Before adding a test**, answer: which observable behavior or contract it protects;
  which credible regression makes it fail; why existing tests miss it (one primary owner
  per contract, at the strongest boundary); whether it needs an export, flag or hook
  that production never calls.
- **Junk patterns** to remove: assertion-free probes, self-comparisons, expected values
  computed by the code under test, copied inventories or export lists, exact source or
  string greps, call-shape assertions that duplicate a boundary test, test-only exports
  and wrappers, mocks that implement the asserted behavior, negative tests that pass on
  an unrelated guard, and names that promise behavior the test never exercises.
- **Keep** independent API, protocol, config, migration, storage, security, platform,
  default-value and ordering contracts. "Static/slow ≠ disposable", and a failing test
  may be a product bug to fix rather than a test to delete.
- **Evidence before deletion**: for each candidate, the failure it detects, the
  non-test callers of what it covers, the stronger test that remains, why it was added,
  and a validation command. Missing evidence means no deletion; it prefers a few
  high-confidence candidates and says "never optimize for deletion counts".
- **Campaign mode** (`CAMPAIGN.md`): record a baseline, split the tests along production
  owners, have read-only agents mark every declaration `R` (retain), `F` (fix the
  assertion), `C` (consolidate into a named keeper) or `D` (delete, naming the remaining
  proof), then edit, then have independent reviewers look for contracts that lost their
  only test and confirm each restored one with a deliberate mutation.

Use in practice:
[openclaw#168518](https://github.com/openclaw/openclaw/pull/168518) (merged 2026-10-10)
removed, by its description, 11,309 net test lines across 115 files with no runtime
production change (one tooling line changed) and 123 passing CI checks. A bot review of
an earlier head marked it incorrect for three lost regression contracts, and the author
restored those tests before merging: the deletions needed the independent check the
skill asks for. Other projects adopted the skill:
[fredericoo/stapes#294](https://github.com/fredericoo/stapes/pull/294) (2026-09-25, with
`npx skills add openclaw/openclaw --skill test-audit --agent claude-code --copy`) and
[uael/furb#81](https://github.com/uael/furb/pull/81).

Parts that do not fit Pateat as is: the validation steps call OpenClaw's
`scripts/check-changed.mjs` and its `openclaw-testing` proof policy, and the authoring
gate links `docs/help/testing/writing-tests.md`; stapes noted that OpenClaw's scripts
are missing outside OpenClaw. In Pateat those would
become `mise run check`, the subagent review in [AGENTS.md](../../AGENTS.md) and
[development.md](../development.md).

## Recommendation

OpenClaw's `test-audit`: it is recent (changed on the day of this note) and widely used,
it is MIT, it is three standalone files, it has been applied at scale in its own
repository, and its rules require naming the remaining test before deleting one instead
of targeting a percentage. It would be copied into the repository at a location every
agent used here reads (OpenClaw uses `.agents/skills/`; the location is open) with the
OpenClaw-specific validation lines replaced, and used first on one area of Pateat's
tests in its own PR. `test-sweep`'s 30% stop and mutation check are useful ideas but the
skill is small and its criteria are not published on its listing. gstack's `test-audit`
is the closest alternative and asks before each batch, but it depends on installing
gstack's scripts and telemetry and its `/ship` flow, which Pateat does not use.
