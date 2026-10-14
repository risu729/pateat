# External code review of 2026-10-13

Researched: 2026-10-13, from the repository at
[`f5df675`](https://github.com/risu729/pateat/commit/f5df675) (main). The owner pasted
an external static review of main
[`4961de6`](https://github.com/risu729/pateat/commit/4961de6259cb6cf4def31ede5de3b6fbb71fe55c)
covering the background, login runtime, page observation, passkeys, the crypto Worker,
Bitwarden decryption and fields, sync, API authentication, inference output checks and
CI. Its author did not build or run tests. Two agents checked each finding against the
code and docs at `f5df675`, where the cited lines had not changed since `4961de6`; a
third checked the resulting plan. Nobody ran tests or builds for this note: every
verdict comes from reading the code.

The review kept these parts as they are: storage limited to `TRUSTED_CONTEXTS`,
decryption isolated in a Worker without network access, passkey requests checked
against the browser's sender rather than a page-supplied origin, structured model
output validated before a recipe is built, and observations refused when a known
username cannot be removed from them.

On 2026-10-14 at 07:24 UTC the owner asked for the findings to become GitHub issues so
that they can be handled separately, ahead of
[phase 4](../plan.md#phase-4-issues-and-work-as-needed).

## Findings

| # | Finding | Verdict | Already decided | Issue |
| --- | --- | --- | --- | --- |
| 1 | A recipe cache over 2 MiB blocks later revocations | Correct | Partly: ADR 0013 | [#544](https://github.com/risu729/pateat/issues/544) |
| 2 | An undecided login ends `authenticated` and saves the account choice | Correct | Yes: ADR 0029, now changed | [#545](https://github.com/risu729/pateat/issues/545), [#546](https://github.com/risu729/pateat/issues/546) |
| 3 | Passkey UP and UV are set without presence or verification | Correct | Yes: ADR 0007 | [#541](https://github.com/risu729/pateat/issues/541) |
| 4 | Bitwarden's master password re-prompt is not honoured | Correct | No | [#541](https://github.com/risu729/pateat/issues/541) |
| 5 | The decrypted field cache stops at 128 items | Correct | No | [#542](https://github.com/risu729/pateat/issues/542) |
| 6 | Inference log rows past 90 days are deleted only on requests | Correct | Yes: ADR 0018 | [#543](https://github.com/risu729/pateat/issues/543) |
| 7 | `runtime.ts` concentrates most of the login logic | Correct | No split plan | [#545](https://github.com/risu729/pateat/issues/545), [plan](../plan.md#phase-3-public-release) |

### 1. Recipe cache over 2 MiB

`pullRecipes()` in `apps/extension/src/service/recipes.ts` (lines 241-246) returns
`cache-full` without writing a page whose changes would grow the cache past
`MAX_RECIPE_CACHE_BYTES` (2 MiB), so the cursor stays and the next sync stops on the
same page. The service returns `recipeHeads.sequence > cursor` in ascending order, 100
changes a page (`services/api/src/routes/recipes.ts` lines 48-50), and a revocation
gives its recipe the highest sequence, so a revocation of an already cached recipe sits
behind the page that overflows; lookups keep using the revoked recipe meanwhile.

[ADR 0013](../adr/0013-service-held-recipes-and-settings.md) accepts that a full device
keeps its recipes "until recipes are removed on the service". That only works while at
most 100 changes remain after the cursor, so that the removals land in the stuck page
itself. Generated recipes are a few KiB each, so this needs several hundred recipes. The
service allows 1,000 active recipes of up to 128 KiB each, more than the cache holds; a
separate plan reviews those limits.

### 2. An undecided login counts as a success

`UNDECIDED_COMPLETES` in `apps/extension/src/login/runtime.ts` (lines 270-277) lets an
`unclear` page with no sign and no evidence complete when the model could not decide,
the path was judged before (`already-judged`, `judged-signed-in`), or a limit applies
(`judgement-limit`, `daily-limit`, `monthly-limit`), after the guards at lines 4513-4553
(not watched, not a passkey route, no stop before a missing password, the page re-read
after the answer, no disabled field left out). The result is the same `authenticated` as
a `signed-in` answer (line 4572): `change()` then saves the person's account choice as
the default (line 2494), the badge shows a green check, and the sign-in is recorded for
[ADR 0007](../adr/0007-existing-passkey-assertions.md)'s registration refusal.

This was the owner's decision in [ADR 0029](../adr/0029-local-sign-in-state.md)
(2026-10-12 04:51 UTC). On 2026-10-14 at 07:24 UTC the owner chose that such a login
still ends but is not counted as a success: no default is saved, the badge shows the
yellow `!` and the sign-in is not recorded. #546 makes that change after #545 moves the
completion rule into its own module.

### 3 and 4. Passkey UP/UV and re-prompt

`apps/extension/src/passkeys/policy.ts` sets presence and verification to `always`, as
ADR 0007 records. `packages/bitwarden/src/local-crypto.ts` (line 308) parses a cipher's
`reprompt` but nothing uses it. The owner decided on 2026-10-13 at 21:57 UTC that both
become settings later and are stated explicitly first; #541 does that in the README,
the architecture and the plan.

### 5. Decrypted field cache

`apps/extension/src/crypto/worker.ts` (lines 312-314) returns `resource-limit` for an
uncached item once 128 decrypted item copies are held, and nothing removes or disposes
them until the session is replaced, which happens on lock or when a sync accepts a new
vault revision. Each copy holds the whole item, not only the field asked for. #542 drops
the least recently used copy instead.

### 6. Inference log retention

[ADR 0018](../adr/0018-recipe-generation-route.md) deletes log rows older than 90 days
whenever a call is logged and whenever a device reads the recipe change feed, because
routine releases do not apply scheduled triggers; a paired extension reads the feed
every 5 minutes. The purge is awaited without a `try` in the feed route and runs in the
same batch as the call's log row, so a failed delete fails the sync or loses the record
of a paid call; #543 separates them.

### 7. Login runtime size

`runtime.ts` is 430,050 bytes in 9,998 lines, and `createLoginRuntime` spans lines
1573-9998 with 144 inner functions; `runtime.production.test.ts` is 948,290 bytes in
21,539 lines. The attempt lifecycle already uses XState
([ADR 0004](../adr/0004-library-composition.md)). #545 moves the undecided-page
completion rule out first; the rest of the split is planned in phase 3.
