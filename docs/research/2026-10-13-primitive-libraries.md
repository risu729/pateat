# Libraries for hand-written primitives

Researched: 2026-10-13, from the repository at
[`281362e`](https://github.com/risu729/pateat/commit/281362eb085b4ea4368d0db21b6be4abb1837f39)
(main). The owner asked which libraries Pateat uses for primitives such as dates, and
where an external library should replace hand-written code. WXT storage and
`@webext-core/messaging` were handled in their own thread and are left out. A second
agent checked the cited lines and library behaviour against the code; whether
Cloudflare Workers supports `Uint8Array.fromBase64` was not checked. The owner's
decisions that followed are listed at the end; each one is recorded in the owning
document by its implementation pull request.

## What was in use

| Area | In use at `281362e` |
| --- | --- |
| Dates | No library: `Date.now()` epoch milliseconds, `toISOString()`, small formatting helpers (`utcMinute` in `diagnostics/report.ts`, `age` in `diagnostics/labels.ts`, `formatTime` in `services/api/web/devices.tsx`) |
| IDs | `uuid` v7 (`newId` in `packages/contracts/src/ids.ts`) |
| Validation | Valibot |
| State transitions | XState, for one login attempt only |
| Cryptography | Bitwarden SDK (WASM) and Web Crypto |
| OTP | OTPAuth |
| URLs and domains | `new URL()` and tldts |
| Service JWT checks | `hono/utils/jwt` |
| base64, base64url, hex | Hand-written with `btoa`/`atob` and character replacement |
| CBOR | Hand-written reader for COSE_Sign1 (`packages/bitwarden/src/cose.ts`) |
| IndexedDB | Raw API, callbacks wrapped into Promises in each file |
| Deep equality | Three hand-written comparisons and `JSON.stringify` comparisons |
| Retries and timeouts | Loops, `setTimeout` and `AbortController` |
| Logging | Hand-written ([ADR 0019](../adr/0019-local-diagnostics-and-logs.md)) |
| ECDSA DER conversion | Hand-written ([ADR 0007](../adr/0007-existing-passkey-assertions.md)) |

## Candidates for replacement

### base64, base64url and hex

The same conversions were written by hand in 14 production files: base64url encoding
(`passkeys/encoding.ts` and a copy in `passkeys/page.ts`,
`packages/bitwarden/src/passkeys.ts`, `services/api/src/auth.ts`), strict base64url
decoding, JWT payload decoding (`connections/session-record.ts`,
`packages/bitwarden/src/account.ts`), the canonical base64 check `btoa(atob(x)) === x`
(four places), other `btoa(String.fromCharCode(...))` calls, and bytes to hex
(`diagnostics/pseudonym.ts`, `packages/inference/src/outcome.ts`,
`services/api/src/auth.ts`, `services/api/src/recipes/generate.ts`).

- Standard `Uint8Array.prototype.toBase64()`, `Uint8Array.fromBase64()` and `toHex()`:
  no dependency, but they need Chrome 140 and Node 25 or later. The extension declared
  `minimum_chrome_version` `"120"`, and `packages/bitwarden`, `packages/inference` and
  `services/api` compiled with `lib: ["ES2022"]`. `lastChunkHandling: "strict"` requires
  padding and every mode skips ASCII whitespace, so a thin helper stays for the
  canonical (unpadded, no whitespace) check.
- [`@scure/base`](https://github.com/paulmillr/scure-base): works on Chrome 120 and was
  already a candidate in docs/development.md, at the cost of one dependency.

Bitwarden's own rule against mixing URL-safe and standard characters
(`decodeBitwardenBase64`) is an application rule and stays either way.
`RegExp.escape()` (Chrome 136) can replace `escapePattern` in `page/account-list.ts`
once the minimum version rises.

### CBOR

`cose.ts` held a 202-line CBOR reader. docs/development.md said not to write CBOR
primitives by hand, and docs/architecture.md described `cose.ts` as a stricter subset
than the SDK's parser, but not as an exception to that rule. The reader existed because
the SDK's async exports never settle on input its parser rejects
([research](2026-10-13-bitwarden-sdk-async-hang.md)), so it accepted only definite
lengths and no tags.

- [`cbor2`](https://github.com/hildjj/cbor2) 2.4.0 has `rejectStreaming`,
  `rejectDuplicateKeys` and `rejectSimple`, but no option that rejects every tag:
  standard tags decode to values silently, so `ignoreGlobalTags` and a tag check of
  its own would be needed. The COSE header checks would stay.
- [`cbor-x`](https://github.com/kriszyp/cbor-x) is faster but does not report whether a
  decoded item had a definite length, so the subset is hard to reproduce.
- Keeping the reader needed the exception recorded in docs/development.md.

### IndexedDB

`diagnostics/database.ts` and `vault/database.ts` wrapped requests, transaction
completion and database opening by hand. `vault/storage.ts` and
`connections/session-store.ts` repeated the same nested `onsuccess` shape for
compare-and-swap (read, compare the revision, write, read back), and
`diagnostics/log.ts` used a cursor. [`idb`](https://github.com/jakearchibald/idb) wraps
IndexedDB in Promises without a schema layer, so those nests become `await` calls in one
transaction. The vault transaction's timeout, `AbortSignal`, `durability: "strict"`,
quota error mapping and the rejection of a `blocked` open stay hand-written, and a
transaction still auto-commits when it awaits anything other than IndexedDB. Dexie
adds its own schema and migration layer, more than this use needs. ADR 0019 said the
diagnostics log uses raw IndexedDB like `vault/database.ts`.

### Deep equality

`same` in `packages/bitwarden/src/account.ts` (recursive; ignores `undefined` keys and
treats `null` and `undefined` as equal), `sameVaultEntry` in `vault/record.ts` and
`canonicalJson` in `packages/contracts/src/login.ts` (sorted keys and `JSON.stringify`),
plus 15 `JSON.stringify(a) === JSON.stringify(b)` comparisons.
[`dequal`](https://github.com/lukeed/dequal) or `isEqual` from
[`es-toolkit`](https://github.com/toss/es-toolkit) could replace some, but none matches
these meanings as is: `same` equates `null` with `undefined`, and the `JSON.stringify`
comparisons distinguish key order, drop `undefined` and use `toJSON`. The gain is small.

## Areas that need no library

- Dates: only epoch-millisecond differences and a UTC minute display; no calendar
  arithmetic or time zone conversion. date-fns, Day.js or Temporal would remove little
  more than `toISOString().slice(0, 16)`. Localized display fits `Intl.DateTimeFormat`
  and `Intl.RelativeTimeFormat` when the UI is translated.
- Retries: the three compare-and-swap retry loops (`connections/sessions.ts`,
  `vault/manager.ts`, `service/settings-sync.ts`) retry a conflict at once, with no
  backoff, so a backoff library such as p-retry does not fit. Login retry counts live in
  the XState machine.
- Fetch with a timeout: ky or ofetch would not remove `redirect: "error"`,
  `credentials: "omit"` or the bounded body reads, which Pateat writes for safety.
  `AbortSignal.timeout()` would shorten two call sites by two lines, but their tests
  drive the timeout with fake timers. The Bitwarden transport tells a cancel from a
  timeout and stays as it is.
- Logging: ADR 0019 compared LogTape and chose hand-written code.
- Accessible names of fields: `computeAccessibleName` from `dom-accessibility-api`
  follows the specification's order (`aria-label` before `<label>`, hidden referenced
  text included), so it would not give ADR 0037's visible name and saved recipe labels
  would stop matching.
- Hono request validation: `jsonBody` is five lines of `hono/validator` with Valibot,
  shaped so an error never echoes the input; `@hono/standard-validator` would not make
  it shorter.
- Serial queues and sleeps: one-line Promise chains (`storageQueue`, `slotQueue`) and
  `setTimeout` wrappers; a shared helper is enough, without p-queue.
- Masked account matching in `page/accounts.ts` is linear on purpose, so a page cannot
  slow it with backtracking; a glob library would not keep that.
- Hashes, HMAC and random values: Web Crypto.

## What the owner decided

On 2026-10-13:

- base64, base64url and hex: the standard API, with Chrome 140 as the minimum, and
  `RegExp.escape()` (14:13 and 14:21 UTC;
  [#495](https://github.com/risu729/pateat/pull/495)).
- IndexedDB: `idb` (14:21 UTC; [#501](https://github.com/risu729/pateat/pull/501)).
- Dates: [temporal-polyfill-lite](https://github.com/fabon-f/temporal-polyfill-lite)
  (14:21 UTC), although this survey found no need for a date library.
- Hono request validation: `@hono/standard-validator` (14:21 UTC;
  [#496](https://github.com/risu729/pateat/pull/496)), although this survey found it
  would not shorten the code.
- ECDSA DER conversion: the `DER` helper of
  [`@noble/curves`](https://github.com/paulmillr/noble-curves), with the pull request
  saying the gain is small and the change can be reverted if bundle size matters
  (14:35 UTC; [#499](https://github.com/risu729/pateat/pull/499)).
- CBOR: remove the COSE pre-check, let the crypto Worker's termination end a hanging SDK
  call, and read the security-state version with `cbor2` (14:37 UTC;
  [#503](https://github.com/risu729/pateat/pull/503)).
- Deep equality: no decision; left as it is.
