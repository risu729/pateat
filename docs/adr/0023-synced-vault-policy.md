# ADR 0023: Synced item selection, field exclusions and custom-field review

Status: accepted by the owner on 2026-10-11 (12:02 and 12:15 UTC). Amends
[ADR 0013](0013-service-held-recipes-and-settings.md) (resolves its open item on
settings that use device-local IDs, and keeps their editing in the extension) and
[ADR 0021](0021-account-choice-outside-settings.md) (the popup may also repair one
binding). Not implemented yet.

Date: 2026-10-11

## Context

ADR 0013 left open how settings that use device-local IDs are converted to synced form,
and where custom-field review happens. Each device keeps one `connections[]` entry per
vault connection:

```json
{
  "connectionId": "7d0f3c1e-…",
  "enabled": true,
  "selection": { "mode": "selected", "groupIds": ["<folder UUID>"], "itemIds": ["<item UUID>"] },
  "excludedItemIds": ["<item UUID>"],
  "excludedFields": [
    { "itemId": "<item UUID>", "fieldId": "login.password" },
    { "itemId": "<item UUID>", "fieldId": "custom.<snapshotId>.2" }
  ]
}
```

`connectionId` is random per device, and a custom field ID changes with every vault
sync. Folder, collection and item IDs and built-in field IDs (`login.password`,
`card.number`, …) are the provider's and are the same everywhere. None of this is
synced today, so a reinstall or another device starts with every item allowed.

Custom-field review is device-local too. When an item that has custom-field exclusions
changes, `fieldPolicies[].quarantinedItemIds` blocks it until the settings page saves a
review, which starts with every current custom field excluded.

## Decision

### Synced shape

The settings document gains two lists, so that a merge works per account and per item:

```json
"accountPolicies": [
  {
    "provider": "bitwarden",
    "server": "cloud-us",
    "userId": "00000000-0000-4000-8000-000000000001",
    "accountName": "Personal",
    "enabled": true,
    "selection": { "mode": "selected", "groups": [{ "id": "<folder UUID>", "name": "Banking" }] }
  }
],
"itemPolicies": [
  {
    "provider": "bitwarden",
    "server": "cloud-us",
    "userId": "00000000-0000-4000-8000-000000000001",
    "itemId": "<item UUID>",
    "itemName": "Example Bank",
    "selected": true,
    "excluded": false,
    "excludedFields": [
      "login.password",
      { "custom": "PIN", "position": 2, "count": 2 },
      { "custom": null, "position": 1, "count": 1 }
    ]
  }
]
```

- Keys are `provider` + `server` + `userId` for an account and the same plus `itemId`
  for an item. The existing three-way settings merge uses them; a whole entry wins.
- `server` is `"cloud-us"`, `"cloud-eu"` or a self-hosted server's normalized origin
  (`normalizeBitwardenProfile`'s `url.origin`), because a self-hosted server can return
  any user ID. It is also added to catalog connections, to the account reference of
  `bindings` and `siteDefaults`, and to the binding merge key; site defaults stay keyed
  by origin. A connection whose `provider` and `userId` match an entry but whose
  `server` differs is refused like `account-ambiguous`, so its exclusions are never
  silently dropped. Self-hosted server origins are therefore stored on the service.
- The same account connected twice on one device is refused as `account-ambiguous`, as
  for site defaults. A locked connection whose `userId` is unknown stays
  `vault-unavailable`.
- `enabled` is synced in `accountPolicies`; an account with no entry is not used, as a
  new connection is disabled today. Disabled connections stay unlocked and can be synced
  by hand, but are not used for login or passkeys and are left out of automatic vault
  sync. A device that should differ will use another settings profile, which the owner
  asked to design for (recorded separately).
- Built-in fields keep their IDs. A custom field is named like a binding reference, by
  name with `position` (from 1) and `count` among fields of that name, but it is a
  separate type: `count` may be 1, and unnamed fields (catalog `name: null`, including
  names over 200 characters) form the group `custom: null`.
- A reference that no longer resolves (name gone, `count` changed, a name without
  `position` now ambiguous) blocks the item until it is reviewed; an exclusion never
  silently stops applying.
- Names (`accountName`, `groups[].name`, `itemName`) are for display only.
- Local `connections[]` keeps only `connectionId`, plus `enabled` for the unsynced
  `dummy` provider of the preview and probe builds. The device applies the synced lists
  to its live catalog at each eligibility check, as bindings are resolved today.
  `fieldPolicies` is removed.
- Limits: 100 `accountPolicies`, 1,000 `itemPolicies` and 1,000 `customFieldReviews`, 50
  `excludedFields` per item, within the existing 120 KiB document limit. Items without a
  selection, exclusion or review are not listed. The `dummy` provider is not synced.

### First settings sync

A paired device records whether a settings sync has completed since pairing and does not
use any vault item, for login or passkey assertions, until one has. This covers a
reinstall that connects its vault before or after pairing. A sync whose merge does not
fit is not a completed sync, and a device rejected with 401 stays blocked. A device that
was never paired is unaffected.

### Editing and trust

Item selection, field exclusions and custom-field review are edited on the extension's
settings page, because only devices have the item and field lists. This extends ADR
0021's amendment of ADR 0013 (site defaults and site exclusions in the settings page and
popup) to these settings. The owner web UI first only lists them.

