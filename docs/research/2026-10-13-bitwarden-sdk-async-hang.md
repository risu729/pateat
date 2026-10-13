# Bitwarden SDK async exports that never settle

Researched: 2026-10-13, from the repository at `ced0113` (main). The owner asked whether
the SDK hang behind `packages/bitwarden/src/cose.ts` is really a bug, whether it is
intended, where a fix would belong and how heavy it would be, before anything is
reported upstream. Nothing was reported: the owner chose not to file anything
(15:00 UTC).

## Versions

| Component | Version | Source |
| --- | --- | --- |
| `@bitwarden/sdk-internal` | 0.2.0-main.1100 (pinned) | npm `gitHead` [`3b2c8fc`](https://github.com/bitwarden/sdk-internal/tree/3b2c8fc365c1e450cdcee23c9283353305f6128e) |
| `@bitwarden/sdk-internal` | 0.2.0-main.1115 (latest) | main [`2f761f9`](https://github.com/bitwarden/sdk-internal/tree/2f761f9e6b8eb7b08938bc29bab6f58e8ff1625a) |
| `wasm-bindgen` / `wasm-bindgen-futures` | 0.2.114 / 0.4.64 | `Cargo.lock` of both SDK commits |
| `tsify` | 0.5.6 | `Cargo.lock` of both SDK commits |
| `wasm-bindgen` (comparison) | 0.2.129, main [`f57e205`](https://github.com/wasm-bindgen/wasm-bindgen/tree/f57e205b2bc0249e03aa62cfb2415b38fb6bf3b3) | crates.io, GitHub |
| `tsify` (comparison) | 0.5.8, main [`963c140`](https://github.com/madonoharu/tsify/tree/963c1405a46b4958aebfcb36cd02143a3f6c176e) | crates.io, GitHub |

## Observations

Node 22 with the SDK's `node/` build, synthetic inputs, 1–1.5 s wait per call:

| Call | Result | Uncaught exception |
| --- | --- | --- |
| `initialize_user_crypto` with `userId: "not-a-uuid"` | never settles | ``Error: UUID parsing failed: invalid character: found `n` at 0`` |
| `initialize_user_crypto` with V2 `signed_public_key` and `security_state` set to `"AAAA"` | never settles | `Error: InvalidCoseEncoding` |
| `initialize_user_crypto` with well-formed shapes and bad key bytes | rejects (`Cryptography error, The cipher key has an invalid length`) | none |
| `initialize_user_crypto` on a freed `CryptoClient` | never settles | `null pointer passed to rust` |
| synchronous `crypto()` on a freed `PasswordManagerClient` | throws synchronously, same message | none |
| `free()` on the `CryptoClient` of a call that never settled | throws `attempted to take ownership of Rust value while it was borrowed` | none |

The call that never settled keeps its borrow of the client, so that client can no longer
be freed. Terminating the Worker discards the whole instance.

A crate with only `wasm-bindgen` 0.2.129 and `tsify` 0.5.8, built with
`wasm-bindgen --target nodejs`, shows the same behaviour without any Bitwarden code:

```rust
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Point { pub x: u32 }

#[derive(Tsify, Serialize, Deserialize)]
pub struct Point2 { pub x: u32 }

#[wasm_bindgen] pub fn sync_point(p: Point) -> u32 { p.x }
#[wasm_bindgen] pub async fn async_point(p: Point) -> u32 { p.x }
#[wasm_bindgen] pub async fn async_ts_point(p: Ts<Point2>) -> Result<u32, JsError> { Ok(p.to_rust()?.x) }
#[wasm_bindgen] pub async fn async_body_throw(x: u32) -> u32 {
    if x == 0 { wasm_bindgen::throw_str("thrown in body"); }
    x
}
// plus `Thing` with `fn ping_sync(&self)` and `async fn ping(&self)`
```

| Call | Result |
| --- | --- |
| `sync_point({ x: "a" })` | throws synchronously: `invalid type: string "a", expected u32` |
| `async_point({ x: "a" })` | never settles; the same message is an uncaught exception |
| `async_ts_point({ x: "a" })` | rejects |
| `ping_sync()` on a freed `Thing` | throws synchronously: `null pointer passed to rust` |
| `ping()` on a freed `Thing` | never settles; uncaught `null pointer passed to rust` |
| `async_body_throw(0)` | never settles |
| `async_point({ x: "a" })` then `async_point({ x: 5 })` in the same tick | the second also stays pending until an unrelated later async call runs the queue, then resolves 5 |
| a good call queued before a bad one | resolves |
| `async_point({ x: 2 })` afterwards | resolves 2; the instance stays usable |

## Mechanism

1. For an `async` export, wasm-bindgen's macro puts the receiver and argument
   conversions inside `future_to_promise(async move { … })`
   ([codegen.rs at 0.2.114, lines 757–777](https://github.com/wasm-bindgen/wasm-bindgen/blob/0.2.114/crates/macro-support/src/codegen.rs#L757-L777);
   unchanged on main,
   [lines 1131–1137](https://github.com/wasm-bindgen/wasm-bindgen/blob/f57e205b2bc0249e03aa62cfb2415b38fb6bf3b3/crates/macro-support/src/codegen.rs#L1131-L1137)
   and
   [1200–1205](https://github.com/wasm-bindgen/wasm-bindgen/blob/f57e205b2bc0249e03aa62cfb2415b38fb6bf3b3/crates/macro-support/src/codegen.rs#L1200-L1205)).
   A synchronous export runs the same conversions during the call.
2. The future is first polled from a `queueMicrotask` callback,
   `QueueState::run_all`
   ([queue.rs, lines 32–51](https://github.com/wasm-bindgen/wasm-bindgen/blob/0.2.114/crates/futures/src/queue.rs#L32-L51)).
3. A failed conversion calls `wasm_bindgen::throw_str`: tsify's generated
   `FromWasmAbi`
   ([wasm_bindgen.rs, lines 244–248](https://github.com/madonoharu/tsify/blob/963c1405a46b4958aebfcb36cd02143a3f6c176e/tsify-macros/src/wasm_bindgen.rs#L244-L248),
   the same in 0.5.6) and wasm-bindgen's own null check
   ([rt/mod.rs, lines 280–284](https://github.com/wasm-bindgen/wasm-bindgen/blob/0.2.114/src/rt/mod.rs#L280-L284)).
4. The JS exception leaves `run_all` partway, becomes an uncaught exception, and the
   promise's `resolve`/`reject` is never called. `run_all` clears `is_scheduled` first,
   so tasks queued behind it wait for the next scheduled task. In a Worker the exception
   reaches the parent's `worker.onerror`.

In the SDK, `#[bitwarden_ffi::wasm_record]` adds `tsify(into_wasm_abi, from_wasm_abi)`
to every record type
([wasm_record.rs, lines 28–32](https://github.com/bitwarden/sdk-internal/blob/3b2c8fc365c1e450cdcee23c9283353305f6128e/crates/bitwarden-ffi-macro/src/wasm_record.rs#L28-L32)),
including `InitUserCryptoRequest`
([crypto.rs, lines 81–82](https://github.com/bitwarden/sdk-internal/blob/3b2c8fc365c1e450cdcee23c9283353305f6128e/crates/bitwarden-core/src/key_management/crypto.rs#L81-L82)).
UUID and COSE parsing happen during its serde deserialization, so they reach step 3.
Thirteen files also hold hand-written `FromWasmAbi` impls that call `unwrap_throw` in
`from_abi`, for types such as `EncString` and `SymmetricCryptoKey`.

## Bug or intended

- **wasm-bindgen.** A panic inside the future is a documented, known limitation:
  `future_to_promise_typed` says the promise "will not resolve" and that this is "hoped
  to be fixed one day"
  ([js-sys futures/mod.rs, lines 385–393](https://github.com/wasm-bindgen/wasm-bindgen/blob/f57e205b2bc0249e03aa62cfb2415b38fb6bf3b3/crates/js-sys/src/futures/mod.rs#L385-L393));
  with `panic = "unwind"`, panics reject with `PanicError` (guide,
  `reference/catch-unwind.md`). Neither the docs nor the changelog cover the
  argument-conversion or freed-object cases, where the throwing code is generated by
  wasm-bindgen and the synchronous export throws normally, nor the stalled sibling
  tasks. These are undocumented forms of the known limitation. No matching issue was
  found from GitHub issue search titles, which does not prove none exists.
- **tsify.** Known and addressed: 0.5.7 deprecated `from_wasm_abi` in favour of `Ts<T>`
  ([CHANGELOG](https://github.com/madonoharu/tsify/blob/963c1405a46b4958aebfcb36cd02143a3f6c176e/CHANGELOG.md#v057),
  [README](https://github.com/madonoharu/tsify/blob/963c1405a46b4958aebfcb36cd02143a3f6c176e/README.md#why-are-the-wasm_abi-attributes-deprecated);
  issues [#47](https://github.com/madonoharu/tsify/issues/47),
  [#65](https://github.com/madonoharu/tsify/issues/65),
  [#86](https://github.com/madonoharu/tsify/issues/86), and the open
  [#93](https://github.com/madonoharu/tsify/issues/93) for a function-level macro). The
  README calls the exception catchable, which is not true for async exports.
- **Bitwarden.** A known trade-off: `Cargo.toml` pins `tsify` to `>=0.5.5, <0.5.7`
  because the migration is "going to be complex"
  ([lines 152–161](https://github.com/bitwarden/sdk-internal/blob/2f761f9e6b8eb7b08938bc29bab6f58e8ff1625a/Cargo.toml#L152-L161),
  [#1448](https://github.com/bitwarden/sdk-internal/pull/1448)). The migration is under
  way as PM-42985: [#1503](https://github.com/bitwarden/sdk-internal/pull/1503) (merged)
  adds project macros and plans to bump tsify last, citing memory leaks;
  [#1581](https://github.com/bitwarden/sdk-internal/pull/1581) (draft) adds wire traits
  that replace the hand-written `unwrap_throw` with `WireError::Parse`. Neither mentions
  promises that never settle. No related sdk-internal issue was found.

## Where a fix would belong

| Where | Change | Weight |
| --- | --- | --- |
| wasm-bindgen, option A | Run receiver and argument conversions before `future_to_promise`, so a failure throws synchronously as in a synchronous export | Tens of lines in the shared call construction plus tests. Changes every async export: the `self` borrow starts at the call, so `obj.asyncM(); obj.free()` in one tick would throw; panics during conversion under `panic = "unwind"` would need their own catch. Fixes only the argument case |
| wasm-bindgen, option B | Catch a JS exception around each task's poll, reject that task's promise, and keep draining the queue | Larger; also fixes body exceptions and stalled sibling tasks |
| tsify | None; `Ts<T>` already moves conversion into the function body | — |
| Bitwarden SDK | Stop using `from_wasm_abi` and the throwing hand-written impls; convert inside the function and return `Err` | Heavy: about 100 record types (`from_wasm_abi` on 112 lines in 49 files outside the macro crate) and 13 files of hand-written impls, and `Ts<T>` cannot appear in signatures shared with UniFFI. Already in progress as PM-42985. Cannot fix wasm-bindgen's own checks, such as a freed `self` |

## Effect on Pateat

None beyond what exists. Crypto runs in a Worker, and
[`offscreen.ts`](../../apps/extension/src/crypto/offscreen.ts) terminates the Worker on
`onerror` with `crypto-failed`, with a 30 s timeout as the backstop. Worker termination
also discards the borrowed client that a stranded call leaves behind, so the local COSE
pre-checks are not needed to avoid the hang.
