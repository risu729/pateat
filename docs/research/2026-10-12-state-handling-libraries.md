# Libraries for the login runtime's state handling

Researched: 2026-10-12, from the repository at `d9c39b3` (main). The owner asked whether
the hand-written state handling around login attempts could be replaced by an existing
library such as Temporal. This note compares the candidates from the code and from the
libraries' documented models; nothing was prototyped. The owner's decision is recorded
in
[development.md](../development.md#integration-conditions-pending-candidates-remain-conditional).

## What is hand-written today

XState drives only one login attempt: `loginAttemptMachine` in
`packages/contracts/src/login-attempt.ts`. Production code never keeps an actor running.
`transitionLoginAttempt()` resolves a state from the stored metadata, applies one event
with XState's pure `transition()`, and validates the result with Valibot before it is
stored. The machine owns the submission and retry budgets, the ban on resubmission and
the observation after an interruption.

The rest of `apps/extension/src/login/runtime.ts` (3,716 lines) coordinates around it:

| Kind | Examples | Size at `d9c39b3` |
| --- | --- | --- |
| Per-document display state | `LiveDocument.state`: `watching`, `generating`, `denied` or unset | Set in three places in `admit()` |
| Holding an origin, logout | `heldElsewhere()`, `stoppedByPateat()`, `finishedLogin()`, `askedElsewhere()` | Predicates over stored attempt records; no transitions |
| Pending choices, picks, logouts | `pending`, `picked`, `logouts` in memory and `chrome.storage.session` | Per-tab sets |
| Stale-document checks | `current(run)`; `documents.get(key) !== live`; `hellos.get(helloKey) !== sequence` | 30 and 18 occurrences |
| Storage | Direct `browser.storage` calls and the serial `storageQueue` | 9 calls |
| Message intake | `v.safeParse` chains in `handle()` | 19 `safeParse` calls |

Most of it is not a state transition: it is asynchronous cancellation, storage and
validation. Moving it into a state-machine library would keep the same checks.

## Candidates

- **Temporal.** Durable execution on a server: a Temporal Service (self-hosted or
  Temporal Cloud) stores each workflow's event history, and worker processes (Node.js
  for the TypeScript SDK) replay the workflow function against it after a failure,
  reusing the results of completed activities. Pateat's steps run in the MV3 service
  worker and the page with vault values that stay on the device, so Temporal cannot host
  them; every step would become a round trip between the server and the browser.
  Activities are retried by default, so safety against a second submission would still
  be Pateat's.
- **Cloudflare Workflows, Restate, Inngest.** The same model on the server side. They
  may suit long server jobs later; they cannot run login steps. No established durable
  workflow library for browser extensions was found.
- **XState for more of the runtime.** Already approved. Most hand-written parts are
  predicates and cancellation checks, so a machine would not remove them. Keeping actors
  running would also have to respect the rule against restoring into a submit
  invocation.
- **Effect.** Typed fibers with interruption, queues and semaphores could replace the
  manual stale-document checks, but it changes how the whole runtime is written and
  overlaps Valibot with Effect Schema. It would be a new major library.
- **`AbortController` and RxJS.** Cancellation signals would still need a check after
  each `await`, where `current()` checks today; RxJS would be a large new style.
- **robot3, Zag and other small state-machine libraries.** XState is already approved; a
  second one adds nothing.
- **WXT storage helpers** (approved, part of `wxt`, not used yet). Typed keys, fallbacks
  and `watch` could replace the string keys and raw `get`/`set` calls. Valibot
  validation, the serial queue and trusted-context access stay; the helpers have no
  compare-and-swap, and their versioned migrations are not needed before release.
- **`@webext-core/messaging`** (approved, not installed). Typed messages; page messages
  are untrusted, so Valibot validation stays.
- **p-queue, async-mutex.** The two places that serialize work are a few lines each.

## Findings that need code changes

- No production code sends `RETRY`. A `retryable` attempt keeps its tab and holds its
  origin in other tabs. A new document re-observes it, but `retryRequired` survives
  `OBSERVED continue`, so it returns to `retryable` when the step's elements show and
  settles as unknown when they do not. Resolved after this note: the runtime now sends
  `RETRY` and a spent budget ends the attempt `retry-limit`, which releases the origin
  ([ADR 0022](../adr/0022-login-attempts-per-tab-and-origin.md)).
- `docs/architecture.md` still listed the states `resolving` and `filling`, and
  `docs/development.md` called the attempt lifecycle a local-probe implementation.
