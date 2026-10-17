# ADR 0044: Settings profile delivery details

Status: temporary proposal by the implementation agent, not accepted by the owner.
Implements the already accepted profile behavior in [ADR 0024](0024-settings-profiles.md).
No new provider, library, deployment, or real-account operation is authorized here.

Date: 2026-10-17

## Context

The current main branch supports excluded sites, site defaults, and bindings.
The policy lists in ADR 0023 and page permissions in ADR 0035 have independent,
unmerged implementations. This change must preserve their ownership boundaries.

## Decision

Proposed implementation details, not owner-confirmed:

- One owner-wide revision serializes shared binding writes, profile writes, and
  device profile reassignment. Reassignment advances that revision so an in-flight
  write from a previous profile cannot replace the selected profile.
- The first pairing creates a profile named Default. Later profiles copy an
  explicitly selected existing profile. Names contain 1–64 printable characters.
- Profile creation and device selection are available on the owner management page.
  Profile deletion and inheritance are outside this implementation.
- Settings responses carry profile identity. Switching profiles replaces the
  device's profile fields from the service and resets the local merge base.
- Current profile storage includes the currently supported profile fields only.
  ADR 0023 and ADR 0035 integration must extend the explicit profile projection
  and the extension merge keys when those independent changes land.

## Consequences

Owner data, bindings, recipes, credentials and spending remain shared. Profiles
copy policy rather than inheriting later edits. No database compatibility layer
is retained for this unreleased product.

## Alternatives

Per-profile revisions plus a separate binding revision complicate the atomic
binding/site-default save already accepted in ADR 0024. Implicit profile choice
when several exist risks pairing an agent browser to broader local policy.
