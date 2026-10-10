# ADR 0003: Minimal Cloudflare recipe service with replaceable inference

Status: accepted in PR #1; implementation follows the milestone plan.
Date: 2026-10-10

Proposed 2026-10-10 amendment: the inference section incorporates the October 9 Clef
announcement as research and evaluation scope, not provider adoption. Other service,
identity and spending boundaries remain the accepted design.

## Context and options

Recipes should be learned, cached and repaired without placing vault secrets in
model prompts. The owner prefers Cloudflare and may have monthly Anthropic API
credit. Options are local-only execution, a broad hosted agent platform, or an
optional small recipe/settings API with provider adapters. The initial hosted
service must not become a requirement for replaying saved recipes locally.

## Decision

Choose the optional small API: one Worker plus D1 at M4 for private recipe and
settings synchronization and inference. Local-only use is supported through the
extension's options/settings page and saved recipes, without AI or a service
login. The initial AI path uses the service; direct inference from the extension
with a user-supplied provider key is a later option, not the recommended initial
mode. No public recipe sharing is planned initially. Use Valibot contracts,
server-held provider keys and bounded retries.

### Identity and settings

Use Cloudflare Access for the initial human service login. Verify that identity
before enrolling a device, then authorize extension service requests with
individually revocable, owner-scoped device credentials. Keep only their hashes
server-side and apply verified owner/device scope to every operation. Device
credential expiry, enrollment transport and recovery require an implementation
probe; Access login alone is not a complete device protocol.

Pateat service authentication and vault-provider authentication are independent.
Each device authenticates to and unlocks its vault locally. Service login does
not authenticate Bitwarden, unlock a vault, or recover vault decryption keys.

Initially store private settings in server-readable D1 records so service login
can restore those settings on a new device. This includes permitted site/account
bindings and defaults, not vault values, provider login secrets or unlock keys.
Treat account references and policy metadata as private even though the service
can read them. Store the settings needed for local execution durably in the
extension as well. AI receives only sanitized observations and semantic slots,
never account bindings or vault values.

Keep service identity verification behind an adapter so later deployments can
replace Access with OIDC or passkey-based service authentication. Access is not
a permanent product requirement. Client-side encrypted settings synchronization
is also a later option; its key transfer/recovery needs a separate design and
must not be implied by ordinary service login. This postpones E2EE settings sync,
not the existing requirement that vault secrets stay local.

### Inference and spending

Prefer Claude structured generation for previously unknown recipes if usable Console
credit is confirmed. Evaluate Clef-flash, Clef and Jev for finite candidate decisions.
They score supplied options, not arbitrary new recipes. Do not require a model round
trip for known recipes or declare a winner without task-specific tests. Keep the
finite-choice adapter contract separate from recipe generation. A Clef adapter may use
the Workers AI binding or REST; no agent orchestration layer is implied. Preserve
refusal/unavailable/abstention outcomes. A configured provider/model failure is returned
as an error; do not automatically fall back to another provider or model.

Decision adapters include an explicit unknown/none option, validate returned IDs
and probability shapes, and map unsuitable or low-confidence results to abstention.
Confidence is not authorization or proof of correctness. Validate joint field
mappings and all targets locally before execution. Bound the complete request,
including questions/options, before sending; never depend on provider truncation
of an observation. Initial evaluation uses sanitized pre-fill text/structure.
Clef-omni media inputs and self-hosted inference are deferred; media collection
needs a separate privacy contract and redaction/evaluation gate. See the
[dated Clef evidence](../research/2026-10-10-feasibility.md#clef-update-reviewed-2026-10-10).

Provide a monthly USD spending limit for Pateat-mediated inference. Accumulate
provider-reported cost when available, otherwise estimate from reported usage
and versioned rates. After recorded usage reaches the limit, stop new inference
requests and continue local saved-recipe execution. This is a practical spending
threshold, not a guaranteed billing ceiling: in-flight or concurrent requests
can overshoot it. Atomic maximum-cost reservations are not an initial
requirement. Keep estimates distinct from billed amounts, and test failure or
missing-usage accounting explicitly before enabling paid requests.

Record usage/cost for each inference attempt when available; missing usage is
unknown, not free. Provider retries share the bounded inference budget, while
repair attempts and website submission limits remain separate. Retrying inference
does not authorize an additional submission. Clef input-token usage uses versioned
model rates, not a universal output-token price assumption.

### Later interfaces

Keep operations independent of their UI: settings, permitted account selection,
execution requests and status share the same validation and authorization.
An optional remote MCP interface is a low-priority design extension, not an
initial implementation requirement. It may request permitted operations on an
online extension but never returns vault secrets or performs vault signing on
the server.
Before implementing it, verify with dummy operations that the intended AI client
can invoke permitted tools autonomously after connection; MCP cannot override
that client's approval or authentication rules. Local execution must not depend
on MCP availability.

### Delivery

Use cf, cloudflare.config.ts and Vite for the server. Reuse the owner's
wrangler-deploy-action, which already runs cf against prebuilt output. Plan CI
for extension and server, CD for the server only. Do not provision or deploy in
the docs PR, and do not modify the action without a reproduced missing capability.

## Consequences and verification

We own device enrollment/revocation, private settings access, redaction, spending
accounting and provider evaluation. Server-readable settings deliberately expose
settings metadata to the service operator; no E2EE claim is made for them.
Authorization tests must cover Access identity validation, device revocation,
cross-owner access and separation from vault authentication. Service outages,
revocation or exhausted AI spend must leave valid local saved recipes usable.
cf is beta, so exact versions and typed-config/test integration need a bootstrap
probe. Anthropic's published credit program does not prove this account has
claimed credit. Delivery requires a verified artifact, additive migrations,
deployment readback and hosted smoke tests as defined in [delivery](../delivery.md).
