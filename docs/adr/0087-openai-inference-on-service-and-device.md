# ADR 0087: OpenAI inference on the service and the device

Status: accepted by the owner on 2026-11-11, recorded at 12:03 UTC. The owner asked
「openai
apiにサーバー側でもクライアント側でも対応するPR作って。必要なら分割してstackして。実APIに向けた検証は今はやらなくてよくて、issueにやることって書いておいて」.
OpenAI support and splitting the work into dependent PRs are authorized; the
implementation details below were chosen by an agent. Shared inference, service
credentials and relay, and extension integration are implemented in dependent changes.
Validation uses synthetic credentials and mocked HTTP; actual API verification is
deferred to [the verification issue](https://github.com/risu729/pateat/issues/1465).
Amends
[ADR 0014](0014-claude-generation-provider.md),
[ADR 0015](0015-per-owner-claude-credentials.md),
[ADR 0040](0040-running-without-the-service.md) and
[ADR 0083](0083-clef-first-for-sign-in-forms.md).

Date: 2026-11-11

## Context

The roles already use a shared AI SDK language-model interface, but model choices,
credentials, pricing and the device relay name Anthropic. Adding OpenAI must cover
both service calls and calls paid by a device, without sending a key to the other
provider or changing who pays.

The service uses a custom OIDC issuer for Anthropic WIF. OpenAI's
[WIF reference](https://developers.openai.com/api/reference/workload-identity-federation)
does not support arbitrary OIDC issuers outside its documented environments. The
service cannot assume that its current issuer works with OpenAI.

## Decision

- Add the direct `@ai-sdk/openai` adapter within the existing AI SDK dependency family.
  Use the
  [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
  at the fixed API origin, with explicit credentials, `store: false` and an explicit
  service tier. No environment-selected endpoint, tools, remote input references or
  streaming capability is added to the recipe roles.
- Keep Anthropic's current model defaults. An OpenAI device uses GPT-6.1 Sol at low
  effort and standard speed, then GPT-6.1 Terra after a refusal. The service owner
  chooses priced models for each role. Model identity includes the provider, so
  fallback and pricing do not confuse providers.
- Preserve local Valibot output checks. Existing schemas contain optional
  properties; request non-strict JSON-schema output from OpenAI rather than
  declaring these schemas compatible with its stricter subset. Invalid, incomplete
  or refused output never becomes an unchecked recipe.
- Preserve per-owner billing on the service. Store an owner's OpenAI API key in a
  dedicated encrypted record using WebCrypto AES-GCM, a fresh nonce and the owner
  ID as authenticated additional data. The encryption key is a Worker secret.
  Management reads return status only; saving or removing a key makes no provider
  call. Missing configuration or an unreadable record fails closed.
- The extension keeps one selected text provider and its key in trusted local
  storage, outside synced settings and exports. Changing the provider selector
  does not reinterpret a saved key. A key is sent only to its provider's fixed
  endpoint. This local storage is not OS-keystore encryption.
- A paired device advertises its provider on every request and replay. The service
  returns credential-free, provider-tagged requests. The device admits only the
  bounded text/structured-output request shape and rejects a mismatch before using
  its key. Unpaired generation uses the same adapter and accounting rules.
- Keep Clef's separately granted capability and first-choice behavior, independent
  of whether Anthropic or OpenAI supplies the subsequent text model.
- Keep existing time, token, call and spending bounds. Count output including
  reasoning, and distinguish ordinary input, cache reads and cache writes at the
  published rates. Unknown or inconsistent usage uses a conservative bound, never
  zero. The device's aggregate ledger survives provider/key replacement.
- Verify with synthetic credentials and mocked transports. Credential provisioning,
  deployment, model access, installed-browser behavior and actual billing remain
  in the linked verification issue.

## Consequences

OpenAI can be selected without removing Anthropic or giving a device the service's
credential. Enabling it on the service requires an encryption secret and an
owner-configured OpenAI key. Anthropic-only owners do not need either.

Offline tests establish request construction, local validation, isolation and
accounting behavior. They do not prove real API acceptance, model/tier access or
that estimated costs match billed costs.

## Alternatives

An operator-wide key would make the operator pay for other owners. A new inference
framework would duplicate the existing AI SDK abstraction. Assuming that the
existing custom issuer works with OpenAI WIF would claim unsupported compatibility.
None is adopted.
