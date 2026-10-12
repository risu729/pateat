# Agent instructions

- Use English for repository files, comments, commit messages, issues, and PRs.
- Read [docs/README.md](docs/README.md) and the relevant design before editing.
- Keep current behavior, proposed work, and dated evidence distinct. Update the
  owning document in the same PR; record material decisions in an ADR.
- Record every design decision the owner makes in the repository: larger ones in
  an ADR, others in the owning `docs/` page. Land the record with the
  implementation PR or as its own docs PR. A decision that exists only in a chat
  or thread is not recorded.
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
- Keep each PR focused on one independently reviewable change. Separate unrelated
  library choices, provider research and agent-workflow rules into distinct PRs.
  Keep necessary implementation, tests and owning documentation together. Use
  independent base branches where possible and state any real PR dependencies.
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
  authorized PRs without waiting for another owner confirmation. Recheck changes
  made after review, including material conflict resolutions. This standing merge
  permission does not approve new library/provider choices or deployment.

## Continuing the work

- A merged PR is not a stopping point. Continue with the next slice of the current phase
  in the [roadmap](docs/plan.md#roadmap) until that phase is done, then the next phase;
  phase 1 ends with login on the owner's everyday sites in their installed Chrome and on
  the Grok Bot sites in the Grok Bot computer's Chrome.
- Create GitHub issues only in phase 4. Until then, docs/plan.md is the tracker.
- A thread that researches something lands its findings in its own docs PR, including
  the roadmap lines they change.
- Owner-approved and not to be re-proposed: local persistent retention of the
  unlock key for automatic unlock across browser restarts
  ([ADR 0006](docs/adr/0006-atomic-local-vault-cache.md)). Do not describe it as
  OS-keystore protection.
- Paid APIs, real-account operations and reading secrets need separate owner
  approval. Do not read real credentials. Synthetic seams do not prove
  real-account or real-permission-prompt compatibility.
- The owner allows installing and updating Pateat builds in their Chrome and
  testing them on any website. Before conveying an SDK-containing build, meet the
  [Corresponding Source](docs/sdk-source.md) requirements. Browser connectors may
  refuse `chrome://` and `chrome-extension://` URLs; do not work around that policy.
- If a cleanup or other action is refused by an approval policy, report it and do
  not retry it through another tool.
