# ADR 0024: Settings profiles

Status: accepted by the owner on 2026-10-11 (12:15 UTC). Extends
[ADR 0013](0013-service-held-recipes-and-settings.md) and
[ADR 0023](0023-synced-vault-policy.md). Only the data split below applies now; profiles
themselves are later work. Amended on 2026-10-12 by
[ADR 0035](0035-page-kinds-per-site.md) (not implemented): `pagePermissionDefaults` and
`sitePagePermissions` are profile parts. Amended on 2026-10-23: profiles are built for
the parts that exist; see the amendment at the end.

Date: 2026-10-11

## Context

The service keeps one settings document per owner (the `settings` table, keyed by
`owner_id`), and every paired device uses it. The owner wants one Access owner to be
able to use different settings on different browsers. For example, the local Chrome logs
in everywhere except financial sites, while remote AI-agent browsers (ChatGPT or Grok
agents, cloud sessions) also leave out unrelated sites such as `pixiv.net`. Cloud
browsers reinstall the extension often, so these settings must be synced and chosen per
device. One profile is enough at first, but the design must allow more.

## Decision

### Now: one profile, with the data split decided

No profile feature is built yet. The settings document stays one document, but its parts
are assigned now so that profiles can be added without moving data again:

| Data                                                       | Belongs to        |
| ---------------------------------------------------------- | ----------------- |
| `excludedSites`                                            | profile           |
| `siteDefaults`                                             | profile           |
| `accountPolicies`, including `enabled` (ADR 0023)          | profile           |
| `itemPolicies` (ADR 0023)                                  | profile           |
| `customFieldReviews` (ADR 0023)                            | profile           |
| `pagePermissionDefaults`, `sitePagePermissions` (ADR 0035) | profile           |
| `bindings`                                                 | owner (shared)    |
| Recipes, Claude credentials, spending and generation state | owner (unchanged) |

- A binding states which vault field fills a recipe slot for one item; that does not
  depend on how a browser is used.
- A custom-field review approves an item's current fields under one profile's
  exclusions. If reviews were shared, a field reviewed and excluded in one profile would
  become usable without review in another that does not exclude it. Each profile
  therefore reviews once.
- A site default can differ, for example when an agent browser uses another account.

### Later: adding profiles

- The service adds `profiles` (`owner_id`, `profile_id`, `name`), stores the profile
  parts per `(owner_id, profile_id)` and keeps `bindings` in `settings`. `devices` gains
  `profile_id`.
- A device's profile is chosen on the service, never by `/v1/*` request bodies, which
  keep selecting nothing (as they never select an owner). It is set at pairing, where
  `POST /pair` ([ADR 0020](0020-direct-device-pairing.md)) may name a `profileId` that
  the service checks against the Access owner, and on the web UI's devices page. When
  more than one profile exists, pairing must choose one; a silent default could run a
  reinstalled agent browser with the local browser's wider settings.
- `GET /v1/settings` keeps its shape: it returns the device's profile parts with
  `bindings` and adds `profileId`. One revision covers both, because a login saves a
  site default and a binding together. When `profileId` changes, the extension discards
  its merge base (`pateat.sync-settings.v1`) so the old profile's values do not
  overwrite the new one.
- The extension's settings page can choose which profile it edits, using the device's
  own vault catalog, so agent browsers whose pages are hard to open need not edit their
  own.
- A new profile starts as a copy of an existing one. Inheritance, where a profile
  follows later changes of another, is decided separately if needed.

## Consequences

- ADR 0023's lists and `customFieldReviews` are profile data from the start.
- Adding profiles later needs a migration of the service tables and a pairing choice,
  but no change to the settings document's entries.

## Amendment, 2026-10-23

Profiles are built for `excludedSites` and `siteDefaults`, with `bindings` shared, as
"Later: adding profiles" describes; [ADR 0076](0076-settings-profiles-delivered.md)
records how, and the owner's choices made while building them. Two points differ from
the text above: a pairing must choose a profile even when the owner has only one, and
`devices.profile_id` refers to profiles that are deleted softly. ADR 0023's lists and
ADR 0035's page permissions are still to be built; they become profile parts when they
are.
