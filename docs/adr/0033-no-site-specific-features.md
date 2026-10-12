# ADR 0033: No site-specific features unless strictly necessary

Status: accepted by the owner on 2026-10-12 (13:38 UTC) as policy; the decisions on
existing cases at 13:46 UTC.

Date: 2026-10-12

## Context

Phase 1 checks Pateat on the owner's everyday sites ([plan](../plan.md#roadmap)), so
each problem shows up on one site first. Fixing it for that site alone, by branching on
its host, matching its button text or element IDs, or naming it in a prompt, would make
every such site a maintenance item and leave other sites with the same kind of page
unhandled. The owner's rule (13:38 UTC): "you must not implement any site-specific
features unless strictly necessary", and to be told about any that already exist.

## Decision

- **Login behavior is general.** Unless strictly necessary, the extension, the service,
  the AI prompts and their local checks do not branch on a site's host, origin, path or
  name, and do not carry a site's own element IDs, class names, selectors or wording. A
  problem found on one site is fixed as a rule about the page that every site with the
  same kind of page gets: its structure, web standards such as `autocomplete`, ARIA
  roles and WebAuthn, the recipe generated for its origin, or the AI's judgment.
- **What differs per site stays data.** The recipe generated and stored for an origin
  ([ADR 0013](0013-service-held-recipes-and-settings.md),
  [ADR 0018](0018-recipe-generation-route.md)), the owner's settings and the Bitwarden
  items are how Pateat adapts to a site; they are not site-specific features.
- **Strictly necessary** means a general rule cannot do it. Existing cases and any new
  one are reported to the owner.
- Site names in comments and documents as examples, in ADRs, the plan and research
  notes as dated evidence, and in tests and evaluation data are not behavior. Word lists
  per language, such as the English and Japanese passkey words in
  `packages/inference/src/plan.ts`, name no site.

## Consequences

On 2026-10-12 the existing code and records were checked against this rule. The owner
decided on the cases found (13:46 UTC):

- Kept as strictly necessary: the CAPTCHA frame hosts in
  `apps/extension/src/page/sign-in-state.ts` (reCAPTCHA, hCaptcha, Cloudflare
  Turnstile), which only their hosts tell apart, and the `google.com` and
  `script.google.com` exception in `packages/bitwarden/src/uri.ts` and the `steam://`
  TOTP keys in `packages/bitwarden/src/totp.ts`, which mirror the Bitwarden clients.
- Made general: [ADR 0026](0026-sign-in-through-identity-providers.md) no longer fixes
  Google and Microsoft origins or recognizes identity-provider pages by origin, path and
  heading, and the phase 4 item on GitHub's 2FA check page is now about optional
  confirmation pages after a login
  ([plan](../plan.md#phase-4-issues-and-work-as-needed)). Neither was implemented.
