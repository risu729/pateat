# ADR 0052: Chrome Immediate UI requests are answered like other passkey requests

Status: accepted by the owner on 2026-10-19. At 13:36 UTC the owner chose to merge
[#658](https://github.com/risu729/pateat/pull/658) now, which replaces the 2026-10-14
choice to delegate these requests
([ADR 0007](0007-existing-passkey-assertions.md)). At 20:48 UTC the owner chose to treat
an Immediate UI request exactly like other passkey get requests 「ほかのパスキー要求と
同じ扱いにすれば」, and at 20:56 UTC to keep the feature and to use the normal 10-second
lookup limit. Implemented (unit tests only; not yet checked in installed Chrome or on a
real site).

Date: 2026-10-19

## Context

Chrome's Immediate UI asks with `navigator.credentials.get({ publicKey, uiMode:
"immediate" })` when the person presses a site's sign-in button. Chrome's
[guide](https://developer.chrome.com/docs/identity/immediate-ui-mode), checked on
2026-10-19, says the call needs a user gesture, throws `NotAllowedError` for a nonempty
`allowCredentials` and in incognito, rejects without UI when no local credential
exists, and cannot be dismissed with `signal`. Chrome's own dialog cannot offer
Pateat's stored passkeys. Until this ADR the page relayed such a request as `immediate`
mediation and the background delegated it.

## Decision

- The page relays `uiMode: "immediate"` beside `mediation`; the origin trial's
  `mediation: "immediate"` still delegates as unsupported mediation, and any other
  `uiMode` is left to the browser. Requests naming other credential types (`password`,
  `identity` and the rest) delegate with the caller's arguments, as every get does.
- Pateat answers it as a modal request, with the same selection, chooser and limits:
  - one matching passkey, or the saved site default, signs without a window;
  - several matches and no default open Pateat's chooser window
    ([ADR 0021 C](0021-account-choice-outside-settings.md#c-several-passkey-candidates));
  - in a tab Pateat already signed in from, or after a logout click, the chooser asks
    again
    ([ADR 0021 D](0021-account-choice-outside-settings.md#d-after-a-logout-choose-again-detection-l1));
  - no match delegates, and Chrome then rejects at once;
  - a running login limits the search to its item, and lookup and signing have the
    normal 10-second limit (`RUNTIME_TIMEOUT_MS`); time in the chooser does not count.
- Where Chrome itself would reject the request, Pateat delegates instead of answering:
  without a user gesture (whatever the presence setting), with a nonempty allow list
  (`immediate-allow-credentials`), and in incognito or outside an active, focused
  document (`immediate-document-not-active`).
- Reading `uiMode` is not an experimental feature under the
  [platform rules](../development.md#platform-features): Pateat calls no Immediate UI
  API, it only reads an option a page passes, as it already did before this ADR.

## Consequences

An Immediate UI sign-in button signs in with a stored passkey when the vault holds one
for the site, with the same window as other requests when several match. When Pateat
delegates after an asynchronous lookup or after the chooser closes, the page's user
gesture may have expired and Chrome may reject the request, leaving the site's own
fallback. A page that aborts its `signal` cancels Pateat's request, as for other
requests, although Chrome's own dialog ignores it. No permission or vault write is
added, and no `PasswordCredential` is produced; `password: true` needs a design of its
own. The official Bitwarden extension drops `uiMode` and asks through its popout; the
difference is in [Bitwarden differences](../bitwarden-differences.md#passkeys).

## Alternatives

Keep delegating every Immediate UI request: Chrome's dialog never offers Pateat's
passkeys. Never open the chooser and delegate when several match or after a logout
(the first version of this PR, with a 1-second limit): the owner chose the same
handling as other requests instead.
