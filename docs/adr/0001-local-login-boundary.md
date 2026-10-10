# ADR 0001: Local login execution with vault adapters

Status: accepted in PR #1; implementation follows the milestone plan.
Date: 2026-10-10

## Context

Agent-operated Chrome sessions can stop at login. Official autofill and
interactive extension UI are not reliable foundations for inactive tabs. The
owner wants existing vault data, persistent unlock, automatic login submission,
and passkeys without requiring a native companion.

## Options

1. Drive the official Bitwarden extension UI: inherits focus/pop-up dependencies.
2. Use a desktop/native bridge: violates the extension-only client requirement.
3. Build a local MV3 executor with capability-based vault adapters and an optional
   settings/recipe service.

## Decision

Choose option 3. Bitwarden is the first adapter, not a product-wide assumption.
Adapters ship with the extension; they are not remotely loaded plugins. Model
multiple connections and distinguish provider authentication from vault unlock
and from Pateat service authentication. Do not assume every provider login uses
or yields a master password.
Keep vault secrets and signing local. Use explicit tab/frame/document identity,
no extension-origin page iframes, and no debugger attachment of our own. Accept
persistent local unlock material as a deliberate product requirement. Execute
validated data recipes through packaged code; AI never receives vault values.

Provide human-operated extension settings from the start. Apply connection,
item, field and site policy before execution; a matched, eligible login can run
without a new prompt each time. The local core and cached recipes do not depend
on service availability. Server AI and Access-authenticated, server-readable
private settings sync are the initial service configuration. Direct AI,
alternative service authentication and E2EE settings sync remain later options.

Initial vault use is read-only, with existing zero-counter site passkey
assertions. This is a delivery limit, not a permanent read-only product contract.
Future read/create/update permissions are independent for each connection;
adding write support must not grant it to existing connections. Authorized future
write automation need not require confirmation for every operation. Provider
passkey login/unlock is a separate later capability from using a saved site
passkey. External email/SMS OTP, magic links and post-login actions are also
deferred, not excluded. Action/transaction permissions are separate from
credential-use permissions and scoped by site and action.

Existing software passkeys are planned but subject to interoperability gates. The
original truthful UV/UP condition is amended by the owner's decision in
[ADR 0007](0007-existing-passkey-assertions.md) to set both flags unattended. Nonzero
counter synchronization/writeback is deferred. Requests Pateat does not claim, including
hardware-bound credentials, still need their own ceremony.

## Consequences and verification

We own login behavior and provider compatibility. Shared internal operations
separate policy and execution from settings, future page/HTTPS UI and low-priority
MCP. These surfaces do not expand permissions merely by being added. A future
action executor must preserve the distinction between login completion and
authorized post-login effects. Adapter boundaries permit future capabilities
without speculative implementations. MV3 recovery, origin binding,
Chrome use coexistence and correct secret handling require the acceptance matrix
in [the plan](../plan.md). No runtime is implemented by accepting this ADR.
