# ADR 0001: Local login execution with vault adapters

Status: proposed until the documentation PR merges; accepted upon merge.
Date: 2026-10-10

## Context

Agent-operated Chrome sessions can stop at login. Official autofill and
interactive extension UI are not reliable foundations for inactive tabs. The
owner wants existing vault data, persistent unlock, automatic login submission,
and passkeys without requiring a native companion.

## Options

1. Drive the official Bitwarden extension UI: inherits focus/pop-up dependencies.
2. Use a desktop/native bridge: violates the extension-only client requirement.
3. Build a local MV3 executor with a narrow vault adapter and optional recipe API.

## Decision

Choose option 3. Bitwarden is the first adapter, not a product-wide assumption.
Keep vault secrets and signing local. Use explicit tab/frame/document identity,
no extension-origin page iframes, and no debugger attachment of our own. Accept
persistent local unlock material as a deliberate product requirement. Execute
validated data recipes through packaged code; AI never receives vault values.

Existing software passkeys are planned but subject to honest UV/UP, counter and
interoperability gates. Do not turn a desire for unattended authentication into
a claim that every passkey ceremony can be silently satisfied.

## Consequences and verification

We own login behavior and provider compatibility. An adapter boundary permits
future vaults without speculative implementations. MV3 recovery, origin binding,
Chrome use coexistence and correct secret handling require the acceptance matrix
in [the plan](../plan.md). No runtime is implemented by accepting this ADR.
