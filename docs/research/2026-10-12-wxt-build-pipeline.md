# What WXT does in the extension build

Researched: 2026-10-12, from the repository at `a97701a` (main) and the WXT source at
tag [`wxt-v0.21.4`](https://github.com/wxt-dev/wxt/tree/wxt-v0.21.4). The owner asked
which build tool WXT uses, how much the framework does, and who develops it. A
production build (`wxt build --browser chrome`) was run in a cloud session to confirm
the steps below; nothing was changed.

## Versions

| Package | Version | Source |
| --- | --- | --- |
| `wxt` | 0.21.4 | Root `package.json` |
| `vite` | 8.3.4 | Root `package.json`; a peer of WXT since 0.21.1 ([wxt-dev/wxt#1945](https://github.com/wxt-dev/wxt/pull/1945)) |
| `rolldown` | 1.2.13 | Dependency of `vite` 8.3.4 in `bun.lock` |
| `@wxt-dev/module-react` | 1.2.2 | Adds `@vitejs/plugin-react` 6.1.2 |
| `@tailwindcss/vite` | 4.3.3 | Added through `vite()` in `apps/extension/wxt.config.ts` |

Vite 8 bundles with Rolldown and uses Oxc for transforms
([announcement](https://vite.dev/blog/announcing-vite8)). Its defaults are
`build.minify: 'oxc'` and `build.cssMinify: 'lightningcss'`
([build options](https://vite.dev/config/build-options)). WXT 0.21.1 dropped its own
`esbuild` dependency ([wxt-dev/wxt#2506](https://github.com/wxt-dev/wxt/pull/2506)). The
`esbuild` 0.28.2 in `bun.lock` comes from wrangler, tsx and `@cloudflare/vitest-plugin`;
that the extension build does not use it is inferred from Vite 8's defaults and the
config, not observed.

## Build steps

The build ran `vite.build()` five times:

```text
WXT 0.21.4
i Building chrome-mv3 for production with Vite 8.3.4
[1/5] background
[2/5] crypto-offscreen, diagnostics, options, passkey-picker, popup
[3/5] login
[4/5] passkey-isolated
[5/5] passkey-main
```

WXT groups entrypoints in
[`group-entrypoints.ts`](https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/core/utils/building/group-entrypoints.ts):
HTML pages share one multi-page build with hashed chunks; the background and each
content script get their own Vite library-mode build with `formats: ['iife']`
([`builders/vite/index.ts`](https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/src/core/builders/vite/index.ts)).
The background is an IIFE because it does not set `type: "module"`.

## Responsibilities

| Layer | Does |
| --- | --- |
| WXT | Finds `apps/extension/entrypoints/`, writes `manifest.json` from `wxt.config.ts` and each `defineContentScript()` (`matches`, `runAt`, `world`), plans the builds above, copies `public/`, generates `.wxt/` types (`wxt prepare`), provides `wxt/browser` and the `define*` helpers |
| Vite, Rolldown, Oxc | Module resolution and bundling, TypeScript and JSX transforms, minification, CSS, wasm and worker assets, the React and Tailwind plugins |
| Chrome | Reads the manifest, runs the service worker, injects content scripts, enforces permissions and CSP |
| Pateat | Manifest values (permissions, CSP, key), all login and passkey behavior, message shapes and Valibot validation, storage access, and the probe entrypoints added through the `entrypoints:found` hook |

Pateat imports only `defineConfig`, `wxt/browser`, `wxt/utils/define-content-script` and
`wxt/utils/define-background`. It does not use `wxt dev`, `wxt zip`, `wxt submit`,
content-script UI helpers or i18n. Auto-imports stay enabled (`.wxt/types/imports.d.ts`
declares them), but the code imports everything explicitly. WXT storage is approved in
[ADR 0004](../adr/0004-library-composition.md), but the code calls
`browser.storage` directly. WXT has no messaging wrapper
([comparison](https://wxt.dev/guide/resources/compare)), and it does not change Chrome
policy ([ADR 0002](../adr/0002-toolchain.md)).

## History and maintainers

- Aaron Klinker ([@aklinker1](https://github.com/aklinker1)) published the earlier
  [vite-plugin-web-extension](https://github.com/aklinker1/vite-plugin-web-extension) on
  2021-11-01 and started WXT on 2023-06-20
  ([24a561e](https://github.com/wxt-dev/wxt/commit/24a561e)). Version 0.0.1 reached npm
  on 2023-06-26 and already built on Vite 4. The plugin's
  [README](https://github.com/aklinker1/vite-plugin-web-extension/blob/main/README.md)
  calls WXT its successor and says the plugin will be deprecated in its favor.
- The repository moved to the `wxt-dev` organization on 2023-09-05
  ([ac7cbfc](https://github.com/wxt-dev/wxt/commit/ac7cbfc)).
- 0.20.0 (2025-03-28) removed `webextension-polyfill`; 0.20.19 (2026-03-14) added Vite
  8; 0.21.1 (2026-07-26) made `vite` and `web-ext` peers and required Node 22
  ([changelog](https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/packages/wxt/CHANGELOG.md)).
  0.21.4 (2026-08-11) is npm `latest`; WXT is still 0.x and minor versions carry
  breaking changes.
- Aaron Klinker is the only npm maintainer and the default
  [code owner](https://github.com/wxt-dev/wxt/blob/wxt-v0.21.4/.github/CODEOWNERS);
  `docs` has two co-owners and two add-on packages have their own owner. Of the 216
  commits on `main` from 2026-06-01 to
  [c1b8185](https://github.com/wxt-dev/wxt/commit/c1b8185) (2026-10-11), 87 are his and
  12 are Patryk Kuniczak's; no other person has 10. Funding is
  [GitHub Sponsors](https://github.com/sponsors/wxt-dev).
