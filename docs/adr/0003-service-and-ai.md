# ADR 0003: Minimal Cloudflare recipe service with replaceable inference

Status: proposed until the documentation PR merges; accepted upon merge.
Date: 2026-10-10

## Context and options

Recipes should be learned, cached and repaired without placing secrets in model
prompts. The owner prefers Cloudflare and may have monthly Anthropic API credit.
Options are entirely local inference/storage, a broad hosted agent platform, or
a small recipe API with provider adapters.

## Decision

Choose the small API: one Worker plus D1 when M4 requires cross-device recipe
sync/inference. Cached login execution stays local. Start with private
device/owner-scoped recipes and no public sharing. Use Valibot contracts,
server-held provider keys and bounded spend/retries.

Prefer Claude structured generation for previously unknown recipes if usable
Console credit is confirmed. Evaluate Jev for finite candidate decisions; do not
require a model round trip for known recipes or declare a winner without tests.
Preserve refusal/unavailable/abstention outcomes. No provider agent SDK is needed
to make ordinary inference requests.

Use cf, cloudflare.config.ts and Vite for the server. Reuse the owner's
wrangler-deploy-action, which already runs cf against prebuilt output. Plan CI
for extension and server, CD for the server only. Do not provision or deploy in
the docs PR, and do not modify the action without a reproduced missing capability.

## Consequences and verification

We own device enrollment, redaction, quota enforcement and provider evaluation.
cf is beta, so exact versions and typed-config/test integration need a bootstrap
probe. Anthropic's published credit program does not prove this account has
claimed credit. Delivery requires a verified artifact, additive migrations,
deployment readback and hosted smoke tests as defined in [delivery](../delivery.md).
