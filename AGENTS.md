# Agent instructions

- Use English for repository files, comments, commit messages, issues, and PRs.
- Read [docs/README.md](docs/README.md) and the relevant design before editing.
- Keep current behavior, proposed work, and dated evidence distinct. Update the
  owning document in the same PR; record material decisions in an ADR.
- Use WXT, TypeScript, and Valibot. Prefer maintained, established dependencies;
  do not copy feature code from small similar projects.
- Use mise tasks and the shared hk checks once bootstrapped; do not add package
  scripts or download-on-demand tool commands.
- Keep vault secrets local, recipes declarative, and login execution scoped to
  the configured account, origin, tab, frame, and document.
- Have an independent reviewer verify each PR. State what was actually tested.
