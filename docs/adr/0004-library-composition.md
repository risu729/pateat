# ADR 0004: Compose maintained libraries around explicit domain boundaries

Status: application libraries selected; additional verification tools and
protocol-specific crypto choices pending. PR unmerged.

Date: 2026-10-10

## Context

The foundation uses plain TypeScript UI, native messages/storage and a health-only
Worker. The original dependency policy discouraged UI, state-machine, ORM and AI
libraries until additional complexity appeared. The owner clarified that initial
delivery is not a reason to minimize dependencies. Settings forms, asynchronous
state, cancellable login attempts and private revisioned sync already have
concrete needs for established infrastructure.

## Proposal and decision gate

The owner rejected minimizing dependencies merely because development is early.
Evaluate candidates by maintainability and the complexity they handle. The
recommendations and integration conditions in [development](../development.md)
distinguish approved choices from pending candidates. Research or a request to
update the plan is not approval to adopt a candidate. Implementation PRs may
introduce only approved choices; approval of one does not approve the remainder.

The owner approved React, Tailwind + Base UI + selected shadcn/ui components, TanStack
Form + Valibot, TanStack Query, XState, `@webext-core/messaging`, WXT storage,
Hono, Drizzle and AI SDK with Valibot on 2026-10-10. The owner delegated OTP/PSL
selection by maintenance and freshness; choose OTPAuth and tldts on that basis. Keep
React in human-operated extension pages and preserve the settings operation contracts
and draft/conflict behavior.

The owner selected XState after comparing it with a custom TypeScript state
machine. Login policy, interruption recovery and duplicate-submit prevention
remain application responsibilities. WXT storage and Hono/Drizzle were separately
approved; their convenience APIs do not replace trusted-context restrictions,
revision checks or owner authorization.

Keep Valibot application contracts and the existing Vitest/Playwright test layers.
Additional browser component, accessibility, property-based and unused-code tools
remain candidates awaiting the owner. Native APIs remain appropriate primitives;
they are not a reason to recreate useful higher-level infrastructure.

### Delegated OTP and public-suffix selection

Reviewed official repositories/releases and npm metadata on 2026-10-10. All four
repositories were unarchived. Release dates below are UTC; version pins will be
rechecked in the implementation PR rather than installed by this document.

| Candidate | Latest stable release | Published (UTC) | Decision evidence |
| --- | --- | --- | --- |
| [OTPAuth](https://github.com/hectorm/otpauth/releases) | 9.5.2 | 2026-09-03 | Maintained dependencies and browser support; selected |
| [otplib](https://github.com/yeojz/otplib/releases) | 13.5.0 | 2026-08-21 | Also actively maintained; a valid alternative, not obsolete |
| [tldts](https://github.com/remusao/tldts/releases) | 7.4.18 | 2026-10-07 | Continuing releases and explicit public/private suffix handling; selected |
| [psl](https://github.com/lupomontero/psl/releases) | 1.15.0 | 2024-12-02 | Substantially older published data/package than tldts |

OTPAuth's stable release is newer, while otplib has more recent default-branch
work. Neither date alone establishes quality. Choose OTPAuth for the required
browser TOTP/URI interface with current dependency maintenance; do not claim
otplib is abandoned or less secure. Choose tldts for its continuing published
updates and explicit suffix policy. These are library-selection findings, not
Bitwarden/Steam/MV3 compatibility proof or a security audit. Preserve those tests.

Independent feature implementation means owning permission policy, vault protocol
compatibility, login semantics, recovery and output validation. It does not mean
writing a state-machine engine, form framework, SQL builder or crypto primitive.
Choose additional crypto/encoding dependencies after identifying protocol gaps.
Libraries must not broaden permissions, expose secrets or automatically replay
side effects after retries or restoration.

The approved AI SDK handles compatible generation transport and structured output.
Specialized finite-choice APIs keep direct adapters if SDK abstractions lose their
semantics. Provider evaluation stays in [ADR 0003](0003-service-and-ai.md) and a
separate PR. No agent loop, automatic fallback or additional hosted infrastructure is
implied.

## Alternatives and consequences

Continuing native-only form/async/lifecycle code avoids migration but leaves us
maintaining known infrastructure. React Hook Form is a credible Valibot-compatible
alternative; TanStack Form offers native Standard Schema support and typed composition.
The owner chose TanStack Form. Base UI plus selected shadcn/ui source
fits Tailwind and accessible settings controls, but copied components require our own
maintenance. Redux/Zustand or another overlapping form/query layer is not needed without
a distinct state ownership problem.

Adoption would add dependency upgrades and bundle costs. Review maintenance, licenses
and runtime compatibility, pin the tested combination and let Renovate propose updates.
Beta/RC versions are eligible, not mandatory. Library popularity or successful
compilation does not establish security or extension compatibility. Existing revision,
trusted-storage and draft-retention behavior must survive migration. Recovery tests must
demonstrate that restored attempts observe before resubmitting. This documentation does
not claim any new library is installed.

## Primary sources reviewed

- [WXT React integration](https://wxt.dev/guide/essentials/frontend-frameworks),
  [storage](https://wxt.dev/storage.html) and
  [messaging](https://wxt.dev/guide/essentials/messaging.html).
- [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite),
  [Base UI](https://base-ui.com/react/overview/about) and
  [shadcn/ui Base UI components](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default).
- [TanStack Form validation](https://tanstack.com/form/latest/docs/framework/react/guides/validation),
  [React Hook Form resolvers](https://github.com/react-hook-form/resolvers) and
  [TanStack Query defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults).
- [XState persistence](https://stately.ai/docs/persistence): restored invocations
  restart; state-machine persistence is not an exactly-once execution guarantee.
- [tldts](https://github.com/remusao/tldts),
  [OTPAuth](https://github.com/hectorm/otpauth),
  [scure-base](https://github.com/paulmillr/scure-base),
  [noble-hashes](https://github.com/paulmillr/noble-hashes) and
  [cbor-x](https://github.com/kriszyp/cbor-x).
- [Hono validation](https://hono.dev/docs/guides/validation),
  [Drizzle D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1) and
  [Valibot integration](https://orm.drizzle.team/docs/valibot).
- [AI SDK Valibot support](https://ai-sdk.dev/docs/reference/ai-sdk-core/valibot-schema),
  [retry/settings](https://ai-sdk.dev/docs/ai-sdk-core/settings) and
  [telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry).
- [Vitest browser components](https://vitest.dev/guide/browser/component-testing),
  [Playwright accessibility](https://playwright.dev/docs/accessibility-testing),
  [fast-check](https://fast-check.dev/docs/introduction/),
  [Oxlint plugins](https://oxc.rs/docs/guide/usage/linter/plugins.html) and
  [Knip production analysis](https://knip.dev/features/production-mode).
