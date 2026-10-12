# Passkey wrappers of Pateat and the official Bitwarden extension

Researched: 2026-10-10, from [`bitwarden/clients`](https://github.com/bitwarden/clients)
`main` at `df96418` and experiments in Playwright's Chromium 141.0.7390.37 (not
installed Chrome) with two synthetic extensions. "Observed" means checked in code or by
experiment; "inferred" means not checked. This is the research that led the owner to
keep Pateat's wrapper outermost
([ADR 0007, bridge topology](../adr/0007-existing-passkey-assertions.md#bridge-topology));
the results in the owner's Chrome are in the [plan](../plan.md). Pateat's own code has
changed since; this note keeps only what is about Bitwarden and Chromium.

## How the Bitwarden extension wraps `get` (observed)

- `apps/browser/src/autofill/fido2/background/fido2.background.ts` registers two
  scripts at run time with `chrome.scripting.registerContentScripts`, not in the
  manifest: a MAIN-world page script and an isolated content script, on
  `https://*/*` and `http://localhost/*` (excluding `https://*/*.xml*`), in all frames,
  at `document_start`. It registers them only while the setting "Ask to save and use
  passkeys" (`enablePasskeys`, under Settings → Notifications) is on; turning it off
  unregisters them and stops the scripts in open tabs.
- `apps/browser/src/autofill/fido2/content/fido2-page-script.ts` saves the current
  function (`navigator.credentials.get.bind(navigator.credentials)`) and then assigns
  its own with `navigator.credentials.get = …`; it does the same for `create`.
- Every request with `publicKey` goes to Bitwarden's background. A request without
  `mediation` always opens Bitwarden's window: unlock if the vault is locked, "No
  passkeys found" if nothing matches, otherwise a passkey choice, plus a master
  password check when `userVerification` is `"required"`. It sets
  `requireUserVerification` to true also when `userVerification` is missing or
  `"preferred"`.
- For `mediation: "conditional"` it runs its own handling and the saved `get` at the
  same time and uses whichever answers first.

### When Bitwarden passes the request on (observed)

Bitwarden answers `{ fallbackRequested: true }` and, after waiting for focus, calls the
saved `get` when:

- its passkey feature is off for the page: signed out, the site is in its excluded
  domains (`neverDomains`), the page is Bitwarden's own web vault, or `enablePasskeys`
  is false;
- every entry of `allowCredentials` has `transports` and none includes `"internal"`;
- the user picks another method in Bitwarden's window.

Closing the window instead rejects without falling back. The page receives a plain
`Error` (name `"Error"`), not `NotAllowedError`, because the `DOMException` name is lost
when the background sends the error back.

### When Bitwarden restores the saved `get` (observed)

The page script's `destroy()` assigns the saved `get` and `create` back. It runs when
the port between the content script and the background disconnects:

- right after the page loads, when the site is excluded or Bitwarden is signed out (the
  background disconnects the port);
- when `enablePasskeys` is switched;
- (inferred) when the Bitwarden extension is updated, reloaded or disabled.

If another wrapper was installed after Bitwarden's, a plain-value restore removes it as
well. In the experiment, after `destroy()` neither extension's function was called.

## Order of MAIN-world scripts between extensions (observed in Chromium 141)

Two synthetic extensions, one installing a wrapper like Pateat's did on 2026-10-10
(manifest `world: "MAIN"`, `Object.defineProperty` with a value) and one like
Bitwarden's (`registerContentScripts`, assignment, `destroy()`), were loaded with 11
different pairs of extension IDs, three times each:

| IDs (Pateat-like / Bitwarden-like) | Ran first      | Call order                        |
| ---------------------------------- | -------------- | --------------------------------- |
| `ldbd…` / `ijhj…`                  | Bitwarden-like | Pateat-like → Bitwarden-like      |
| `eamd…` / `hkhf…`                  | Pateat-like    | Bitwarden-like → Pateat-like      |
| `degg…` / `dahm…`                  | Bitwarden-like | Pateat-like → Bitwarden-like      |
| `ebep…` / `ojca…`                  | Pateat-like    | Bitwarden-like → Pateat-like      |

(4 of the 11 pairs shown.) In every pair the extension whose ID sorts first ran first,
so its wrapper ended up inside and the other one answered first. Reversing the
`--load-extension` order or switching between static and run-time registration did not
change it. Chrome does not document this order, and installing an extension later
without a restart was not tried. The Chrome Web Store ID of the Bitwarden extension is
`nngceckbapebfimnlniiiahkandclblb`, and an unpacked extension's ID depends on its
folder path, so the order on a given machine could not be relied on. That is why
ADR 0007 makes Pateat outermost whatever the order.

## Scope differences

Per ADR 0007, Pateat's wrapper is installed in top-level frames only, while Bitwarden
runs in all frames, so requests from iframes go to Bitwarden or the browser. Pateat
never wraps `create`, so passkey registration is unaffected.

## Left open

- In the owner's Chrome on 2026-10-10, with Bitwarden outside, a request without a UV
  requirement still reached Pateat. The Bitwarden source does not explain this: such a
  request should also open its window. Possible causes (inferred) are the window's "use
  browser" link or a window left from an earlier request. It was not re-checked.
- Whether branded Chrome uses the same ID order, and the order right after installing
  an extension.
- Whether stopping Bitwarden's MV3 service worker disconnects the port and runs
  `destroy()`.
