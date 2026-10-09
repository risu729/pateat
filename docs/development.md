# Proposed development workflow

No toolchain is installed by the documentation PR. Commands below are targets
for M1, not commands that already work in this repository.

## Workspace and tasks

Start with a Bun workspace and one committed frozen lockfile:

```text
apps/extension/       WXT entrypoints and local runtime
services/api/         Cloudflare Worker and D1 migrations
packages/contracts/  Shared Valibot schemas and inferred types
```

Create directories when their first implementation exists. Keep feature code
inside its owner until an actual shared boundary warrants another package.

mise owns exact tool versions, installation, and task definitions. Use native
workspace mise tasks, not package.json scripts or wrapper scripts that duplicate
the task graph. Bun manages dependencies; pinned supported Node executes tools
that require it, notably cf. Commit mise and Bun lockfiles after resolving them,
never hand-author a purported installed dependency graph.

Use [risu729/hk-config](https://github.com/risu729/hk-config) at an immutable
reviewed release/commit. hk provides the single complete check entrypoint,
delegating work to mise. Avoid recursion between hk check and mise checks.

Target verification entrypoint:

```sh
mise exec -- hk check --all --no-fail-fast
```

Use Oxlint and Oxfmt, separate TypeScript type-checking, appropriate Markdown/
TOML/YAML checks, and shared GitHub Actions hygiene. Enable only relevant preset
groups; do not copy Kogane's production-specific tooling or compatibility aliases.
CI uses the same task graph. Keep mutation in an explicit fix task. Add the
owner's Renovate configuration for pinned dependencies/tooling during bootstrap.

## Dependency policy

| Area                 | Choice                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| Extension            | WXT + TypeScript; no replacement framework                                          |
| Runtime contracts    | Valibot; official JSON Schema converter only where a provider requires it           |
| Transport/storage    | Native Chrome APIs with validated messages; WXT settings/cache helpers where useful |
| Worker               | Native Workers APIs; Hono only if route complexity makes it worthwhile              |
| Cryptography         | WebCrypto first; separately evaluated established Argon2 implementation             |
| Unit/runtime tests   | Vitest, WXT test integration, current Cloudflare Vitest plugin                      |
| Browser tests        | Playwright with isolated extension-capable Chromium                                 |
| Server configuration | cf with cloudflare.config.ts; Vite build path, no production Wrangler TOML/JSON     |

Prefer established maintained libraries over similar low-star feature projects.
Stars alone do not establish quality: check release history, maintenance,
security response, dependency footprint, license and browser compatibility.
Implement the login state machine, form semantics, vault adapter and WebAuthn
policy ourselves using standards and interoperability tests. Do not copy code
from Fenko, auto-filler, Superfill, Boltwarden, or bronzewarden.

Do not add a state-machine framework, ORM, RPC system, broad AI SDK, UI framework,
CBOR package, or additional crypto suite before a concrete need. A small typed
HTTP adapter can suffice for inference. Valibot applies to our direct schemas;
tooling can have unavoidable transitive Zod dependencies without changing that
choice. cf is currently beta; pin it and test updates instead of pretending every
part of the selected stack is stable.

Reference versions and compatibility findings live in
[dated research](research/2026-10-10-feasibility.md); exact implementation pins
belong in lockfiles/configuration. Dependency upgrades run the same behavioral
tests, especially injection timing and Workers test-runtime compatibility.
