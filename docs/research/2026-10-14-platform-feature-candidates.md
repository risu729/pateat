# Modern platform feature candidates of 2026-10-13

Researched: 2026-10-13, from the repository at
[`92b18a3`](https://github.com/risu729/pateat/commit/92b18a3) (main), with the cited
lines rechecked at [`5cbbcbd`](https://github.com/risu729/pateat/commit/5cbbcbd) when
the issues were written. On 2026-10-13 at 21:36 UTC the owner pasted an external list of
newer JavaScript, DOM, CSS, React, TanStack, Base UI, Hono, Cloudflare, Playwright and
Chrome extension features that Pateat might use, written against main `4961de6`. The
owner first set the rules for choosing them, recorded in
[Platform features](../development.md#platform-features). Subagents then checked each
candidate against the code and its upstream status (TC39 finished proposals, MDN
browser-compat-data, Chrome's documentation and the installed library versions). Nobody
built the code or ran tests for this note: every verdict comes from reading the code and
the sources.

The owner adopted six items on 2026-10-13 at 22:26 UTC, added Iterator Helpers and
`Intl.DurationFormat`, and asked for a closer comparison of eight more. On 2026-10-14
at 08:40 UTC the owner accepted the recommendations of that comparison, including the
visible UI change of a modal delete confirmation, and asked for each adopted item to
become a GitHub issue that can be started from the issue alone. None of them is
implemented yet.

## Adopted

| Feature | Status | Where it applies | Issue |
| --- | --- | --- | --- |
| CSS `light-dark()` | Chrome 123, Firefox 120, Safari 17.5 | The theme tokens, written once instead of in three blocks, in the extension's stylesheet, `/manage` and the Worker's pages | [#553](https://github.com/risu729/pateat/issues/553) |
| `Promise.withResolvers()`, `Map.groupBy()`, `Map.prototype.getOrInsertComputed()` | TC39 Stage 4; the last needs Chrome 145 | Promises settled from outside, hand-written grouping, get-or-create on maps; raises `minimum_chrome_version` to 145 | [#555](https://github.com/risu729/pateat/issues/555) |
| `URL.parse()` | Chrome 126, Firefox 126, Safari 18 | About 22 `try { new URL() } catch` wrappers; every check around them stays | [#556](https://github.com/risu729/pateat/issues/556) |
| `addEventListener(..., { signal })` | Chrome 90, Firefox 86, Safari 15 | Listeners removed together, removed by one `abort()` | [#557](https://github.com/risu729/pateat/issues/557) |
| React `<title>` | Stable since React 19.0 | `/manage`'s page title, now set by an effect | [#558](https://github.com/risu729/pateat/issues/558) |
| TanStack Form `useSelector` | Current name; `useStore` is deprecated in `@tanstack/react-store` 0.11.2 | Three form subscriptions on the options page | [#559](https://github.com/risu729/pateat/issues/559) |
| Iterator Helpers | TC39 Stage 4 (ES2025), Chrome 122 | About 15 `[...map.values()].some(...)` and similar copies | [#560](https://github.com/risu729/pateat/issues/560) |
| `Intl.DurationFormat` | ECMA-402 Stage 4, Chrome 129 | The diagnostics page's "25 min", "4 h", "3 d" labels; the owner accepted that the text changes ("4 hr", "3 days") | [#561](https://github.com/risu729/pateat/issues/561) |
| `Promise.try` | TC39 Stage 4 (ES2025), Chrome 128 | Four `Promise.resolve().then(() => fn())` wrappers; `quietly` in the login runtime only after an audit | [#562](https://github.com/risu729/pateat/issues/562) |
| Base UI `AlertDialog` | `@base-ui/react` 1.9.0, no `unstable_` marker | The Bitwarden connection delete confirmation, from an inline swap to a modal | [#563](https://github.com/risu729/pateat/issues/563) |

`Promise.try` was first marked "skip" because it changes when the callback runs. The
closer comparison found that the earlier start cannot be observed at the four sites,
because their callees read everything first or begin with an `await`; only `quietly`
takes a snapshot whose timing could matter.

The AlertDialog applies only to the connection delete confirmation for now. The
`/manage` recipe revoke and the diagnostics "Clear logs" confirmation stay inline; the
revoke would keep most of its focus handling, and "Clear logs" has none to remove.
Whether they follow is left to the owner after the first dialog lands.

## Not adopted

| Candidate | Reason |
| --- | --- |
| `AbortSignal.timeout()` and `AbortSignal.any()` beyond today's uses | About three lines per site, and tests that drive timeouts with fake timers cannot advance a native timeout signal |
| `DisposableStack`, `AsyncDisposableStack`, `using`, `await using` | No site becomes shorter or safer |
| `CompressionStream` | No use: logs are copied and saved as text |
| `scheduler.yield()` | No site; the `setTimeout(0)` in `packages/bitwarden/src/transport.ts` lets timers run and would break if replaced |
| `ariaLabelledByElements`, `checkVisibility()` changes | About three lines, with different shadow DOM behaviour; the visibility code is already clean |
| Size container queries, `@scope`, subgrid, `content-visibility` | No place where they remove rules or fix a layout |
| Popover and anchor positioning, `commandfor`, `field-sizing` | The only floating UI is Base UI's `Menu`, whose keyboard handling popover does not replace; no dialog, popover or textarea to use them on |
| Customizable `<select>`, cross-document View Transitions | Both pass the two-engine test, but the first means restyling the theme select for no gain, and `/manage` is a single-page app whose page changes would animate between empty screens |
| React `<ViewTransition>` | No place to use it |
| `useSyncExternalStore` for the theme | Adds more code than it removes |
| TanStack Query `signal`, conditional `refetchInterval`, mutation `scope.id`, `useActionState` | Nothing gets simpler; `useActionState` conflicts with requesting Chrome permissions before the first `await` |
| Hono `hc<AppType>` | The Valibot checks and error handling stay, and the Worker's types may clash with the web UI's tsconfig |
| D1 Sessions API | Pateat uses no read replicas |
| Playwright Clock, Playwright ARIA snapshots, Vitest ARIA snapshot | Clock may not reach the service worker and content scripts; no test that an ARIA snapshot would replace (the Vitest one is also experimental) |
| React Compiler | Needs new build dependencies, and the app has no `useMemo`, `useCallback` or `memo` to remove |
| Cloudflare Cron Trigger for the 90-day inference log purge | Adding a trigger is a deployment change; the purge runs on requests (ADR 0018) |
| Structured clone extension messaging (Chrome 148) | Not documented as stable in the extension reference, and the saved base64 round trips are offset by the checks and size limits it would need |
| `chrome.publicSuffix` | Needs Chrome 153, past the six-month limit; the Worker and shared packages keep `tldts` anyway |

## Experimental, not used

Under [Platform features](../development.md#platform-features) the extension and
`/manage` use no experimental feature: CSS `if()` and `@function` and
`interpolate-size` (Chrome only), WebMCP (origin trial) and the Prompt API (Chrome
only). The Prompt API is instead part of phase 3's comparison of Clef and Jev for the
[finite-choice role](../plan.md#phase-3-public-release).
