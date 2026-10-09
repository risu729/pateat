# Development workflow

The foundation has a Bun workspace, pinned tools, an extension shell, shared
contracts, and a health-only Worker. These are implementation and test scaffolds;
they do not implement vault access, login execution, service authentication, or
inference. M1 is not complete until its required checks and acceptance gates pass.

## Workspace and tasks

The workspace uses one Bun lockfile:

```text
apps/extension/       WXT entrypoints and extension shell
services/api/         Health-only Cloudflare Worker
packages/contracts/  Shared Valibot schemas and inferred types
tests/extension/      Isolated synthetic browser fixtures and tests
```

Keep feature code inside its owner until an actual shared boundary warrants
another package. Add D1 migrations when the service first needs a schema.

`mise.toml` owns exact tool versions, installation, and task definitions. Use native
workspace mise tasks, not package.json scripts or wrapper scripts that duplicate
the task graph. Bun manages dependencies; pinned supported Node executes tools
that require it, notably cf. Commit mise and Bun lockfiles after resolving them,
never hand-author a purported installed dependency graph.

`hk.pkl` imports [risu729/hk-config](https://github.com/risu729/hk-config) at a pinned
commit. hk provides the single complete check entrypoint,
delegating work to mise. Avoid recursion between hk check and mise checks.

Install the pinned tools and frozen dependencies, then use the complete check
entrypoint:

```sh
mise install
mise run install
mise exec -- hk check --all --no-fail-fast
```

The shared checks include Oxlint, Oxfmt, separate TypeScript checking,
Markdown/TOML/YAML validation, and GitHub Actions hygiene. CI uses the same task
graph. `mise run fix` applies explicit formatting/lint fixes; the check task must
not mutate source files. Renovate tracks the pinned dependencies and tooling.

Focused tasks are available for diagnosis:

| Task | Purpose |
| --- | --- |
| `mise run prepare:extension` | Generate WXT types |
| `mise run build:extension` | Package the Chrome extension shell |
| `mise run build:probe` | Build the isolated synthetic browser-test variant |
| `mise run typecheck:extension` | Check extension source after WXT preparation |
| `mise run test:contracts` | Test shared schemas |
| `mise run test:tools` | Test artifact/provenance helpers |
| `mise run test:server` | Run Worker tests in the Cloudflare Vitest runtime |
| `mise run build:server` | Generate production Build Output and Worker types |
| `mise run typecheck:server` | Check Worker/config/test types after a server build |
| `mise run check:server-output` | Validate existing production output with cf's prebuilt dry run |
| `mise run check:server-artifact` | Execute that emitted bundle in a fresh local runtime |
| `mise run browser:install` | Install the pinned isolated Chromium browser |
| `mise run test:browser` | Exercise the extension against synthetic local pages |
| `mise run check:docs` | Check local documentation links |

On Linux, `mise run browser:install --with-deps` also installs the browser's
system dependencies. Run server build before server type checking and artifact
checks; the latter consume generated files. Set `PATEAT_REVISION` before the build
and artifact check to verify a particular source revision. Without it, local
builds use `development`. The default extension build excludes the test probe;
neither variant grants vault or real-site login capability.

Local success is scoped to the tested component. Worker tests and artifact
checks have passed locally; they do not establish production deployment or
installed Chrome use compatibility. Current evidence and unresolved browser
acceptance results are recorded in [dated research](research/2026-10-10-feasibility.md).

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

The Worker uses the pinned beta Cloudflare Vite plugin required by cf's typed
configuration and Build Output workflow. Its manifest declares that plugin
explicitly so cf can discover the build framework inside the workspace. Tests
use the Cloudflare Vitest plugin with test-local Miniflare options derived from
the production compatibility settings; no production Wrangler TOML/JSON exists.
The shared TypeScript preset currently declares TypeScript 6 compatibility, so
the workspace pins TypeScript 6 rather than upgrading it independently to 7.

Reference versions and compatibility findings live in
[dated research](research/2026-10-10-feasibility.md); exact implementation pins
belong in lockfiles/configuration. Dependency upgrades run the same behavioral
tests, especially injection timing and Workers test-runtime compatibility.
