# ADR 0058: Recipes that are not used or cannot run are removed automatically

Status: accepted by the owner on 2026-10-19. At 20:23 UTC the owner wrote
「金銭的なのは良くて、使わないレシピは勝手に消えるようにしたいがどうすべき？」 (cost is
fine; unused recipes should disappear on their own, how should that work?). On the
decision card 「使えないレシピや使われないレシピを、どう自動で消しますか?」 the owner
chose 「両方」 (both) at 20:28:59 UTC: a recipe the chosen item cannot run is revoked and
generated again at once, and a recipe not used for 90 days is revoked by the service.
Part B is implemented (local tests only). Part A waits for the first recipe kind that
can lack every route an item holds; see [Delivery](#delivery). Amends
[ADR 0013](0013-service-held-recipes-and-settings.md) (only the owner revoked recipes)
and [ADR 0016](0016-recipe-generation-trigger.md) (a page with a recipe is not
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

### B. A recipe not used for 90 days

The service revokes an active recipe that has not been used for 90 days.

- A recipe counts as used when the service writes a revision of it (generation, a
  continuation page, a judged handler or marker, or a device write) and when a device
  reports a login on it that ended, whatever its result
  ([ADR 0055](0055-login-records-sent-to-the-service.md)). The head's `last_used_at`
  holds the newest of these.
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
- An offline device keeps using its copy until it syncs, as after the owner's revoke.
- The owner's `/manage` revoke stays as it was.

## Delivery

Part B is implemented in the service (`last_used_at` on `recipe_heads`,
`RECIPE_IDLE_LIMIT_MS` in `services/api/src/limits.ts`).

Part A has nothing to act on yet: every login recipe on `main` has a `password` route,
and an item without a password but with a passkey already goes on to the passkey on that
route ([ADR 0036](0036-passkey-after-the-identifier.md)), so no item lacks every route
that generating the page again would give it. It lands with the first recipe kind that
can lack the `password` route, the passkey-only recipe of
[#663](https://github.com/risu729/pateat/pull/663), or right after it.

## Alternatives

- Revoke on a fixed age since creation, whether used or not: removes recipes in daily
  use and pays to generate them again.
- Count only signed-in logins as use: also revokes recipes that fail every time, which
  is repair's job.
- Delete the recipe rows instead of writing a tombstone: devices would never learn that
  the recipe is gone, since the change feed carries only heads.
