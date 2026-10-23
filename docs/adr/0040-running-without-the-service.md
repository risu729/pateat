# ADR 0040: A device's own Anthropic API key, and running without the service

Status: accepted by the owner on 2026-10-23. The owner decided that the extension calls
the model itself from the device (12:38 UTC: without a model, logins on new pages simply
do not run, and there is no editor for recipes or bindings), that a device may keep its
key while the service is only used for sharing (12:51 UTC: "a third party would never
want to put their key on my service"), that files can export and import everything
pairing shares (12:49 UTC), and, on cards between 12:36 and 13:04 UTC, the upload rule,
the key field, the spend stops, the log rows and the choice on unpairing below. The
details marked "chosen by an agent" were not asked. Only the
[paired part](#a-paired-device-with-its-own-key) is implemented so far; the rest comes
in later pull requests. Amends [ADR 0012](0012-inference-request-log.md),
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
| Not paired | This device calls the model and keeps the recipes (later) | No new recipes; recipes already on the device still run (later) |
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
reports at the model's published rates (`@pateat/inference/claude-rates`); for a call
that timed out or answered without usage, the worst case of 64 KiB of input and 1,024
output tokens, at the highest listed rates when the model is not priced; nothing for a
call that never reached Anthropic or that it answered with an error. Before each call,
a device at either limit answers as the service's own stops do (`unavailable` with
`daily-limit` or `monthly-limit`) and makes no call. The service's limits and its
automatic stop of fast mode do not count a device's calls.

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
3. The device sends that body with its key and the
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
or fast mode makes that call fail; falling back to the defaults is left for later. Two
devices that generate for the same page at the same time may both pay for a call; the
second write is resolved as any write conflict is now.

### Log rows

While paired, the service logs each call the device made like its own
([ADR 0012](0012-inference-request-log.md)), with `source = device` instead of
`service`, the cost estimated from the reported tokens, and no token or model timings
(`token_ms` and `model_ms` are null, as the service did not wait for them). Without
pairing nothing is logged anywhere but the device's spend count.

### Running without the service (later pull requests)

- **Generation on the device**: unpaired, the device runs the same checks and builds
  the same model input with code shared with the service, and keeps its recipes in its
  own store. Without a key no recipe is made, and recipes already on the device still
  run. There is no editor for recipes or bindings.
- **Upload once after pairing** (card, 12:36 UTC): recipes the device made are uploaded
  once on the first full sync after pairing (`PUT /v1/recipes/:id` with
  `expectedRevision: 0`) and then removed from the device's own store. If the service
  already holds the ID, revoked included, the service's wins. A 400, 405, 413 or an
  unknown 409 keeps the recipe on the device; `recipe_limit`, 429, a 5xx answer or no
  connection tries again on the next full sync.
- **Export and import** (12:49 UTC): a file can carry everything pairing shares
  (settings, recipes and bindings) to another device, never vault data, the sync
  service's sign-in or the AI key. How this meets settings profiles is decided when
  profiles gain inheritance, since one device may switch between, for example, letting
  the model work and logging in by hand.
- **Unpairing** (card, 13:04 UTC): the confirmation asks whether to keep the synced
  recipes and settings as this device's own, so it keeps working without the service,
  or to delete them as now.

## Consequences

- A person can use a service run by someone else for sharing only, and no third party
  holds their Anthropic key.
- A paired request with a device key takes one round trip to the service more per model
  call, and the service runs the route's reads twice for each.
- The extension bundles the published Claude rates, so a price change needs an
  extension update as well as a service deploy.
- Recipes made on an unpaired device come from model output the extension receives
  directly. The Chrome Web Store reading in
  [the remote code note](../research/2026-10-17-chrome-web-store-remote-code.md) must
  be checked again before that part ships.

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
