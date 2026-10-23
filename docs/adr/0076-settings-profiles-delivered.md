# ADR 0076: Settings profiles, delivered

Status: accepted by the owner on 2026-10-23. The owner chose each point marked "owner"
below on 2026-10-19 and 2026-10-23; the rest follow the accepted
[ADR 0024](0024-settings-profiles.md) or were chosen by the implementation and are
marked so. Supersedes the temporary proposal that was ADR 0054 on the
[#664](https://github.com/risu729/pateat/pull/664) branch.

Date: 2026-10-23

## Context

[ADR 0024](0024-settings-profiles.md) split the settings document into profile parts and
owner parts and described profiles as later work. This change builds them for the parts
that exist today: `excludedSites` and `siteDefaults` are per profile, and `bindings`
stay the owner's. ADR 0023's lists and ADR 0035's page permissions are not built yet;
when they land, they add their fields to the profile document (`profileDocument` in
`services/api/src/settings-store.ts`) and to the extension's merge.

## Decision

### Storage and revision

- `profiles` holds each owner's profiles (`owner_id`, `id`, `name`, `document`,
  `deleted_at`); `devices.profile_id` names the profile each device uses; `settings`
  keeps the owner's `bindings` and the owner's one revision.
- One revision per owner covers every profile and the bindings (owner, Q3). A login
  saves a site default and a binding together, and a device moved to another profile
  must not have an in-flight write land in the old one, so moving a device also
  advances the revision.
- Migration `0029_settings_profiles` deletes every `settings` row instead of converting
  it (owner, Q8): the product has no release to keep. Each owner gets a profile named
  "Default" whose ID is the owner's ID, and every device uses it. The first device to
  sync uploads its settings again.

### Pairing

- An owner's first pairing creates the owner, a profile named "Default" and the device
  in one batch.
- A later pairing must name a profile: `POST /pair` without `profileId` or `newProfile`
  answers 409 `profile_required` with the owner's profiles, even when there is only one,
  so a reinstalled agent browser never takes the local browser's wider settings
  silently (ADR 0024).
- The extension's settings page then asks which profile the device uses, with a choice
  to create a new one named after the device by default (owner, Q4:
  「新しいプロファイルを 作成、とかもできるようにいて」). A new profile has no document
  until the device's first sync, which uploads the device's own exclusions and saved
  accounts into it (`newProfile: true` on `GET /v1/settings`).
- Choosing an existing profile replaces the device's exclusions and saved accounts with
  the profile's (owner, Q4: 「サービスのほうを使う」). When the device holds any, the
  page first shows a warning with their counts and three buttons: **Pair and replace**,
  **Create a new profile instead** and **Back** (owner, Q4: 「警告画面はいる」).
- Bindings belong to the owner, so they keep merging both ways when a device adopts a
  profile (implementation).

### Managing profiles

- `/manage/profiles` lists each profile with the devices that use it, renames it,
  creates one copied from another and deletes one (owner, Q5). Inheritance, where a
  profile follows another's later changes, stays out.
- Deleting is refused while any device that is not revoked uses the profile, and the
  refusal names those devices (owner, Q5); the owner's last profile cannot be deleted
  (implementation). A deleted profile is kept with `deleted_at` so revoked devices still
  name a row (implementation).
- Names follow device labels' rules and are unique per owner, ignoring case
  (implementation).
- The devices page moves a device to another profile; the Sites pages edit one profile
  at a time and show which only when there are several, remembering the choice for the
  browser tab (implementation).

### Editing another profile from the extension

- The extension's settings page can edit another profile with its own vault catalog
  (ADR 0024). Its requests go to `/extension/profiles`, behind the host-wide Access
  application (`ACCESS_AUD`), which requires WARP, and only from an extension the
  pairing allowlist names (owner, root A on 2026-10-19). The "pateat pair" application
  of [ADR 0030](0030-pairing-without-warp.md) is not accepted there, so a browser
  without WARP can pair but cannot edit other profiles. ADR 0030 is unchanged.
- When the sign-in is missing or expired, the editor shows **Open sign-in page**, which
  opens `/extension/signed-in` behind the same application.
- A device credential never selects or edits another profile.

## Consequences

- An agent browser can use its own exclusions and saved accounts while sharing the
  owner's bindings, recipes, Claude credentials and spending.
- Pairing a further device always takes one more choice.
- Existing service settings were deleted once by the migration; devices upload theirs
  again on their next sync.

## Alternatives

- Per-profile revisions plus a binding revision: a login's site default and binding
  would need two compare-and-set writes, which ADR 0024 already rejected.
- Keeping the device's entries when it takes an existing profile: the owner chose the
  profile's, with the warning and the new-profile choice instead.
- Editing other profiles under "pateat pair": it would let a browser without WARP
  change the policy other browsers use, which ADR 0030 does not allow.
