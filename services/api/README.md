# API foundation

This Worker only exposes a deployment health probe. It has no authentication,
vault, settings, recipe, database, or inference implementation.

`GET /health` returns JSON with `status: "ok"`, `service: "pateat-api"`, and
`revision`. The revision is embedded at build time from `PATEAT_REVISION`, with
`development` for local builds when it is absent. `HEAD /health` returns the same
headers without a body. Other methods return 405; other paths return 404. The
probe is not cached and does not enable cross-origin access.

`cloudflare.config.ts` is the production configuration. Vite emits generated
Worker types and production Build Output under `.cloudflare/`. The Vitest
integration uses an explicit local entrypoint and Miniflare options derived from
the same compatibility settings. It does not read a separate Wrangler config.

The credential-free build and prebuilt dry run validate the exact
`.cloudflare/output/v0/` artifact. Local artifact smoke tests execute that bundle
in workerd separately from Vitest's transformed test modules. Neither check
demonstrates a deployed service or implements the later service acceptance
gates in [the delivery plan](../../docs/delivery.md).

Worker routing, account selection, credentials and initial resource provisioning
are intentionally absent. The server delivery workflow stays disabled until
those deployment inputs and a reachable health endpoint are configured.
