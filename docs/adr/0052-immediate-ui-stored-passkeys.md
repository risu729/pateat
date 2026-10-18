# ADR 0052: Stored passkeys for Chrome Immediate UI

Status: proposed, not confirmed by the owner. The owner requested finishing uncovered
plan work and recording questions with a suggested choice while implementation
continues. This proposal narrows the later Immediate UI work in ADR 0007; it does not
record acceptance or claim installed-Chrome compatibility.
Date: 2026-10-17

## Context

The [plan](../plan.md) leaves answering `uiMode: "immediate"` for later. Chrome's
[Immediate UI guide](https://developer.chrome.com/docs/identity/immediate-ui-mode),
checked on 2026-10-17, requires a user gesture, rejects nonempty `allowCredentials`
and incognito requests, and does not support programmatically dismissing the dialog
with `signal`. Its native picker cannot offer an extension's stored passkeys.

## Decision

Proposed question: should Pateat answer an Immediate UI request with its existing
automatic modal-passkey selection, or keep every Immediate UI request delegated?
Suggested choice: answer only the narrow stored-passkey case below, preserving the
owner's existing unattended signing policy. This remains unconfirmed by the owner.

- Keep `uiMode: "immediate"` separate from `mediation`; the obsolete origin-trial
  `mediation: "immediate"` keeps delegating. Unknown modes and unsupported mediation
  combinations delegate too.
- Handle public-key-only requests with an empty allowlist and no supplied signal.
  Password, federated, identity, OTP and digital credential combinations delegate
  with their original arguments.
- Require isolated-world transient activation and a visible, focused document, plus
  a browser-supplied active top-level document outside incognito. The permissive
  UP/UV policy does not waive these Immediate UI requirements.
- Keep the existing origin, RP ID, tab, document, configured-account and exact
  credential checks. Use only a currently eligible stored zero-counter passkey.
  A running login still restricts selection to its account.
- Never park the request for a login or open Pateat's chooser. Missing, ambiguous,
  incomplete or unsupported candidates and an account choice required after logout
  delegate. Bound lookup and signing by a short deadline, then delegate failures.

## Consequences

This is a Pateat wrapper behavior under the existing unattended signing policy; it
does not integrate an extension into Chrome's native account picker or provide the
native picker's account confirmation. Native UI, provider coexistence and real-site
compatibility need separate browser evidence. No browser permission or vault write
is added, and no `PasswordCredential` is produced. Delegation after asynchronous
lookup cannot guarantee that native transient activation remains available; Chrome
may reject it, allowing the site's fallback rather than an unattended broader flow.

## Alternatives

Keep delegating every Immediate UI request: preserves Chrome's complete native
behavior but leaves stored Pateat passkeys unavailable in this flow. Reuse Pateat's
chooser: introduces a separate prompt and a potentially long wait into a flow
intended to fall back quickly. Support passwords or mixed credentials: needs a
separate design for credential choice and `PasswordCredential` disclosure.
