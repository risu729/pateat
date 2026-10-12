# Claude Design for the UI polish

Researched: 2026-10-11, from Anthropic's announcement, support article and blog. Nothing
was made with it and nothing is adopted beyond the
[roadmap](../plan.md#phase-1-usable) line that sets the base design tokens with Claude
Design during the UI polish. It grants no capability.

## What it is

- An Anthropic Labs product, launched on 2026-04-17, for UI mockups, interactive
  prototypes and slides on a canvas next to the chat, refined through conversation,
  inline comments and direct edits
  ([announcement](https://www.anthropic.com/news/claude-design-anthropic-labs)).
- It can read a codebase and build a design system (colors, type, components) that later
  designs follow, and it hands designs to Claude Code, which has `/design` and
  `/design-sync`
  ([update](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work)).
- It is available inside any Claude conversation, including Claude Code and the
  Artifacts tab. The standalone `claude.ai/design` site closes on 2026-12-14
  ([get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)).
- Its use counts toward the Claude subscription's usage, not the Claude API, so it does
  not touch the service's Claude Console workspace or the spending caps of
  [ADR 0014](../adr/0014-claude-generation-provider.md).
- In this project's Claude sessions it appears as the artifact types "Design" (a canvas
  for screens) and "Design System" (tokens and components); no connector is needed.

## How the UI polish could use it

1. Build a Design System from `apps/extension` and the service web UI code.
2. Lay out options for the popup, the passkey chooser window and the recipe editor on a
   Design canvas for the owner to choose from.
3. Implement the chosen option in code.

[stop-describing-ui](https://github.com/artouc/stop-describing-ui), which the roadmap
uses for the same pass, cuts explanatory UI text; Claude Design covers the visuals, so
the two do not overlap.
