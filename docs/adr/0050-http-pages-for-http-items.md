# ADR 0050: Plain HTTP pages log in with items saved for `http://`

Status: accepted by the owner on 2026-10-18 at 01:41 UTC. Asked why Pateat skips `http:`
pages, and offered the options of filling without submitting there or limiting them to
items whose URI is saved as `http://`, the owner answered 「ok sure. then follow bw.
vault の URI が http で保存されている項目に限る、で、自動送信は入れる」 (follow
Bitwarden; limit it to items whose vault URI is saved with `http`, and include the
automatic submit). Implemented (local tests only; not yet checked on a real site).
Amends [ADR 0009](0009-install-time-https-site-access.md), whose "plain HTTP pages are
never admitted" rule had no recorded reason. Amended on 2026-10-19 at 01:25 UTC: asked
whether `http://localhost` pages should answer passkeys as Bitwarden's extension does,
the owner chose 「Bitwarden に合わせる」 (follow Bitwarden) over keeping passkeys on
HTTPS only.

Date: 2026-10-18

## Context

Until this ADR, Pateat declared only `https://*/*`, its login content scripts matched
only HTTPS pages, and the background refused any other page as `not-https`. Some sites
the owner uses, such as a router's or an old service's sign-in page, only serve plain
HTTP, so Pateat did nothing there.

Bitwarden's browser extension fills on HTTP pages and warns first when the item's saved
URI is `https://` but the page is `http:`
([Bitwarden help](https://bitwarden.com/help/auto-fill-browser/)). Chrome already shows
the "Read and change all your data on all websites" warning for `https://*/*`, so adding
`http://*/*` does not change that wording.

## Decision

- Production declares `http://*/*` beside `https://*/*`, and the login scripts
  (`login.js`, `login-main.js`) run on every HTTP(S) page and frame. The passkey scripts
  of [ADR 0007](0007-existing-passkey-assertions.md) run on HTTPS and on
  `http://localhost/*` (any port), as Bitwarden's do: WebAuthn needs a secure context,
  and Bitwarden admits `localhost` as the one HTTP host, not `127.0.0.1`, `[::1]` or
  `*.localhost` (`passkeyOrigin` in `apps/extension/src/passkeys/rp-id.ts`). The
  synthetic probe build keeps the shared login and passkey scripts on HTTPS; its own
  scripts cover loopback HTTP.
- An `http:` document is admitted as an `https:` one is: on a non-excluded site whose
  host access is still granted for that scheme (`http://host/*`), with a cached recipe
  for its exact origin. Anything else is refused as `not-web`.
- On an `http:` page a vault item matches only through a URI saved with an explicit
  `http://` scheme, under any of Bitwarden's match modes
  (`apps/extension/src/crypto/http-page.ts`). An `https://` URI or a bare host such as
  `example.com` never matches an `http:` page. Since every account choice goes through
  that match (or an item's static `allowedOrigins`, which name exact origins), a login
  with a saved default, a single URI match, the popup's list, the count of a waiting
  choice and the recipe generation trigger on an `http:` page all see only those items,
  and so does the site count badge of
  [ADR 0021](0021-account-choice-outside-settings.md#site-count-badge).
  The popup searches no passkeys on an `http:` page other than `http://localhost`. After
  a logout the popup may still show a saved default whose item no longer matches, as on
  HTTPS, but a login with it is refused. URI rules that cannot be evaluated count only
  when saved with `http://`. Bitwarden's own warning case therefore never fills: no
  person is there to answer a warning during an automatic login.
- A login on an `http:` page runs as on HTTPS, filling and submitting included, except
  that it never takes the `passkey` route, since no passkey script runs there, unless
  the page is `http://localhost`. There, as on HTTPS, passkeys are found by RP ID
  (`localhost`) rather than by saved URI, and a passkey answer counts toward a move only
  to an HTTPS or `http://localhost` page. The synthetic probe build, whose own passkey
  scripts cover `http://localhost`, lets any loopback page take it (`passkeyScriptsRun`
  in `apps/extension/src/passkeys/rp-id.ts`).
- A login on an `http:` origin may count a move to an `http:` or `https:` page by the
  rules of [ADR 0022](0022-login-attempts-per-tab-and-origin.md) and
  [ADR 0027](0027-per-account-login-routes.md) (`loginMoveFits`). A login on an
  `https:` origin still counts only `https:` pages; a move to an `http:` page ends it
  `left-origin`, as a move to another site does.
- On an `http:` page a sign-in entry link or a return path
  ([ADR 0031](0031-sign-in-entry-pages.md)) may be `http:` on the site; on an `https:`
  page it must still be `https:` (`link-not-https`).
- HTTPS pages are unchanged: an item whose only URI is `http://` still matches an
  `https:` page of its domain, as in Bitwarden.

## Consequences

A password Pateat fills on an `http:` page travels unencrypted, and anyone on the
network path can read it or change the page, including inserting a form Pateat then
fills and submits. Limiting `http:` pages to items saved for `http://` keeps an item
saved for an HTTPS site from ever being sent that way; the user opts an item in by
saving its URI as `http://`.

The login scripts now run on every HTTP page too, so the event `login-main.js` listens
for tells an HTTP page, and anyone able to change it on the network, that Pateat is
installed. Admission, the recipe lookup and every
policy check stay as for HTTPS, so a page without a cached recipe still gets no attempt,
observation or vault access.

The passkey bridge wraps `navigator.credentials` on every `http://localhost` page,
including local development servers. As on HTTPS, a request Pateat does not claim goes
to the browser unchanged, and a passkey is offered only when the vault holds one for the
RP ID `localhost`.
