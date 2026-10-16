# ADR 0039: Token-like path segments are sent as `[id]` on every page

Status: accepted by the owner on 2026-10-16 at 14:10 UTC. Asked whether login pages
should get the same `[id]` replacement the signed-in judge already uses, the owner
answered 「ログインページも同じ、というかすべてのページで同じでいい」 (login pages the
same; in fact the same on every page is fine). Implemented (local tests only; not yet
checked on a real site). Replaces the implementation choice of
[ADR 0016](0016-recipe-generation-trigger.md) made on 2026-10-11 without an owner
decision, that a page whose path may carry a token is never observed or sent, and
extends the `[id]` rule of [ADR 0029](0029-local-sign-in-state.md) ("Pages that could
not be sent", owner, 2026-10-12 19:23 UTC) from the judged page to every page, including
its handlers.

Date: 2026-10-16

## Context

`tokenSegment()` in `apps/extension/src/observation/extract.ts` flags a path segment
that may carry a session ID or another token: a matrix parameter such as `;jsessionid=`,
an ASP.NET cookieless part, `?`, `&` or `=`, a UUID, or a long run of letters and digits
with a digit, as it is or percent-decoded. Since ADR 0016 a login page, a list of
accounts ([ADR 0028](0028-account-chooser-login-pages.md)) and a sign-in entry page
([ADR 0031](0031-sign-in-entry-pages.md)) with such a segment were refused as
`unsupported-page`, so the token never reached the service. Since ADR 0029 the judged
page was sent instead with `[id]` (`REDACTED_PATH_SEGMENT`) in place of each such
segment, and the service refused to learn a handler on such a path (`redacted-path`),
since no live page path would match it.

The refusal also hit identity providers whose path names a tenant or an authorization
server rather than a session:

- On build `747d237`, on 2026-10-16 at 03:35 UTC, UNSW's single sign-on at
  `https://login.microsoftonline.com/<tenant UUID>/oauth2/authorize` (Microsoft Entra)
  logged `recipe.generate` `skipped` `unsupported-page`, and Pateat never filled.
- On `d4faf03`, on 2026-10-16 at 14:12 UTC in the owner's Chrome, UniSuper's
  `member.id.unisuper.com.au` logged `recipe.generate` `skipped` `unsupported-page`
  `page=entry` for `/oauth2/<auth server ID>/v1/authorize`, an Okta-style path whose
  second segment is a long run of letters and digits (shaped like
  `aus1a2b3c4d5e6f7g8h9`), not a UUID.

## Decision

On every page Pateat observes (a login page, a list of accounts, a sign-in entry page,
the page after an `advance` step and a judged page), each whole path segment that
`tokenSegment()` flags is replaced by `[id]`, as ADR 0029 already does for the judged
page. The page is no longer refused for its path. The token itself never leaves the
device. A recipe is stored under the redacted path, and a live page matches a recipe
through its redacted path, so every tenant's
`login.microsoftonline.com/[id]/oauth2/authorize` shares one recipe.

Example: `https://login.microsoftonline.com/<tenant UUID>/oauth2/authorize` is observed
and sent as `/[id]/oauth2/authorize`, and UniSuper's entry page as
`/oauth2/[id]/v1/authorize`. The recipe generated there runs on that page of any tenant.

The whole segment is replaced, as before; the owner accepted in the same discussion that
`/app/login;jsessionid=X` and `/app/register;jsessionid=Y` both read `/app/[id]`.

The local log's `url` keeps the raw path (owner decision of 2026-10-13); only what goes
to the service is redacted.

Implementation choices that follow from the decision, made by the agent and not
confirmed by the owner:

- One helper, `observedPath()` (`apps/extension/src/observation/path.ts`), makes the
  replacement. The extractor's paths, the content script's reports and step checks, the
  worker's document path, the popup's page status, the code-submission watch and the E3
  return-target check of ADR 0029 all go through it, so a recipe's or an observation's
  path is only ever compared with a redacted live path. The helper leaves `[id]` as it
  is, so a path redacted twice is unchanged.
- The generation eligibility checks (no recipe start or entry on the path, the 10-minute
  retry window of ADR 0016 condition 4) and the `sending`/`sent` claims key on the
  redacted path, so one tenant's attempt holds the page for every tenant, and a page
  whose recipe exists is not offered again.
- On a page whose path had a segment replaced, an `id`, `name` or `data-testid` that may
  be a token locates nothing, as on a judged page, so a token the page also writes into
  an attribute does not reach the service through a locator. A page whose path carries
  no token keeps such values, as before: applying the rule to every login page would
  drop stable IDs such as ASP.NET's `ctl00_ContentPlaceHolder1_txtUserName`, which the
  rule flags, from pages that are observed today.
- A username in the path is still looked for in the raw path, before the replacement
  (`username-shown`, `username-in-path`, and a list's `unsupported-page`), as well as in
  the sent path, so a username that looks like a token still keeps the page from being
  sent.
- `addHandler` (`packages/inference`) no longer refuses a page on a path with `[id]`;
  the `redacted-path` reason and `hasRedactedSegment` are removed. The service treats
  the path as an opaque value: `generatedRecipeId` hashes `/[id]/oauth2/authorize` like
  any path, and the contracts' path schema already accepts it.

## Consequences

Sign-in pages of identity providers that put a tenant, an authorization server or
another ID in the path get recipes, and one recipe serves every tenant of such a
provider for the owner. Pages that differ only in a token-like segment now share one
recipe, one retry window and one judgement row, so two different forms behind such a
segment, such as a `;jsessionid=` login and register page, are treated as one page: the
recipe of one may be tried on the other, and its steps then miss their elements as on
any changed page.

The rule stays a heuristic: a short or plain-looking token is still sent as it is, as
before, and some segments that carry no secret, such as an Azure AD B2C policy name, are
replaced too.

## Alternatives

- Keep refusing such pages, the earlier rule: no recipe on these identity providers.
- Replace only the matched part of a segment, so `/app/login;jsessionid=X` reads
  `/app/login;[id]`: keeps more pages apart, but the owner accepted the whole-segment
  rule.
- Apply the attribute token rule on every login page: stricter, but would leave many
  ASP.NET login pages incomplete (`unlocated-field`) that are generated today.
