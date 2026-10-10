# Agent instructions

- Use English for repository files, comments, commit messages, issues, and PRs.
- Read [docs/README.md](docs/README.md) and the relevant design before editing.
- Keep current behavior, proposed work, and dated evidence distinct. Update the
  owning document in the same PR; record material decisions in an ADR.
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
- Keep vault secrets local, recipes declarative, and login execution scoped to
  the configured account, origin, tab, frame, and document.
- Preserve the plan's initial/later boundaries and independently granted provider
  capabilities; adding an adapter or interface must not expand permissions.
- Use Sol High subagents for implementation, tests and independent PR review
  (`gpt-6.1-sol` with high reasoning).
- Have an independent reviewer verify each PR. State what was actually tested.
  Once review findings are resolved and applicable checks pass, merge authorized
  PRs without waiting for another owner confirmation. Recheck changes made after
  review, including material conflict resolutions. This standing merge permission
  does not approve new library/provider choices or deployment.
