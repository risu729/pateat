# ADR 0040: A device's own Anthropic API key, and running without the service

Status: accepted by the owner on 2026-10-23. The owner decided that the extension calls
the model itself from the device (12:38 UTC: without a model, logins on new pages simply
do not run, and there is no editor for recipes or bindings), that a device may keep its
key while the service is only used for sharing (12:51 UTC: "a third party would never
want to put their key on my service"), that files can export and import everything
pairing shares (12:49 UTC), and, on cards between 12:36 and 13:04 UTC, the upload rule,
the key field, the spend stops, the log rows and the choice on unpairing below. The
details marked "chosen by an agent" were not asked. The
[paired part](#a-paired-device-with-its-own-key), the
[recipes a device keeps](#recipes-a-device-keeps) and
[generation on an unpaired device](#generation-on-an-unpaired-device) and
[export and import](#export-and-import) are implemented. On a card at 21:11
UTC the owner decided to build generation on an unpaired device and to settle the Chrome
Web Store question when the extension is submitted. Amends
[ADR 0012](0012-inference-request-log.md),
[ADR 0014](0014-claude-generation-provider.md) and
[ADR 0015](0015-per-owner-claude-credentials.md).

Date: 2026-10-23

## Context

Until now every recipe came from the service: the extension sends the page it sees, and
the service calls Claude with the owner's credential
([ADR 0015](0015-per-owner-claude-credentials.md)) and stores the recipe
([ADR 0013](0013-service-held-recipes-and-settings.md)). A person who does not run a
service, or who uses someone else's only to share recipes and settings between their
devices, had no way to make recipes. The first attempt,
[#613](https://github.com/risu729/pateat/pull/613), imported recipe files only and was
written before recipes held layouts ([ADR 0060](0060-recipe-layouts.md)).

## Decision

Whether a device holds its own Anthropic API key decides who calls the model. Whether it
is paired decides only where recipes are kept and shared.

| | Key on this device | No key on this device |
| --- | --- | --- |
| Not paired | This device calls the model and keeps the recipes | No new recipes; recipes already on the device still run |
| Paired | This device calls the model; the service checks and stores the result | The service calls the model with the owner's credential, as before |

### The key on the settings page

The settings page has an **AI key** section: a masked field for an Anthropic API key, a
**Remove key** button, and a daily and a monthly spend limit in US dollars. The key is
saved in the extension's trusted local storage on this device only. It is never synced,
never exported, never shown again (the section names only its last four characters), and
never sent anywhere but `https://api.anthropic.com/v1/messages`, which is fixed in the
code. Chosen by an agent: a key is 8 to 256 printable ASCII characters after trimming;
the limits are 0 to $100,000 with cents, saved when the field is left or Enter is
pressed.

### Spend limits on the device

A key starts with the service's own limits, $5 a day and $100 a month (UTC), and the
person can change them. The device counts what its key spent: the usage Anthropic
reports at the model's published rates (`@pateat/inference/claude-rates`), also for an
answer too large to pass on; for a call that timed out, answered without usage or whose
answer could not be read, the worst case of 64 KiB of input (or the body's bytes, when
longer) and 1,024 output tokens, at the highest listed rates when the model is not
priced; nothing for a call that never reached Anthropic or that it answered with an
error. Before each call, a device at either limit answers as the service's own stops do
(`unavailable` with `daily-limit` or `monthly-limit`) and makes no call. Chosen by an
agent: a spend count or a key record that cannot be read, or reads as no record this
version knows, fails the request; it never counts as nothing spent, and never falls back
to the owner's credential on the service. A cost that could not be written still counts
toward the limits until it is. Requests in flight at once each check the limit before
the others are charged, so the limits can be passed by one call's cost per such request.
The service's limits do not count a device's calls.

### A paired device with its own key

The service still runs its whole route: the recipe it already holds, the once-per-page
attempt record, the room for another recipe, the bindings carried over, revoked IDs,
layout use and the checks of the model's answer. Only the model call moves to the
device, so the model gets the same input either way. Recipe generation and entry
requests (`POST /v1/recipes/generate`) and the judge
(`POST /v1/recipes/:recipeId/completion`) take an optional
`deviceModel: { responses: [...] }`:

1. The device sends the request with no responses.
2. Where the route would call the model, the service answers 200
   `{ version: 1, status: "model-call", call: { index, headers, body } }`: the
   Messages request body it would send and the `anthropic-version`,
   `anthropic-beta` and `content-type` headers. It holds no credential of the service's.
3. The device checks the call is one the routes make: a JSON body with a `claude-`
   model, `max_tokens` of at most 1,024, text in `system` and `messages`, an optional
   `output_config` with an effort and a JSON schema format, an optional `speed`, and
   nothing else (no tools, streaming, MCP servers or containers), and no
   `anthropic-beta` but fast mode's (`deviceModelCallBody`). Any other call fails the
   request unsent, so a service, possibly someone else's, has no other use of the key.
   It then sends the body as checked, written again from its parsed value, with its key
   and the
   `anthropic-dangerous-direct-browser-access: true` header, then sends the original
   request again with the responses so far. Each response carries the SHA-256 of the
   body it answers, and is the status and body (at most 16 KiB), `timeout` after 10
   seconds, or `unreachable`.
4. The service runs the route again and takes the responses in order in place of the
   calls. A refusal asks the owner's next model choice, which is one more `model-call`
   with the next index. A response whose hash does not match the body the service would
   send now is asked for again with the same index, and the device drops it and every
   later one.

A request carries at most 6 responses; the device stops after 12 `model-call` answers or
an index past its responses, and fails the request as an unexpected response. Chosen by
an agent: in this mode the service first runs the route without writing anything to
find out whether another call is needed, and writes the attempt record, the log rows and
the recipe only in the run that has every response, so an unanswered call leaves nothing
behind. Signed-in page samples ([ADR 0029](0029-local-sign-in-state.md)) call no model
and are unchanged.

The device uses the owner's model choices
([ADR 0014](0014-claude-generation-provider.md)). A key that cannot use a chosen model
or fast mode makes that call fail; falling back to the defaults is left for later. The
automatic stop of fast mode counts the device rows of all the owner's devices together,
apart from the service's own rows, so one device whose key has no fast mode, or that is
offline, can stop fast mode for the others for its window. Two devices that generate
for the same page at the same time may both pay for a call; the second write is
resolved as any write conflict is now. A service from before this change refuses
`deviceModel` with 400, and the device's generation and judge requests then fail; they
never fall back to the owner's credential.

### Log rows

While paired, the service logs each call the device made like its own
([ADR 0012](0012-inference-request-log.md)), with `source = device` instead of
`service`, the cost estimated from the reported tokens, and no token or model timings
(`token_ms` and `model_ms` are null, as the service did not wait for them). Without
pairing nothing is logged anywhere but the device's spend count. The service cannot
tell a device's response from one the device made up. A paired device could already
write any recipe with `PUT /v1/recipes/:id`, so recipes gain no new exposure, but such
rows and the recipe units built from them are only as trustworthy as the device, and
only `source` tells them apart from the service's own calls in evaluation data.

### Recipes a device keeps

A device keeps its own recipes apart from the synced cache, in trusted local storage
(`pateat.device-recipes.v1`), and logins use them while no service is paired. While
paired, logins use only the service's recipes.

- **Unpairing** (card, 13:04 UTC): **Disconnect this device** asks whether to keep the
  synced recipes. **Disconnect and keep recipes** stops a running sync and copies the
  synced cache into the device's store before the device is revoked;
  **Disconnect and delete recipes** leaves the store as it is and deletes the cache, as
  before. Settings stay on the device either way, as they did before this change, so the
  choice is about recipes only. Chosen by an agent: a recipe already kept under the same
  ID is replaced only by a newer revision; the store holds at most 2 MiB, the synced
  cache's share; when the recipes cannot be kept (too large, or the cache or the store
  cannot be read or written) the device stays paired and the page says so
  (`recipes-not-kept`). While disconnected, the settings page shows how many recipes are
  kept, or that their stored copy cannot be read (not while storage is only
  unavailable), with **Delete recipes on this device** (`service.delete-recipes`,
  refused while paired).
- **Upload once after pairing** (card, 12:36 UTC): each full sync of a paired device
  first uploads the kept recipes (`PUT /v1/recipes/:id` with `expectedRevision: 0`, as
  revision 1) and then pulls, so the pull brings them back from the service. A recipe
  the service holds revoked under its ID is removed from the store at once, as the
  service's copy wins; one it wrote or holds active is removed once the pull has put
  that ID in the synced cache, so a disconnect that keeps the synced recipes cannot miss
  it, and until then each full sync sends it again and gets a 409. A 400, 405, 413, or a
  409 other than `recipe_limit` that names no recipe of that ID, keeps the recipe on the
  device, and it is not sent again until a newer revision is kept under its ID.
  `recipe_limit`, 429, a 5xx answer, any other answer or no connection stops the upload
  until the next full sync; a 401 stops it, and the pull then marks the device rejected.
  Chosen by an agent: a recipes-only sync after a judged page
  ([ADR 0027](0027-per-account-login-routes.md)) uploads nothing, and a device
  disconnected during the upload removes nothing from its store.

### Generation on an unpaired device

Unpaired, the device runs the service's own generation and judge routes
(`@pateat/generation`, `packages/generation`) against its own `GenerationBackend`
(`apps/extension/src/service/device-generation.ts`); the service's is `d1Backend`. Both
run the same checks, build the same model input and write the same recipes.

- **When**: while no service is paired and a key is saved, generation runs under a
  connection of this device's own (`pateat-device:`), whose requests never leave it.
  Without a key no recipe is made, and recipes already on the device still run. A paired
  device always uses the service as above, whatever the key.
- **Recipes**: read from and written to the device's own store
  (`pateat.device-recipes.v1`, [above](#recipes-a-device-keeps)), only over the revision
  a write expects. Only the head of each recipe is kept. The service's limits apply:
  1,000 recipes and 1.5 MiB of recipe documents, and the store's own 2 MiB. A write that
  lands once a service is paired is refused as one another writer beat, and the upload
  reads the store in turn with the writes, so a pairing during a request never loses a
  revision to the upload.
- **Limits**: the retry window (ADR 0016), the daily repair (ADR 0041), the judgement
  per page and the 20 a day per recipe (ADR 0027), and each layout's last use (ADR 0060)
  are kept in `pateat.device-generation.v1` in trusted local storage, 2,000 entries per
  list at most, the oldest dropped first. A login that starts on a layout marks it used,
  once an hour, as the service's use report does (ADR 0058). The record is deleted when
  the recipes it describes are replaced or deleted (keeping the synced recipes on
  unpairing, or deleting the kept ones), since a recipe made again starts at revision 1.
  Chosen by an agent: a record that cannot be read counts as empty, as the other local
  records do; the key's spend limits still bound the cost. One request's model calls run
  at a time, until each call it sent has ended; a second answers `busy`, as the
  service's lock does.
- **Models**: the default choices (`DEFAULT_MODEL_CONFIG`), in the same order and with
  the same move to the next model after a refusal as the service
  (`roleChoices`, `nextAttempt`). There is no model picker on the device (12:38 UTC).
- **Key and spend**: each call goes to `https://api.anthropic.com/v1/messages` with the
  key, after the same checks of the request as the paired relay makes, and counts toward
  the key's daily and monthly limits as a paired call does; a limit reached before the
  first call answers `daily-limit` or `monthly-limit`. An answer whose spend cannot be
  written is still used, and its cost stays counted in memory. A key that cannot be read
  makes no recipes.
- **Bindings**: the slots a new layout carries come from the bindings in this device's
  settings.
- **Nothing logged** (owner, Q4): no request log, no page samples and no unit
  provenance (ADR 0060); a repeat login sends no sample.

Chosen by an agent: the backend is plain JavaScript over `storage.local` rather than
SQLite in WebAssembly, which needs no content security policy change and no second copy
of the D1 queries.

### Export and import

- **Export and import** (12:49 UTC): a file can carry everything pairing shares
  (settings, recipes and bindings) to another device, never vault data, the sync
  service's sign-in or the AI key. How this meets settings profiles is decided when
  profiles gain inheritance, since one device may switch between, for example, letting
  the model work and logging in by hand.

How it works (chosen by an agent unless noted):

- **The file** is JSON (`pateat-transfer`, version 1, `transferFileSchema` in
  `packages/contracts/src/transfer.ts`). It holds the settings document a service would
  hold, without vault connections and without the demo provider's policy, and the
  recipes logins use now: the synced cache while paired, or the recipes the device
  keeps. Like the service's copy, the settings name vault accounts and items by their
  labels. The same limits apply as on the service: a settings document of at most 120
  KiB and at most 1,000 recipes. Nothing on the device that pairing does not share goes
  into it: not the vault timeout, the request limits record, the diagnostics log or a
  recipe's provenance.
- **Importing settings** merges the file into the device's settings as a first pairing
  merges a service's: every entry of both is kept, and the file's entry wins where both
  hold one. Vault connections stay. The write is recorded as `settings-import` (ADR
  0025). A page with unsaved changes cannot import; a save from another page that meets
  an import is a conflict that is not reapplied automatically.
- **Importing recipes** keeps them as the device's own recipes (see
  [recipes a device keeps](#recipes-a-device-keeps)): a recipe replaces one kept under
  its ID only at a newer revision, so a login that resumes on a revision never finds
  other content under it. A paired device uploads them at its next full sync, under the
  upload rule above. Recipes that would not fit are refused, and then nothing is
  imported.
- **Only the settings page** exports and imports, through `settings.export` and
  `settings.import`; the popup cannot.

## Consequences

- A person can use a service run by someone else for sharing only, and no third party
  holds their Anthropic key.
- A paired request with a device key takes one round trip to the service more per model
  call, and the service runs the route's reads twice for each.
- The extension bundles the published Claude rates, so a price change needs an
  extension update as well as a service deploy.
- Recipes made on an unpaired device come from model output the extension receives
  directly. The Chrome Web Store reading in
  [the remote code note](../research/2026-10-17-chrome-web-store-remote-code.md) is
  checked again when the extension with that part is submitted (owner, 21:11 UTC).

## Alternatives

- **The device writes recipes itself with `PUT /v1/recipes/:id`**: it would have to
  repeat every check of the generation route, and write conflicts would differ
  (a revoked ID answers 409 to `expectedRevision: 0`; retrying a 409 could overwrite
  another device's recipe). Rejected for the paired case.
- **The device sends its key to the service for each request**: the owner rejected
  keeping a third party's key on a service (12:51 UTC), and a key in transit is still a
  key on the service.
- **A model picker per device**: rejected with the editors (12:38 UTC); the owner's
  choices on the service apply while paired, and the defaults otherwise.
