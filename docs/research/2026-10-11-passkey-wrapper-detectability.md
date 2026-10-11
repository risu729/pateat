# Passkey wrapper detectability

Observed: 2026-10-11 at main `a62ada1`, in Playwright's Chromium 141.0.7390.37 (not
installed Chrome) with the production build loaded unpacked and no other extension.
Native requests were answered by a CDP virtual authenticator. This is dated evidence
for the [ADR 0007](../adr/0007-existing-passkey-assertions.md) bridge, not a claim
about every site.

## What a page can observe

Compared with the same browser without Pateat, on a top-level HTTPS page:

| Check                                                   | Without Pateat                       | With Pateat                                 |
| ------------------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| `Object.getOwnPropertyDescriptor(navigator.credentials, "get")` | `undefined`                  | enumerable, configurable accessor           |
| `Object.keys(navigator.credentials)`                    | `[]`                                 | `["get"]`                                   |
| `navigator.credentials.get === CredentialsContainer.prototype.get` | `true`                    | `false`                                     |
| `Function.prototype.toString.call(navigator.credentials.get)` | `function get() { [native code] }` | about 1 KB of minified source               |
| `get.name`, `get.length`, constructor                   | `"get"`, `0`, `Function`             | `"p"`, `1`, `AsyncFunction`                 |
| Assigning a function to `get`, then reading it back     | the assigned function                | Pateat's wrapper                            |
| Reads of `options.publicKey` per call                   | 1                                    | 3 when delegated; 2 when claimed (from the code) |
| Stack of an error thrown in a page getter on the options, or of a delegated rejection | page frames only | also `chrome-extension://<id>/content-scripts/passkey-main.js` |
| `message` events on `window` per request                | none                                 | `get` with the request snapshot, `ack`, `result`; `cancel` on abort or timeout |
| Discoverable `get` answered by the browser              | 1 to 4 ms                            | 5 to 19 ms                                  |

Error names and messages of delegated requests (bad `rpId`, missing challenge,
illegal `this`, a non-`AbortSignal` signal, an aborted signal) matched the browser's.

Any page can therefore tell that Pateat is installed, and the stack trace gives the
extension ID without a user gesture or visible prompt: a page calls `get` with an
options object whose `publicKey` getter records `new Error().stack` and returns
`undefined`. The manifest has no `web_accessible_resources`, so the ID cannot be used
to fetch extension files. An unpacked install's ID derives from its directory path.
Every extension that runs page-world code has the same stack-trace exposure; the
official Bitwarden extension's page script is served from
`chrome-extension://nngceckbapebfimnlniiiahkandclblb/`.

At `a62ada1`, the `result` message also carried the background's delegate
reason. `not-configured` told the page that the owner had excluded the site (or that
settings or the vault catalog could not be read), `ambiguous-credential` that the vault
held several passkeys for the site, `vault-incomplete` that a connection or item could
not be searched, and `no-credential` that none of these held. The relay now posts only `{ kind: "delegate" }`.

Claimed assertions are plain objects whose prototypes are set to
`PublicKeyCredential.prototype` and `AuthenticatorAssertionResponse.prototype`, which
the official Bitwarden extension does too
([webauthn-utils.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/autofill/fido2/utils/webauthn-utils.ts)).
`instanceof`, `Object.prototype.toString`, `toJSON` and `JSON.stringify` behave like
native results. Own property names are visible, and calling a prototype getter or
method on them, such as `PublicKeyCredential.prototype.toJSON.call(credential)`, throws
`TypeError: Illegal invocation`.

## Sites

- `https://webauthn.io/`: registration and sign-in with a new passkey on the virtual
  authenticator succeeded with and without Pateat; the sign-in request went through
  the wrapper and was delegated.
- `https://login.microsoftonline.com/` made a conditional request on load, which Pateat
  delegated; GitHub, Google, Amazon Japan and PayPal sign-in pages loaded without
  added console errors. Only page load was tested, without accounts.
- CreepJS (`https://abrahamjuliot.github.io/creepjs/`) produced the same fingerprint ID
  with and without Pateat, so its lie detection did not flag the wrapper.

## Page-side wrappers

A page script that saves `navigator.credentials.get`, assigns its own wrapper and calls
the saved function with a rebuilt options object (a deep copy, as a base64-to-buffer
shim does) ran 4 times per request with Pateat instead of once, and Pateat made 4
background round trips; the request still succeeded. Each rebuilt call is a new
request to Pateat, and only the same-challenge cut-off stops the chain. A wrapper that
also replaces the challenge never reaches that cut-off: capped at 30 runs in the test,
it ran 31 times and the request failed. Without Pateat it ran once and succeeded.
