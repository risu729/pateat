# ADR 0046: Generation on passkey-only start pages

Status: proposed, implementation in progress. The owner authorized agents to finish
unstarted plan work autonomously, record questions as proposals and continue with the
recommended choice. That authorization is permission to proceed, not acceptance of the
detailed policy below. The agent-selected decisions remain unconfirmed. Proposes an
extension of [ADR 0016](0016-recipe-generation-trigger.md) and
[ADR 0018](0018-recipe-generation-route.md); preserves
[ADR 0034](0034-answer-page-passkey-requests.md)'s delegation without a recipe.

Date: 2026-10-17

## Context

Automatic generation currently requires sign-in inputs or an account list. A page
with only a button to sign in with an existing passkey therefore gets no recipe,
even when an eligible vault item matches its URI and holds a usable passkey.

## Decision

Proposed recommended choice, unconfirmed by the owner: after the existing ten-second
observation window, offer a top-level HTTPS page showing a locatable, enabled button
that names a passkey or security key, with no visible fill fields. Exclude buttons
whose labels or locators name registration, setup or management. Do not offer the
page immediately following submission. Require both the existing eligible URI match
and a usable discoverable passkey belonging to one of those items.

Send a value-free observation with `passkeyOnly: true` and empty `slots`, through
the existing authenticated generation route and its retry, spend and request bounds.
The model must identify a sign-in to an existing account and may abstain. Locally
validate its selected button and require an empty fill plan and one submit action.
Store a declarative recipe explicitly marked `passkeyOnly` with no password route.
The ordinary login account choice and passkey route perform execution, so a
password-only item never clicks that button or supplies a password fallback.

Questions for owner review: approve this button-only qualification, the ten-second
window, and the explicit passkey-only recipe shape? The implementation proceeds with
these recommendations under the owner's autonomous-work instruction.

## Consequences

No new permissions, provider capability, site rules, or account operations are added.
A conditional request alone does not qualify a page or authorize a signature. Pages
without a recipe still delegate their requests. A generated recipe starts through
normal document/account checks; no direct signing is added to generation.

Local fake-provider and synthetic checks are required. No paid inference, deployment
or real-account compatibility is claimed by this proposal.

## Alternatives

- Keep passkey-only generation deferred, requiring manual recipes.
- Generate from every conditional request: exposes ordinary pages and may sign in
  without clear sign-in intent.
- Represent the passkey button as a password route: allows password-only items to
  press a button they cannot complete and creates an unsafe fallback.
