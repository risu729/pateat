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

- Regex URIs (`match` 4) are evaluated as the official clients evaluate them,
  `new RegExp(uri, "i").test(pageUrl)`
  ([login-uri.view.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/models/view/login-uri.view.ts#L177-L186)),
  but in a nested Worker stopped after 5 seconds for one page URL
  ([ADR 0056](adr/0056-regex-uris-in-a-nested-worker.md), owner's choice 2026-10-19).
  The official clients run the pattern in the browser extension's background, for
  example while building the inline menu
  ([overlay.background.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/autofill/background/overlay.background.ts#L583)),
  with no timeout, input limit or pattern check; their only guard is a warning that the
  mode risks exposing credentials
  ([messages.json](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/_locales/en/messages.json#L5901-L5904)).
  A backtracking pattern takes exponentially longer as the page URL grows: testing
  `new RegExp("(a+)+$", "i")` against `https://example.com/?q=` followed by `a`s and a
  `!` doubles in time with each extra `a`, and took 18 seconds with 30 of them in Node
  26 on 2026-10-19. Pateat holds the vault session in the crypto Worker, which such a
  pattern would block. A pattern still running after 5 seconds, and the patterns after
  it, are `regex-unevaluated` on that page, so their item counts as unevaluated rather
  than as no match, and the running one, when it ran for at least half the time on its
  own, is not tried again for that page URL. A pattern that finishes in the official
  clients may therefore leave its item unevaluated in Pateat.
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
  the document's origin, or is on another host of the document's site that the login's
  Bitwarden item matches under its own URI match detection
  ([ADR 0051](adr/0051-form-destinations-by-item-uri-match.md), owner's choice on
  2026-10-19 at 01:29 UTC); cross-site destinations stay refused even where an
  equivalent domain or a "starts with" URI would match, and `data:`, `vbscript:` and
  unparsable values are refused. Injected markup on an admitted page, such as a dangling
  `<form action="https://attacker.example/">` or a `<base href>`, would otherwise
  receive the username and password.
- A form that shows no button (ADR 0064) is submitted by Enter in its last field: Pateat
  clicks the form's default button, its first submit button in tree order among the
  form's controls, or calls `requestSubmit()` when it has none. The official auto-submit
  (only under the automatic app login policy) instead clicks the first submit button in
  the form's subtree whose words match its login button names, then a plain button so
  named, then calls `requestSubmit()`, walks up from the last field when there is no
  form, and never checks `disabled`
  ([auto-submit-login.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/content/auto-submit-login.ts#L111-L240)).
  Pateat reads no button words (ADR 0033; the generation role judges the buttons it
  saw), needs a `<form>`, and presses no default button that is disabled, associated
  with the form only through `form=`, or already shown when the fill began, which the
  generation role saw and did not name; the destination is checked as for a click.
- A `javascript:` form action is allowed for fill and click (owner's decision,
  2026-10-18 04:19 UTC), as the official clients fill such a form like any other (their
  action handling above has no case for it). Chrome refuses to run the `javascript:` URL
  itself when the content script's click submits the form (the isolated world's
  `script-src 'self'`), so only forms whose own handlers sign in work;
  `action="javascript:doLogin()"` does not.

## Submit button outside the form

Official code is pinned at
[`abccf1e`](https://github.com/bitwarden/clients/tree/abccf1e342dccba06a3cc635cd4c706defa64a32).
Pateat's rule is `besideForm` in `packages/inference/src/plan.ts`
([plan](plan.md#ai-evaluation-harness-progress)).

- For filled fields inside a form, the official auto-submit looks for a login button
  only inside that form and otherwise calls the form's `requestSubmit()`
  ([auto-submit-login.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/content/auto-submit-login.ts#L133-L142)).
  Pateat's generated recipe may click a button outside the form (owner's choice,
  2026-10-23 11:47 UTC). It does so only when every filled field is in that
  one form, that form holds the page's only password field and has no button the page's
  description lists (a script or icon button without a locator is not listed), no field
  outside every form is on the page, and the button is the only one outside every form
  and names no passkey, so it is the one the extractor keeps beside that form. Sakura
  Internet's login button is a script `type="button"` just after its form: submitting
  the form would post nothing the page handles.

## Frames

- When a frame's URL does not match the item, the official clients ask with `confirm()`
  before filling
  ([autofill.service.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/services/autofill.service.ts#L1545-L1568),
  [insert-autofill-content.service.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/services/insert-autofill-content.service.ts#L108-L120))
  and block only autofill on page load. Pateat refuses with `frame-top-mismatch` unless
  the item matches both the frame's URL and the tab's URL
  ([ADR 0017](adr/0017-login-forms-in-frames.md)): no person is there to answer a
  prompt during an automatic login.

## Toolbar badge

- The official extension counts the ciphers that match the tab's full URL and shows
  `9+` above 9
  ([autofill-badge-updater.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/autofill/services/autofill-badge-updater.service.ts#L52-L66)).
  Pateat counts the items that match the tab's origin (`origin/`), so a StartsWith or
  Exact rule for a deeper path is not counted, adds items holding a passkey for the
  origin's RP IDs, and shows `99+` above 99; items Pateat may not use show their count
  in light gray instead of being counted with the rest
  ([ADR 0021](adr/0021-account-choice-outside-settings.md#site-count-badge), owner's
  decision 2026-10-13 at 14:42 UTC). On an `http:` page only items saved with an
  `http://` URI count, as for logins (see URI matching above).

## Passkeys

- Chrome Immediate UI (`uiMode: "immediate"`): the official extension copies only
  `mediation` from the request and drops `uiMode`
  ([webauthn-utils.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/apps/browser/src/autofill/fido2/utils/webauthn-utils.ts#L103-L128)),
  so it handles the request as a normal get and asks through its popout
  ([fido2-authenticator.service.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts#L283-L292)),
  even where Chrome would reject the request. Pateat also answers it as a normal get
  (owner's decision, 2026-10-19 at 20:48 UTC), but delegates where Chrome's guide says
  it rejects Immediate UI: without a user gesture, with a nonempty allow list, or in
  incognito, so the site sees the rejection it would get from Chrome
  ([ADR 0052](adr/0052-immediate-ui-stored-passkeys.md); owner's decision, 2026-10-19
  at 22:42 UTC).

## Self-hosted server address

- The official clients accept any `http://` or `https://` server URL and add `https://`
  only when none is given
  ([default-environment.service.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/common/src/platform/services/default-environment.service.ts#L340-L351)).
  Pateat takes `http://` only for exactly `localhost` and `127.0.0.1`, with an optional
  port and no path; every other root must be `https://` (`normalizeBitwardenProfile` in
  `packages/bitwarden/src/environment.ts`,
  [ADR 0059](adr/0059-latest-vaultwarden-server.md), owner's choice 2026-10-19 at 22:14
  UTC). Over
  plain HTTP to another host the master-password hash and the tokens would cross the
  network unencrypted; loopback traffic stays on the machine. Lookalikes such as
  `localhost.` or `vault.localhost` are refused, and so is `[::1]`, which Chrome's
  extension CSP cannot name (`http://localhost` reaches a server listening on `::1`;
  leaving it out is the agent's narrowing, not confirmed by the owner).

## Email two-step codes

- Both send one code when email becomes the chosen method and another on "Resend code"
  ([two-factor-auth-email.component.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/auth/src/angular/two-factor-auth/child-components/two-factor-auth-email/two-factor-auth-email.component.ts#L76-L100)).
  The official page then names the masked address from the server's provider data;
  Pateat says only that the code went to the account's two-step email, because it
  returns no raw challenge parameters (ADR 0059).
- The official page logs a failed send and shows nothing
  ([two-factor-auth-email.component.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/auth/src/angular/two-factor-auth/child-components/two-factor-auth-email/two-factor-auth-email.component.ts#L121-L167)).
  Pateat shows that the server is limiting code emails, that it cannot send them, that
  it refused, or that the request failed.

## Two-step sign-in timeout

Pateat's side is the settings page's Bitwarden panel
([Architecture](architecture.md#unsupported-bitwarden-sign-in-cases)). Official code is
pinned at
[`86f4156`](https://github.com/bitwarden/clients/tree/86f41566aebe5a024796df8abfb3d4d89ec509c1).

- Both end a sign-in that waits for a two-step or new-device code after 5 minutes. The
  official clients restart the 5 minutes each time the server asks for another code
  ([login-strategy.service.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/auth/src/common/services/login-strategies/login-strategy.service.ts#L194-L200));
  Pateat counts them once, from the press of Connect or Sign in and sync.
- The official two-step page shows no end time
  ([two-factor-auth.component.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/auth/src/angular/two-factor-auth/two-factor-auth.component.ts#L270-L285));
  Pateat's code screen says "Enter the code by 8:26 PM", because a person who leaves to
  fetch an email code otherwise cannot tell that the sign-in will end.
- When the time is up, the official extension opens a separate "Authentication timeout"
  page that says "The authentication session timed out. Please restart the login
  process." with a Log in button
  ([authentication-timeout.component.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/angular/src/auth/components/authentication-timeout.component.ts#L18-L25),
  [messages.json](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/apps/browser/src/_locales/en/messages.json#L1901-L1906)).
  Pateat keeps the sign-in form, where the master password goes, and says next to it
  when the sign-in timed out, or that it ended early because Pateat's background
  stopped, since its waiting sign-in lives in a service worker Chrome can stop.
