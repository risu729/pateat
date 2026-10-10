# ADR 0013: Service-held recipes, settings and account bindings

Status: accepted by the owner on 2026-10-10. Amends the local-first statements in
[ADR 0001](0001-local-login-boundary.md), [ADR 0003](0003-service-and-ai.md) and
[ADR 0009](0009-install-time-https-site-access.md). The binding format below is the
current contract in `packages/contracts`. `/v1/settings` stores it as part of the
settings document, but the executor does not use it yet (see the [plan](../plan.md)).

Date: 2026-10-10

## Context

Login needs saved recipes and, per account, a mapping from recipe slots to vault
fields. The owner requires that this data survive an extension reinstall and be
shared across machines. The service is per owner but must support several owners.

## Decision

### Source of truth

The owner-scoped sync service is the source of truth for settings, recipes and
account bindings. The extension keeps only a last-known-good cache of what it last
synced. Login keeps working from that cache while the service is offline, and a
reinstalled extension restores the data by syncing again. Vault keys and unlock
material, provider sessions and the device's service credential stay device-local.

Settings, recipes and bindings are edited on the service's owner-authenticated web UI
(initially behind Cloudflare Access). The extension's settings page is deferred. The
extension keeps only the pages that handle local secrets: vault connection,
re-authentication and unlock, and service pairing.

Running without the service, including direct AI calls from the extension, is later
scope. Designs must not rule it out.

### Device-independent references

Synced data refers to vault items by provider account ID and item ID, which are the same
on every device. This applies to account bindings and site defaults. Custom fields are
referenced by name, because the current local IDs (`custom.<snapshotId>.<index>`) differ
per device and per sync. When several custom fields share a name, the reference also
stores its position among them and how many there are; if that count changes, the
binding is not used until it is reviewed again. Swapping two same-name fields in the
vault keeps the count, so the binding then fills the other field; this is a known
limitation. Item and field names are stored for display and logging. Still open: how the
other synced settings that use local IDs today, such as field exclusions, are converted,
and where custom-field review happens and keeps its state now that the extension page no
longer edits settings.

### Recipes and account bindings

A recipe holds only site structure: origin, step paths, element locators, slots and
completion conditions. Recipes can be shared between users later. An account binding
belongs to one owner, one recipe and one vault item, and is never shared. Bindings are
stored in the synced settings document next to the site defaults:

```json
{
  "recipeId": "example-bank-signin",
  "origin": "https://bank.example",
  "provider": "bitwarden",
  "userId": "00000000-0000-4000-8000-000000000001",
  "itemId": "00000000-0000-4000-8000-000000000002",
  "itemName": "Example Bank",
  "slots": [
    { "slot": "branch", "field": { "custom": "Branch number" } },
    { "slot": "pin", "field": { "custom": "PIN", "position": 1, "count": 2 } },
    { "slot": "password", "field": "password" }
  ]
}
```

AI generation is the main way to create recipes and bindings. The AI receives the
names of the fields allowed for automatic fill (with positions for duplicate names),
never values, item IDs or account IDs, and returns a slot-to-field mapping in the
same form. The service or extension combines that
mapping with the selected item to form the binding. The web UI therefore needs no
item or field picker.

A saved account choice selects the item. Without one, when the provider URI match
finds exactly one eligible item, the attempt uses that item, and the choice is saved
only after the outcome is `authenticated`. Nothing is saved on `credential-rejected` or
an unknown outcome. A saved choice wins even if more items match later; deleting it
restores automatic choice. Two or more matches still need a manual choice. Until AI
generation maps slots, an automatic choice binds only the slots named `username`,
`password` and `totp` to the item's login username, password and TOTP; a recipe with
any other slot needs a manual binding. Until AI
generation exists, development writes recipes through the existing `/v1/recipes` API
and bindings through `/v1/settings`, both with a
paired device credential.

### Recipe lookup

Lookup returns every cached recipe for the document's origin. A separate selector
picks the recipe and the step a new attempt starts on. For now it allows only a
recipe's first step and refuses when more than one recipe starts on the page, so a
site that goes straight to its password page does not start an attempt. On-screen
step detection can replace the selector later without changing the stored format.

### Fill restrictions

The executor enforces these regardless of where a recipe came from:

- The login password fills only `type=password` or `autocomplete=current-password`
  inputs. Whether Hidden custom fields, and Linked fields that resolve to the
  password, follow the same rule is still open; the recommendation is yes for both.
- TOTP fills only `autocomplete=one-time-code` or short numeric inputs; the length
  limit is set at implementation.
- All fills of one step share one form owner, or all have none.

There is no per-binding exception. A bank PIN input with `type=tel` therefore cannot
receive the vault password; this is a known limitation to revisit if such failures
are common. The provider URI match still gates every origin, following the official
clients with the differences recorded in the [architecture](../architecture.md).

When recipe sharing is built, a shared recipe is untrusted input. It is imported
without approval, and the fill restrictions above still apply. Recipes are checked
for personal data, such as user IDs in paths, before they are shared.

## Alternatives

- Putting vault field names, or a selector-to-field map, directly in the recipe
  instead of slots (owner kept slots on 2026-10-10): the recipe could not be shared,
  because field names are per user, and it would expose the owner's vault naming. Two
  accounts on one site with differently named fields would need two copies of the
  recipe, and a recipe revision with new selectors would invalidate every binding.
  With slots, a revision keeps bindings valid while slot names are unchanged.
- Extension-local storage as the source of truth: `storage.local` is cleared on
  uninstall and is not shared across machines.
- `storage.sync`: the
  [Chrome documentation](https://developer.chrome.com/docs/extensions/reference/api/storage)
  (checked 2026-10-10) limits it to 102,400 bytes and 8,192 bytes per item, and a
  [developer report](https://habr.com/en/articles/993286) says it is also cleared
  on uninstall.
- Storing settings and recipes in the vault: needs vault write support, which is
  later scope, and ties the data to one provider.

## Consequences

Real logins depend on a deployed service, device pairing and the extension sync client,
and provisioning the service needs the owner's approval. The service now holds provider
account IDs and item and field names, in addition to the site origins it already held
through site defaults and recipes. A device the service rejects with a 401 keeps using
its cached recipes but receives no further changes, revocations included, until it is
disconnected and paired again; disconnecting clears the cache. A device whose cache
is full keeps using the recipes it has in the same way until recipes are removed on the
service.
