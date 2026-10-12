# ADR 0033: No site-specific features unless strictly necessary

Status: accepted by the owner on 2026-10-12 (13:38 UTC).

Date: 2026-10-12

## Context

Phase 1 checks Pateat on the owner's everyday sites ([plan](../plan.md#roadmap)), so
each problem shows up on one site first. Fixing it for that site alone, by branching on
its host, matching its button text or element IDs, or naming it in a prompt, would make
every such site a maintenance item and leave other sites with the same kind of page
unhandled. The owner's rule (13:38 UTC): "you must not implement any site-specific
features unless strictly necessary", and to be told about any that already exist.

## Decision

- **Login behavior is general.** The extension, the service, the AI prompts and their
  local checks never branch on a site's host, origin, path or name, and never carry a
  site's own element IDs, class names, selectors or wording. A problem found on one site
  is fixed as a rule about the page that every site with the same kind of page gets:
  its structure, web standards such as `autocomplete`, ARIA roles and WebAuthn, the
  recipe generated for its origin, or the AI's judgment.
- **What differs per site stays data.** The recipe generated and stored for an origin
  ([ADR 0013](0013-service-held-recipes-and-settings.md),
  [ADR 0018](0018-recipe-generation-route.md)), the owner's settings and the Bitwarden
  items are how Pateat adapts to a site; they are not site-specific features.
- **Strictly necessary** means a general rule cannot do it, such as recognizing a
  third-party service that only its host tells apart, or matching what Bitwarden itself
  does. Each such case needs the owner's approval, and its code comment and owning
  document say why it cannot be general.
- **Site names stay where they are not behavior:** as examples in comments and
  documents, as dated evidence in ADRs, the plan and research notes, and in tests and
  evaluation data.
- Word lists per language, such as the English and Japanese passkey words in
  `packages/inference/src/plan.ts`, are not site-specific and stay.

## Consequences

- A fix proposed after a failure on one site states the general page rule it adds.
- On 2026-10-12 the existing code and records were checked against this rule. These
  name particular services or sites in behavior, and wait for the owner's decision:
  - the CAPTCHA frame hosts in `apps/extension/src/page/sign-in-state.ts` (reCAPTCHA,
    hCaptcha, Cloudflare Turnstile);
  - the `google.com` and `script.google.com` exception in
    `packages/bitwarden/src/uri.ts` and the `steam://` TOTP keys in
    `packages/bitwarden/src/totp.ts`, which mirror the Bitwarden clients;
  - [ADR 0026](0026-sign-in-through-identity-providers.md)'s fixed Google and Microsoft
    origins and the identity-provider pages it recognizes by origin, path and heading
    (not implemented);
  - the phase 4 item to complete GitHub's "Verify your two-factor authentication (2FA)
    settings" page ([plan](../plan.md#phase-4-issues-and-work-as-needed)), not
    implemented.
