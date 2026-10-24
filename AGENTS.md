# Agent instructions

- Use English consistently for repository documentation, code comments, commit messages,
  and pull request titles and descriptions. Use English for issue text and other
  repository prose too. The exception is a Japanese translation of a user-facing page,
  such as [README.ja.md](README.ja.md) or a page under `apps/docs/src/ja/`: a PR that
  changes the English page changes its translation too.
- Read [docs/README.md](docs/README.md) and the relevant design before editing.
- Keep current behavior, proposed work, and dated evidence distinct. Update the
  owning document in the same PR; record material decisions in an ADR.
- Record every design decision the owner makes in the repository: larger ones in
  an ADR, others in the owning `docs/` page. Land the record with the
  implementation PR or as its own docs PR. A decision that exists only in a chat
  or thread is not recorded.
- Do not fully trust ADRs or other recorded decisions, even ones recording the
  owner's instructions; they can be wrong. Check them against the code and current
  evidence. When you change a recorded owner instruction, tell the owner what changed
  and why; other approval rules still apply.
- While a design is still being discussed with the owner, write no ADR, code or
  PR for it until the owner explicitly approves the decisions. Work on decisions
  already approved continues.
- Pateat is unreleased: keep no backward compatibility with older extension storage,
  service versions, API shapes or D1 data, and remove code that exists only for it;
  Bitwarden and other provider version handling stays
  ([compatibility before release](docs/development.md#compatibility-before-release)).
- Use WXT, TypeScript, and Valibot. Prefer maintained, established dependencies;
  do not copy feature code from small similar projects.
- The owner chooses major libraries, frameworks and providers. Present the
  purpose, viable alternatives, tradeoffs and recommendation, then ask before
  recording adoption or implementing a new choice or replacement. A research or
  plan-update request does not approve adoption. Mark unresolved choices as
  proposals; do not minimize dependencies merely because development is early.
  Reuse decisions already authorized in the conversation without asking again;
  routine implementation and compatible updates within that scope may proceed.
- When proposing a library or platform API, show what it is with a short code
  example, and judge it by whether the code becomes clearer, not by line count.
- Keep each PR focused on one independently reviewable change. Separate unrelated
  library choices, provider research and agent-workflow rules into distinct PRs.
  Keep necessary implementation, tests and owning documentation together. Use
  independent base branches where possible and state any real PR dependencies.
- Do not defer approved implementation to later or follow-up work unless it is very
  large; a focused separate PR now is fine ([merging](docs/delivery.md#merging)).
- Use mise tasks and the shared hk checks once bootstrapped; do not add package
  scripts or download-on-demand tool commands.
- Follow the [merge procedure](docs/delivery.md#merging) and the
  [Windows notes](docs/development.md#windows-notes).
- Implement no site-specific features unless strictly necessary, and tell the owner
  about any that exist; fix a problem seen on one site as a general page rule
  ([ADR 0033](docs/adr/0033-no-site-specific-features.md)).
- Keep vault secrets local, recipes declarative, and login execution scoped to
  the configured account, origin, tab, frame, and document.
- Preserve the roadmap's phase boundaries and independently granted provider
  capabilities; adding an adapter or interface must not expand permissions.
- Separate implementation, test and independent PR review roles. In Codex, use Sol
  High subagents (`gpt-6.1-sol` with high reasoning); other agents use subagents
  with the same separation.
- Have an independent subagent review every PR that changes implementation or
  tests; documentation-only PRs need passing checks. State what was actually
  tested. Once review findings are resolved and applicable checks pass, merge
  authorized PRs without waiting for another owner confirmation, including merges
  that release the service and the paid calls that release starts within the
  service's spending caps ([merging](docs/delivery.md#merging)). Recheck changes
  made after review, including material conflict resolutions. This standing merge
  permission does not approve new library/provider choices or changes to how the
  service is deployed.
- Have an independent subagent review a design proposal or plan (facts against the
  code, UX gaps, security and permission impact) before asking the owner to decide,
  and say in the ask that it was reviewed.
- Never skip, disable or quarantine a test to make CI pass. Running the end-to-end
  suite in its own jobs with `PATEAT_SKIP_E2E`, or the walks over every order of events
  in their own job with `PATEAT_SKIP_ORDERS`
  ([CI](docs/delivery.md#current-foundation-workflows)), is not a skip.
- An agent that acts on GitHub as the owner's account never pushes to, closes or
  reopens a PR it did not open, except that it closes a PR its own merged PR
  superseded, after commenting there with a link to that PR (owner, 2026-10-23 12:18
  UTC).
- Write every PR, issue, commit, workflow run and URL you mention in PR and issue text
  and in messages to the owner as a Markdown link, never a bare `#123`, SHA or URL.

## Continuing the work

- A merged PR is not a stopping point. Continue with the next slice of the current phase
  in the [roadmap](docs/plan.md#roadmap) until that phase is done, then the next phase;
  phase 1 ends when each kind of login page in its table works on the real site named
  for it in the owner's installed Chrome.
- Create GitHub issues only in phase 4, or earlier where the owner asks for them
  ([phase 4](docs/plan.md#phase-4-issues-and-work-as-needed)). Until then,
  docs/plan.md is the tracker.
- Label and close issues as in [Issue labels](docs/delivery.md#issue-labels).
- A thread that researches something lands its findings in its own docs PR, including
  the roadmap lines they change.
- Verify every claim of an external review against the code and write a plan; open a
  PR from it only after the owner agrees, except a docs PR the owner asks for.
- Investigate an upstream bug in its own thread and summarize it to the owner; report
  nothing upstream without the owner's word.
- Owner-approved and not to be re-proposed: local persistent retention of the
  unlock key for automatic unlock across browser restarts
  ([ADR 0006](docs/adr/0006-atomic-local-vault-cache.md)). Do not describe it as
  OS-keystore protection.
- Paid APIs, real-account operations and reading secrets need separate owner
  approval. Do not read real credentials. Synthetic seams do not prove
  real-account or real-permission-prompt compatibility.
- Never ask the owner for HAR captures, never write down or ask where the extension
  signing key is kept, and never give passwords to browser agents; the owner types
  codes and master passwords.
- Run browser tests, including installed-Chrome probes, in cloud browsers first; only
  checks that need the owner's Chrome, profile, other extensions or real accounts go
  there.
- The owner allows installing and updating Pateat builds in their Chrome and
  testing them on any website. Before conveying an SDK-containing build, meet the
  [Corresponding Source](docs/sdk-source.md) requirements. Browser connectors may
  refuse `chrome://` and `chrome-extension://` URLs; do not work around that policy.
- If a cleanup or other action is refused by an approval policy, report it and do
  not retry it through another tool.
