# ADR 0040: Running without the service

Status: proposed — Claude's design, pending the owner's approval. Implemented in the PR
that adds this record, before approval, because the owner asked on 2026-10-15 at 11:06
UTC to implement plan items with a chosen design and ask afterwards, and at 11:10 UTC:
「設計が複雑で聞いたほうがいいのは、とりあえず実装してこうしたがいいか？と後でプルリク出してから確認をして」.
Nothing below is confirmed by the owner. Amends
[ADR 0013](0013-service-held-recipes-and-settings.md) once accepted.

Date: 2026-10-15

## Context

[ADR 0013](0013-service-held-recipes-and-settings.md) makes the owner's sync service the
source of truth for settings, recipes and account bindings, and says that running
without the service is later scope that designs must not rule out. The
[plan](../plan.md#phase-3-public-release) puts a mode without the service in phase 3,
before Pateat is public: anyone may install the extension, but the service is not opened
to other people, so a user without their own service needs Pateat to work alone.

Before this record, an extension with no paired device already kept its settings: the
settings store lives in `storage.local`, the settings page and the toolbar popup edit
it, and settings sync only merges it with the service's copy. Recipes were different:
the executor read only the paired device's synced cache, so with no device paired no
recipe existed and no login ran. Recipe generation and the completion judge (ADR 0014,
ADR 0018) run on the service with the owner's Claude credentials.

## Decision

### The mode is having no paired device

Pateat runs without the service whenever no device is paired. There is no separate
switch: pairing a device turns the service on, and disconnecting turns it off. A pairing
record that cannot be read still serves no recipes, as before.

### Settings stay on the device

Settings need no change: they are stored and edited on the device whether or not a
service is paired. Pairing later merges them with the service's settings as settings
sync already does without an agreed base: both sides' entries are kept, and the
service's wins where they differ.

### Recipes are kept on the device and come from a file

With no device paired, logins use the recipes kept on the device
(`pateat.local-recipes.v1` in trusted `storage.local`). The executor looks them up in
the same way as the synced cache: the same selector, start lists and entry and chooser
recipes. While a device is paired, logins use only the synced cache, as before.

Recipes reach the device as a recipe file, which the settings page's new **Recipes**
section imports:

```json
{ "format": "pateat-recipes", "version": 1, "recipes": [{ "version": 1, "id": "…" }] }
```

Each recipe must pass the same schema as a synced recipe, and a file whose recipes do
not all pass, or that repeats an ID, imports nothing. An imported recipe whose ID is
already kept replaces it only at a higher revision, so a login that resumes on a
revision never finds other content under it; the same revision with other content, or an
older one, is skipped and counted. The kept recipes have a 2 MiB limit of their
own, the same as the synced cache's; an import that would pass it imports nothing. While
recipes wait for an upload after pairing, both may be held, up to 4 MiB of the
extension's 10 MB `storage.local` quota. Recipes kept on the device can be
removed one by one. A recipe file holds recipes only: never bindings, item or account
IDs or field values. Imported recipes are untrusted input like shared recipes
([ADR 0013](0013-service-held-recipes-and-settings.md#fill-restrictions)): the fill
restrictions and the provider URI match apply to them unchanged.

**Export recipes** saves the recipes logins use now as such a file: those kept on the
device, or, while a device is paired, the synced cache. That is how recipes move from a
service to a device without one, and between devices without a service.

### No recipe generation without the service

Without a paired device, Pateat generates no recipes and judges no completions: the
extension holds no Claude or other AI credentials, and makes no request other than to
the vault and the sites it logs in to. A page without a recipe is not logged in to, as
on a paired device whose generation is off. No judge adds signed-in markers; a recipe's
own markers, such as those an exported recipe carries, and the local sign-in state of
[ADR 0029](0029-local-sign-in-state.md) still complete a login. Calling an AI provider
directly from the extension stays later scope; the
[plan](../plan.md#decisions-still-requiring-evidence) requires trusted key storage for
it first.

### Bindings

The automatic binding of ADR 0013 (slots named `username`, `password` and `totp`) works
without the service, and is saved after the first `authenticated` login as on a paired
device. Bindings for other slots are kept in the device's settings from an earlier
pairing, since disconnecting keeps settings; without one, a recipe with other slots does
not log in. There is no binding editor on the device yet.

### Pairing uploads the kept recipes once

The first full sync after pairing uploads each recipe kept on the device before it pulls
recipes, with `PUT /v1/recipes/:recipeId` and the device's credential, as a new recipe
at revision 1 (`expectedRevision: 0`; a chooser's branches take the same revision). A
recipe the service accepted, or already holds under that ID (`recipe_conflict`, also a
revoked one), is removed from the device; the service's copy wins. A recipe the service
refuses with another client error (such as `400`, `405` for the reserved ID `generate`
or `413` for a recipe over the service's 128 KiB body limit) stays and is tried again on
later syncs, and the upload goes on with the next one. The service's recipe limit, a
`429`, an unreachable service or a server error stops the upload, and the rest waits for
the next full sync; a `401` marks the device rejected. A device disconnected while the
upload runs forgets none of its recipes, and a recipe imported under an uploaded ID
meanwhile stays. While recipes wait, the **Recipes** section says how many, says to pair
again when the service rejects the device, and offers to discard them. Without a
pairing, the section says that pairing later uploads the recipes. Importing and removing
recipes on the device waits until it is disconnected again; export still works.

Disconnecting clears the synced cache as before, so a device that leaves its service has
no recipes until the user imports a file, such as one exported before disconnecting.

## Consequences

- A device without a service logs in only to sites whose recipes the user imports; with
  no generation, recipes come from an export of a service or from someone else's file.
- The settings page gains a **Recipes** section and the background a `recipes.*`
  message area for the settings page only.
- Pairing sends the device's kept recipes to the service, which already holds recipes
  for every paired device; nothing else leaves the device without a pairing.
- Recipes waiting for an upload after pairing are not used for logins until the service
  has them.

## Alternatives

- An explicit "without the service" setting next to the pairing, instead of the
  pairing's absence: one more state to keep consistent with the pairing record, and a
  paired device could then ignore its service.
- Keeping the synced cache as the device's recipes when disconnecting: logins would keep
  working after a disconnect, but recipes of an earlier owner's service would stay on a
  device that left it; export and import do the same on purpose.
- Using kept recipes together with the synced cache while paired, instead of uploading
  them: two sources of truth, and a login could start from a recipe the service never
  saw.
- Discarding the kept recipes on pairing, or keeping them only on the device: simpler,
  but a user who starts without a service and pairs later would lose their recipes or
  have to import them on the service by hand.
- Recipe generation from the extension with the user's own AI key: needs trusted key
  storage and provider tests the plan requires first, and the key would sit next to the
  vault cache.
- A binding editor on the settings page: needed for recipes with custom slots on a
  device that never had a service; left for a later change.
- Storing recipes in `storage.sync` or the vault: rejected in ADR 0013 for size limits
  and vault writes.