Settings from the service may remove exclusions or widen the selection, as they already
may for `excludedSites`. The owner accepted this for now; requiring each device to
approve loosening changes, possibly in bulk, is later work.

### Custom-field review

Review state is synced per item:

```json
"customFieldReviews": [
  {
    "provider": "bitwarden",
    "server": "cloud-us",
    "userId": "00000000-0000-4000-8000-000000000001",
    "itemId": "<item UUID>",
    "evidence": "bitwarden-v1:sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "revisionDate": "2026-10-11T07:10:03.1234567Z"
  }
]
```

- `evidence` is the SHA-256 of the encrypted custom-field evidence the device already
  compares (`customEvidence`: the cipher's sealed `data` or encrypted `fields`, its
  `key` and `organizationId`), serialized in a fixed order. The `bitwarden-v1:` prefix
  names the provider and that serialization, so another provider or a later format uses
  its own prefix. Pateat passes the server's ciphertext through unchanged, so every
  device computes the same value for the same item revision. Only this hash reaches the
  service, never names or values.
- `revisionDate` is the cipher's raw `revisionDate`, compared as an instant.
- An item with custom-field exclusions (or a review record) is usable when its current
  evidence matches. Otherwise:
  - if the local `revisionDate` is strictly older than the record, the device's vault is
    stale: the item stays blocked and the settings page asks for a vault sync instead of
    a review. If it is still older right after a vault sync, review is offered;
  - otherwise the item waits for review.
- When the evidence changed but the custom fields themselves did not (Bitwarden
  re-encrypts the whole item on every save), the device compares the old and new
  decrypted custom fields inside the crypto host and, if they are equal, writes the new
  evidence as reviewed without asking. This also covers a Bitwarden key rotation, which
  changes the evidence of every item. That comparison belongs to the automatic vault
  sync design; a device without the old snapshot relies on the synced record.
- Adding the first custom-field exclusion records the current evidence. A review starts
  with every current custom field excluded, as today.
- An item waiting for review is reported on the settings page and in the toolbar popup.
  A review made on one device takes effect on another at that device's next settings
  sync, so its first login there may still be refused.
- Records are not deleted because an item is missing locally, since a stale vault cannot
  tell a new item from a deleted one.
- Reviews from different devices merge per item; when two devices change the same item
  at once the service's copy wins, as for other entries.
- The service can mark an item reviewed, as it can remove an exclusion (see above).

### Binding review

Bindings that name custom fields are not generated yet; this sets their review now so
that it lands later as a small change.

- A binding reference that does not resolve (`field-missing`, `field-count-changed`,
  `field-ambiguous`) stops the login before any fill, as today. These reasons stay
  distinct. `binding-slots-mismatch` means the recipe changed and is not reviewed here.
- The stopped document is recorded as in ADR 0021 B (`{tabId, frameId, documentId,
  origin}`), the toolbar icon gets a badge, and the popup offers the item's fields that
  can fill that slot's input on the recorded document: not excluded, referenceable by
  name, and allowed by the existing fill rules. Only field names are shown.
- The choice is kept in `chrome.storage.session` for that document and the document is
  reconnected. The binding's slot is rewritten (for example
  `{ "custom": "PIN", "position": 3, "count": 3 }`) and synced only after the outcome is
  `authenticated`. This is the one edit the popup makes beyond ADR 0021 A.
- Asking Claude to remap from field names is a later option.

## Alternatives

- Keep these settings device-local: a reinstall or another device loses them.
- Sync only item-level exclusions: no way to exclude one field such as a PIN.
- Review when the ordered list of custom-field names changes: misses value moves between
  fields and changes to unnamed fields, and would upload every custom-field name.
- Keep review per device: every device, and every reinstall, would review again.
- Review in the owner web UI: devices would have to upload all custom-field names of
  blocked items.

## Consequences

- ADR 0013's open item on device-local IDs and custom-field review is resolved here.
- The service learns which items have selections or exclusions (by ID and display name),
  a hash of their encrypted custom fields, and self-hosted server origins.
- `bindings` and `siteDefaults` gain `server`; with no stored data to keep before
  release, nothing is migrated.
