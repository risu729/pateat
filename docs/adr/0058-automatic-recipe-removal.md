# ADR 0058: Recipes that are not used or cannot run are removed automatically

Status: accepted by the owner on 2026-10-19. At 20:23 UTC the owner wrote
「金銭的なのは良くて、使わないレシピは勝手に消えるようにしたいがどうすべき？」 (cost is
fine; unused recipes should disappear on their own, how should that work?). On the
decision card 「使えないレシピや使われないレシピを、どう自動で消しますか?」 the owner
chose 「両方」 (both) at 20:28:59 UTC: a recipe the chosen item cannot run is revoked
and generated again at once, and a recipe not used for 90 days is revoked by the
service. Parts A and B are implemented (local tests only); see [Delivery](#delivery).
Amends [ADR 0013](0013-service-held-recipes-and-settings.md) (only the owner revoked
recipes) and [ADR 0016](0016-recipe-generation-trigger.md) (a page with a recipe is not
generated again).

Date: 2026-10-19

## Context

A recipe left the service only when the owner revoked it on `/manage`. Two kinds of
recipe stayed for good:

- A recipe whose site the owner no longer uses. It keeps its place under the 1,000
  active recipes and the 1.5 MiB of recipe bytes an owner may hold
  ([service limits](../architecture.md#service-limits)), and every device keeps a copy.
- A recipe the chosen vault item cannot run. Generation runs only on a path where no
  cached recipe starts ([ADR 0016](0016-recipe-generation-trigger.md)), so while such a
  recipe exists, nothing generates one the item can run. The owner's example: a recipe
  that only presses a passkey button, for an item that has since lost its passkey and
  has only a password. Automatic login stays stopped on that site until the owner
  revokes the recipe.

A revoked recipe is generated again on its first page as the revision after its
tombstone (owner, 2026-10-12; `services/api/src/recipes/generate.ts`), under the same
recipe ID, so the owner's saved bindings and site defaults still apply to it. One
generation costs about $0.007.

## Decision

### A. A recipe the chosen item cannot run

When a login is about to start and the chosen item can take none of the recipe's
routes, but would take a route a recipe for this page can have, the device revokes the
recipe and requests generation for the page in the same visit.

Claude's choices beyond the owner's answer, not confirmed by the owner:

- The trigger is read from the item's facts and the recipe's routes only, never from the
  site ([ADR 0033](0033-no-site-specific-features.md)). A new login's plan refuses for
  the item's facts: every `password` variant it tried lacked a value the item does not
  hold (the `no-route` refusal of [ADR 0027](0027-per-account-login-routes.md),
  including an item without a password that cannot take the stop of
  [ADR 0036](0036-passkey-after-the-identifier.md), and one without its TOTP secret),
  and no variant was refused for its binding or a field it names. And the item holds
  what a route the recipe lacks needs: a discoverable passkey, on a page the passkey
  scripts run on ([ADR 0050](0050-http-pages-for-http-items.md)), while the recipe has
  no passkey button; or a password, while the recipe has no `password` variant. A
  passkey that is not discoverable never counts.
- A device revokes a recipe this way at most once per recipe ID in 30 days for each
  paired service and device, recorded before the request leaves; a failed request that
  did not reach the service, was rate limited or was rejected frees it again, and so
  does a conflict with a newer active revision, which revoked nothing. A
  regenerated recipe keeps its ID, so this bounds a page whose new recipe the item still
  cannot run, and the service's own retry windows do not.
- Only generated recipes (`gen-` IDs, derived from the origin and start path) are
  revoked, since only they are generated again under the same ID, and only when the
  page may be sent for generation now.
- Only a new login of the tab's own top-level page, at the recipe's first step: never a
  frame, a resumed login, one after an account switch or asked after a logout, a
  chooser's list ([ADR 0028](0028-account-chooser-login-pages.md)) or a login that
  starts at a later step ([ADR 0049](0049-start-at-a-later-step.md)), and not while a
  login of the recipe runs or is watched in any tab.
- The device pulls recipes only after the revocation, not settings, so a settings write
  does not stop another tab's login. A revocation answered as a conflict, as when
  another device changed the recipe first, pulls recipes the same way.
- The recipe is revoked even if another item that matches the page could run it; the
  30-day bound limits what such an account loses.

### B. A recipe not used for 90 days

The service revokes an active recipe that has not been used for 90 days.

- A recipe counts as used when the service writes a revision of it (generation, a
  continuation page, a judged handler or marker, or a device write), when a device
  reports a login on it that ended, whatever its result
  ([ADR 0055](0055-login-records-sent-to-the-service.md)), and when a device starts a
  login on one of its revisions. A device sends the service that start, the recipe ID
  and revision only (`POST /v1/recipes/:recipeId/use`), so a login that sends no ADR
  0055 record still counts: a fill-only login, one that stops before the password a
  passkey item lacks ([ADR 0036](0036-passkey-after-the-identifier.md)), or one that
  ends `policy-changed`. The head's `last_used_at` holds the newest of these.
- The revocation is an ordinary tombstone write, as the owner's revoke on `/manage` is:
  devices drop their copy on their next sync, the place under the limits is freed, and
  the next visit to the page generates the recipe again under the same ID.
- The service checks for such recipes whenever a device syncs recipes and whenever the
  owner opens the recipe list on `/manage`, since routine releases do not apply cron
  triggers. A recipe used again between the check and the write is not revoked.

Claude's choices beyond the owner's answer, not confirmed by the owner:

- Any ended login counts as use, not only a signed-in one, so a recipe that keeps
  failing is left to repair ([#617](https://github.com/risu729/pateat/pull/617)) rather
  than revoked as unused.
- Use is a login that started, not only one that ended: a device tells the service when
  a login starts on a recipe revision, at most once an hour for each revision.
- Entry recipes ([ADR 0031](0031-sign-in-entry-pages.md)) are never revoked as unused.
  Pressing an entry sends the service nothing, so the service cannot tell an entry
  pressed every day from one never pressed.
- A login record arriving for a revision older than the head still counts as use of the
  recipe.
- Existing recipes start from the newest of their last write and their last reported
  login.
- One check revokes at most 50 recipes; the next sync revokes the rest.

## Consequences

- A site visited less often than every 90 days pays for one generation on its next
  visit and loses what the revoked recipe had learned (handlers, markers and
  continuation pages), which later logins learn again. Its bindings stay.
- A recipe sync that runs just as a login starts can revoke its recipe at about 90 days
  idle. That login's use report and records then get 404, and the next visit generates
  the recipe again.
- Part A can repeat on a page whose regenerated recipe the item still cannot run, as a
  page with no passkey button for an item that only has a passkey: each device then
  revokes and generates it again once every 30 days, and each round loses the learned
  handlers, markers and continuation pages, as above.
- A revocation under part A tells the service that the chosen item could not run the
  recipe, which hints at what the item lacks (its password, its TOTP secret or a
  passkey). It sends no value or fact by name, and the service is the owner's own.
- An offline device keeps using its copy until it syncs, as after the owner's revoke.
- The owner's `/manage` revoke stays as it was.

## Delivery

Part B is implemented in the service (`last_used_at` on `recipe_heads`,
`RECIPE_IDLE_LIMIT_MS` in `services/api/src/limits.ts`,
`POST /v1/recipes/:recipeId/use`) and in the extension, which sends a login's start
(`apps/extension/src/service/recipe-use.ts`).

Part A is implemented in the extension. The login runtime
(`apps/extension/src/login/runtime.ts`) marks the plan's refusal with the route the item
would take (`heldRouteMissing` in `packages/contracts/src/login.ts`), waits as for a
generation, and asks the worker's generation side
(`apps/extension/src/service/generation.ts`) to revoke the recipe. That side records the
revocation in `pateat.recipe-replacements.v1`, sends `PUT /v1/recipes/:recipeId` with
`state: "revoked"` and pulls recipes. Once the recipe cache no longer starts that
revision on the page, the document announces again and is offered for generation as a
page where no recipe starts ([ADR 0016](0016-recipe-generation-trigger.md)); otherwise
it is refused as before. Each revocation logs `recipe.revoke`. On `main` this covers an
item with a discoverable passkey and no usable password, or without its TOTP secret, on
a recipe without a passkey button. The owner's example, a recipe that only presses a
passkey button for an item with only a password, needs the passkey-only recipe of
[#663](https://github.com/risu729/pateat/pull/663), which the same check covers. A page
whose document was already offered for generation once is generated only on its next
visit.

## Alternatives

- Revoke on a fixed age since creation, whether used or not: removes recipes in daily
  use and pays to generate them again.
- Count only signed-in logins as use: also revokes recipes that fail every time, which
  is repair's job.
- Delete the recipe rows instead of writing a tombstone: devices would never learn that
  the recipe is gone, since the change feed carries only heads.
