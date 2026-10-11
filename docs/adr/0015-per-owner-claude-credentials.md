# ADR 0015: Per-owner Claude credentials through Workload Identity Federation

Status: accepted by the owner on 2026-10-11. Amends
[ADR 0014](0014-claude-generation-provider.md): the service no longer holds an operator
Anthropic API key as a Worker secret. The issuer, the per-owner identifiers and the
token exchange are implemented in `services/api/src/claude/`; the service inference
route that uses them, and a way for owners to enter their identifiers, are still
planned.

Date: 2026-10-11

## Context

ADR 0014 put one Anthropic API key in a Worker secret. That key pays for every owner
on the service, and the owner does not want to pay for other users' inference once
the service serves several people. A Worker secret is encrypted at rest and cannot be
read back from the dashboard or Wrangler, but it is still a long-lived key.

Anthropic does not let third-party applications use Claude Free, Pro or Max plans:
"Anthropic does not permit third-party developers to offer Claude.ai login into their
own applications, or to route requests through Free, Pro, or Max plan credentials on
behalf of their users"
([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). Each
owner therefore pays for API usage themselves.

Anthropic's
[Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)
(WIF) exchanges a JWT signed by an OIDC issuer the organization trusts for an access
token that lasts minutes. The JWT must use an asymmetric algorithm such as ES256, carry
a `kid` matching the issuer's JWKS, include `sub`, `iat` and `exp`, and live at most one
hour by default. An assertion with a `jti` can be exchanged only once
([WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference)).

## Decision

Each owner brings their own Claude credentials. The operator never pays for another
owner's inference, and there is no shared operator key.

The first credential type is WIF, used by the owner's own deployment first:

- The Pateat Worker is an OIDC issuer at its public HTTPS origin. It serves
  `/.well-known/openid-configuration` and a JWKS without Access, so Anthropic can
  fetch them. The ES256 private key is a Worker secret holding a private JWK with a
  `kid`. The JWKS publishes the same key without `d`. A new key is published before
  it signs anything, and the old key stays published until its tokens expire.
- Each owner registers that issuer in their own Claude Console (Settings → Workload
  identity → Custom OIDC). They create a service account and a federation rule whose
  `subject_prefix` is exactly `owner:<ownerId>`, preferably with the
  `workspace:inference` scope.
- The service stores per owner only non-secret identifiers: `federationRuleId`
  (`fdrl_…`), `organizationId`, `serviceAccountId` (`svac_…`) and `workspaceId`
  (`wrkspc_…`). Where they are entered belongs to the server web UI design.
- For each exchange the Worker signs a fresh JWT `{ iss: <origin>, sub:
  "owner:<ownerId>", aud: "https://api.anthropic.com", iat, nbf, exp, jti }` with a
  lifetime of five minutes. It posts the JWT
  to `POST https://api.anthropic.com/v1/oauth/token` with the `jwt-bearer` grant and
  the four identifiers, then calls Claude with the returned `access_token`.
- The Worker signs only for the authenticated owner of the request, so one owner
  cannot obtain another owner's token.

The second credential type is a registered Anthropic API key. It comes later and is
stored in D1 encrypted with AES-GCM. The encryption key is a Worker secret, and the
owner ID is the AES-GCM additional authenticated data.

Calls from the extension straight to Claude are added with the no-server mode, not
before.

Libraries: `hono/utils/jwt` (already a dependency and already used for Access JWT
verification) signs ES256 JWTs with a `kid`. The exchange is a `fetch` whose response is
validated with Valibot, and Claude is called through `@ai-sdk/anthropic` with
`authToken` instead of `apiKey`. AES-GCM uses WebCrypto. No dependency is added.

The paid benchmark is unchanged. It runs outside the service and reads an API key from
`ANTHROPIC_API_KEY`, as ADR 0014 describes.

## Consequences

The service holds no long-lived Anthropic credential. A leaked D1 database reveals
only identifiers. An owner stops Pateat's access by archiving the federation rule in
their Console. Usage, rate limits and spending limits apply in the owner's own
workspace.

The signing key can mint assertions for every owner who registered the issuer. Owners
must trust the operator as they would with a stored key, and the signing key needs
the same care as any Worker secret.

Setup is heavier than pasting a key: an Anthropic organization admin creates an
issuer, a service account and a rule, then enters four identifiers. The owner accepts
this for their own deployment. The registered-key option covers people who want a
simpler setup.

The issuer endpoints must stay publicly reachable. If they are down or the JWKS is
stale, new exchanges fail until Anthropic can fetch the keys again.

## Alternatives

- Operator key in a Worker secret (ADR 0014): simplest, but one owner pays for
  everyone.
- Cloudflare AI Gateway stored provider keys: the Worker holds a gateway token instead
  of the Anthropic key. That is a new provider, prompts pass through Cloudflare, and a
  leaked gateway token can spend the key in the same way.
- Registered API keys only: one value to paste, but D1 then holds encrypted long-lived
  keys. Kept as the later second option.
- `jose` for signing: the most complete JOSE library, but ES256 signing is already
  covered by Hono.
- `@anthropic-ai/sdk` `oidcFederationProvider` for the exchange: it handles caching
  and refresh, but it would add a second Anthropic client next to `@ai-sdk/anthropic`.
