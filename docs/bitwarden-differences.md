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

## Master password re-prompt

The official clients ask for the master password before they fill, show or copy the
secrets of an item marked with re-prompt, and never fill such an item on page load
([Master Password Re-prompt](https://bitwarden.com/help/master-password-re-prompt/),
checked 2026-10-14). Pateat asks only on the sites listed in its settings, in its own
chooser window before a login starts or a passkey signs; elsewhere it uses such an item
like any other, and it never asks per field
([vault adapter](architecture.md#vault-adapter); owner's decision, 2026-10-23 at 12:46
UTC). Logging in without a person is what Pateat is for, and re-prompt protects the
interface rather than the vault data. On such a site a personal detail from another
re-prompt item, as an identity or a card, is read in a login started after that window;
in another login the window asks before the read, and the card guess never reads such a
card
([ADR 0061](adr/0061-personal-details-during-a-login.md#items-with-bitwardens-re-prompt);
owner, 2026-10-23 21:50 UTC).

## Decrypted items in memory

- While a vault is unlocked, the official clients keep every decrypted item in memory
  state (decrypted again after each change), removed on lock or logout
  ([ciphers.state.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/services/key-state/ciphers.state.ts#L22-L29),
  [cipher.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/services/cipher.service.ts#L239-L258)).
  Pateat's crypto Worker keeps no decrypted item between requests: each field listing
  or resolution decrypts its one item with the SDK and disposes it before replying
  ([vault adapter](architecture.md#vault-adapter); owner's decision 2026-10-23, which
  chose this over a copy narrowed to the allowed fields). It costs one SDK decryption
  per request; a login reads only a few fields.

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

## Connections and key derivation

- The official browser extension lets at most 5 accounts be logged in at once
  (`ACCOUNT_LIMIT = 5`,
  [account-switcher.service.ts](https://github.com/bitwarden/clients/blob/dd4d85816be0bed40c92d0890d6e7f1a497a85e8/apps/browser/src/auth/popup/account-switching/services/account-switcher.service.ts#L47-L74))
  and then offers no "Add account". Pateat does not cap connections; with more than 5,
  the options page warns that the official extension allows 5 accounts and that each
  unlocked vault uses more memory (`BITWARDEN_ACCOUNT_LIMIT` in
  `apps/extension/src/options/bitwarden-setup.tsx`, owner's choice 2026-10-23 at 12:31
  UTC). Each connection with an open vault keeps its own Worker with the SDK.
- The official clients run a key derivation without a time limit. Pateat runs it in a
  Worker it stops after 30 seconds, or 60 seconds for Argon2id (`ARGON2ID_JOB_BUDGET_MS`
  in `apps/extension/src/crypto/wire.ts`, owner's choice 2026-10-23), so a stuck Worker
  is reclaimed. It accepts the whole Argon2id range the official clients allow, memory
  16–1024 MiB
  ([kdf-config.ts](https://github.com/bitwarden/clients/blob/dd4d85816be0bed40c92d0890d6e7f1a497a85e8/libs/legacy-crypto/src/models/kdf-config.ts#L71-L73)).

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

- Both end a sign-in that waits for a two-step or new-device code after 5 minutes,
  counted once; a refused code keeps the same end in both. The official clients start
  the 5 minutes when the password grant answers with a challenge
  ([login-strategy.service.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/auth/src/common/services/login-strategies/login-strategy.service.ts#L194-L200));
  Pateat starts them at the press of Connect or Sign in and sync, before the prelogin,
  the password derivation and the grant, so its wait is shorter by those seconds.
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

## TOTP keys in custom fields

Pateat's side is `isTotpSeed` in `packages/bitwarden/src/totp.ts` and
`totpFieldReference` in `packages/contracts/src/recipes.ts`
([ADR 0027](adr/0027-per-account-login-routes.md#amendment-2026-10-23-a-totp-code-from-a-custom-field),
owner 2026-10-23). Official code is pinned at
[`8246ae9`](https://github.com/bitwarden/clients/tree/8246ae9c9a484a0a69f8b27203034555fb872523).

- The official extension fills a custom field by its name with the field's value as it
  is, whatever that value holds
  ([autofill.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/autofill/services/autofill.service.ts#L844-L893)),
  and makes TOTP codes only from the login's TOTP key
  ([autofill.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/autofill/services/autofill.service.ts#L1153)).
  Pateat never fills a Text or Hidden custom field shaped like a TOTP key as text and
  never offers it to recipe generation: it makes codes from it for the `totp` slot, and
  takes it as the item's TOTP field when the login's own TOTP holds no value. A key
  typed into a page as it is would give the second factor away, and a person who keeps a
  key in a custom field, as Bitwarden lets them, means it for codes.

## Vault timeout

Pateat's side is [ADR 0075](adr/0075-vault-lock-and-timeout.md) and
`apps/extension/src/vault/timeout.ts`. Official code is pinned at
[`8246ae9`](https://github.com/bitwarden/clients/tree/8246ae9c9a484a0a69f8b27203034555fb872523).

- Both offer Lock and Log out as the timeout action, and the minute presets, a custom
  number of minutes, On system lock, On browser restart and Never. The official browser
  extension also offers Immediately and does not offer On system idle
  ([browser-session-timeout-type.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/key-management/session-timeout/services/browser-session-timeout-type.service.ts#L13-L34)).
  Pateat leaves out Immediately and offers On system idle, both as the owner chose on
  2026-10-23 (12:44 UTC). It acts on
  Chrome's `idle` state after the official extension's 5-minute detection interval, and
  on `locked` too
  ([idle.background.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/background/idle.background.ts#L15-L82)).
- The official default is On browser restart
  ([main.background.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/background/main.background.ts#L889)).
  Pateat's is Never, so a vault keeps unlocking after a restart as the owner required
  before the setting existed ([ADR 0006](adr/0006-atomic-local-vault-cache.md)); an
  agent's choice, to be reconsidered.
- The official extension counts the minutes from the last account activity it records
  ([vault-timeout.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/key-management/vault-timeout/services/vault-timeout.service.ts#L84-L126)).
  Pateat counts from the last field filled, passkey signed, unlock or sign-in, since it
  has no vault view to be active in.
- The timeout acts on every vault on the device; the official extension sets it per
  account. Pateat's setting is per device and never synced, as the owner chose.
- Log out keeps Pateat's encrypted vault cache and forgets only the unlock key and the
  sync sign-in, so the connection and its field settings stay; the official logout
  removes the account from the extension.

## Software keyboards

Accepted by the owner on 2026-10-23
([ADR 0067](adr/0067-software-keyboard-entry.md)).

- The official extension never fills a read-only or disabled field
  ([insert-autofill-content.service.ts](https://github.com/bitwarden/clients/blob/abccf1e342dccba06a3cc635cd4c706defa64a32/apps/browser/src/autofill/services/insert-autofill-content.service.ts#L208-L212))
  and has no rule for a page's own keys. Pateat types a read-only field whose recipe
  names the page's keypad by pressing the key that shows each character, and stops
  without submitting when a character has no single key or the field does not take a
  press. Such pages would otherwise always be left to the person.
