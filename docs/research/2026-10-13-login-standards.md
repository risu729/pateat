# Web standards that could replace parts of a login recipe

Researched: 2026-10-13, from the repository at
[`e831c08`](https://github.com/risu729/pateat/commit/e831c0817c03a5625b44fea960e19facc6180b62)
(main). The owner pasted an external write-up on how browsers and standards bodies are
making sign-in machine-readable, and asked for it to be summarised in the repository
with the protocols worth supporting added to the plan. A second agent checked each dated
claim against the primary sources listed below; the write-up's mistakes are corrected
here and listed under [corrections](#corrections-to-the-pasted-write-up). Statuses are
as of 2026-10-13.

## What Pateat reconstructs today

Pateat reads each site's sign-in flow from its pages. The standards below would each
make one part of that flow explicit:

| Pateat today | Where | What the page does not say |
| --- | --- | --- |
| A saved-account list without inputs starts no login until it is read as one | [ADR 0028](../adr/0028-account-chooser-login-pages.md) | This is a sign-in start, and this entry is that account |
| After the password, npm goes on to nothing, a TOTP page or a security key | [ADR 0027](../adr/0027-per-account-login-routes.md) | What this attempt asks for next |
| A site asks for the email first and offers a passkey only on the next page | [ADR 0036](../adr/0036-passkey-after-the-identifier.md) | Entering the identifier and proving it are separate steps |
| A page after the login is told from a page still signing in | [ADR 0029](../adr/0029-local-sign-in-state.md) | Whether the sign-in succeeded |

A recipe has `fill`, `click`, `wait` and `assert` steps, password variants, `passkey`
and `totp` handlers and signed-in markers. It locates fields by `id`, `name`,
`data-testid`, `autocomplete` token or visible name
([ADR 0037](../adr/0037-fields-by-visible-name.md)), and buttons by their text
(`packages/contracts/src/login.ts`). Its routes are
`password` and `passkey` (`loginRouteSchema`); sign-in through an identity provider
([ADR 0026](../adr/0026-sign-in-through-identity-providers.md)) is designed but not
built. OpenID Connect does not help here: Core 1.0 leaves how the end user is
authenticated "beyond the scope of this specification"
([Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)).

## Shipped in Chrome stable

Pateat meets these on sites' pages; it does not call them itself. Not every one is
settled in the sense of the
[platform-feature rules](../development.md#platform-features) (FedCM and Immediate UI
are in Chrome only).

- **`autocomplete` tokens.** `username`, `current-password`, `new-password`,
  `one-time-code` and `webauthn` say what an input is for. Pateat locates fields by
  `username`, `email`, `current-password`, `one-time-code` and `webauthn`
  (`loginAutocompleteTokens`), and leaves `new-password` out on purpose. They say
  nothing about which button to press, where a code comes from or whether the sign-in
  completed.
- **WebAuthn and conditional mediation.** WebAuthn Level 3 became a W3C Recommendation
  on 2026-08-25 ([TR](https://www.w3.org/TR/webauthn-3/)). With
  `navigator.credentials.get({ mediation: "conditional" })` and an input marked
  `autocomplete="username webauthn"`, passkeys appear among the input's autofill
  suggestions. Pateat answers such requests through a login
  ([ADR 0034](../adr/0034-answer-page-passkey-requests.md)). A site that asks for the
  email first still needs its own steps up to the request (ADR 0036), and a signature is
  not proof that the site accepted it.
- **Immediate UI.** When the person presses "Sign in", the site calls
  `navigator.credentials.get({ ..., uiMode: "immediate" })`. If the browser has a
  passkey or a saved password for the site it shows an account picker at once;
  otherwise the call fails quickly and the site goes to its login page. Shipped in
  Chrome 149
  ([announcement, 2026-05-12](https://developer.chrome.com/blog/webauthn-immediate-ui),
  [guide](https://developer.chrome.com/docs/identity/immediate-ui-mode),
  [UX patterns, 2026-10-07](https://developer.chrome.com/docs/identity/ux-quick-signins)).
  The origin trial's `mediation: "immediate"` no longer triggers it. The call needs a
  user gesture. Passwords come only from Google Password Manager; passkeys from Google
  Password Manager, Windows Hello or iCloud Keychain. It is not a way for other password
  managers to offer their vaults.
- **FedCM.** Federated sign-in as a browser API, with the browser showing the account
  picker, without third-party cookies. Chrome has it since 108; MDN's compatibility data
  lists Firefox and Safari as unsupported
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/FedCM_API)). The only W3C TR
  publication is the 2024-08-20 First Public Working Draft
  ([TR](https://www.w3.org/TR/fedcm/),
  [editor's draft](https://w3c-fedid.github.io/FedCM/)). Google Identity Services
  already uses it
  ([migration guide](https://developers.google.com/identity/gsi/web/guides/fedcm-migration)).
  Its dialog is browser UI, and a content script's click carries no user activation, so
  ADR 0026 leaves FedCM out of reach
  ([identity provider screens](2026-10-11-identity-provider-screens.md#what-a-content-script-cannot-reach)).
- **Login Status API.** A site tells the browser it is signed in with
  `navigator.login.setStatus("logged-in")` or a `Set-Login` response header. It is now
  its own FedID WG specification, which FedCM depends on
  ([editor's draft](https://w3c-fedid.github.io/login-status/)). It is written by the
  site and read by the browser; a page or extension cannot ask it whether a site is
  signed in, so it does not replace ADR 0029.
- **WebOTP.** The browser reads a one-time code from an SMS bound to the origin
  (`@example.com #123456`). The only transport defined is `sms`
  ([draft](https://wicg.github.io/web-otp/)). It does not cover TOTP, email codes or
  inboxes.

## Proposed or in origin trial

- **Agentic Federated Login.** A FedID proposal whose problem statement is Pateat's:
  an agent that reads the DOM to press an SSO button is right only some of the time, and
  must not confuse signing in with creating an account
  ([explainer](https://github.com/w3c-fedid/agentic-federated-login),
  [Intent to Experiment, 2026-03](https://groups.google.com/a/chromium.org/g/blink-dev/c/FLaenhru3zo)).
  It proposes three things: the agent asks the browser whether the page has a pending
  FedCM request; IdP-initiated FedCM brings sites that never adopted FedCM in through a
  change on the identity provider's side
  ([explainer](https://github.com/fedidcg/idp-initiated)); and a
  `potentially_approved_sites` signal for whether the person already has an account,
  which the explainer itself calls "a weak signal with false positives and false
  negatives". ADR 0026 already stops on consent pages; this would move that boundary
  into a browser interface instead of a page judgement. The explainer is written for a
  browser's own agent; whether an extension could use the same interface was not
  found.
- **`<login>` and `<credential>` elements.** HTML that declares a sign-in entry and the
  methods it accepts (`publickey`, `federated`, and passwords), so the browser can
  match them with the credentials the person has and offer only those. Status "early
  draft", author Sam Goto, with a Blink Intent to Prototype
  ([explainer](https://github.com/fedidcg/login-element)). It would answer ADR 0028's
  and ADR 0031's question (is this a sign-in entry, which account) from markup.
- **WebMCP.** A site registers tools with a name, description, input schema and handler:
  `document.modelContext.registerTool()`, `getTools()` and `executeTool()`. Chrome also
  documents a declarative form with `toolname`, `tooldescription` and
  `toolparamdescription` attributes on a form, which the specification does not define.
  Early preview on 2026-02-10, origin trial from Chrome 149
  ([preview](https://developer.chrome.com/blog/webmcp-epp),
  [origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial)). The
  specification is a Web Machine Learning CG Draft Community Group Report of 2026-10-13
  that says it "is not a W3C Standard nor is it on the W3C Standards Track"
  ([draft](https://webmachinelearning.github.io/webmcp/)). Extensions can query and run
  a page's tools from a content script
  ([overview](https://developer.chrome.com/docs/ai/webmcp)); Chrome publishes a
  [security guide](https://developer.chrome.com/docs/ai/webmcp/secure-tools). WebMCP
  defines no sign-in schema: a site that exposes, say, `get_session_state()` returning
  `{ authenticated: true }` does so in its own words, and a tool's description and
  result can carry prompt injection like any page text. It helps after a sign-in, or
  with a sign-in a site chooses to expose; it does not authenticate.
- **Email Verification.** Instead of mailing a code, the browser uses the person's
  signed-in session at their email provider to get a signed token proving they own the
  address, and the site checks the token; without support it falls back to the email.
  Origin trial since Chrome 150 on desktop; Chrome 154 adds Android and third-party
  origin trials
  ([2026-10-05 update](https://developer.chrome.com/blog/email-verification-october-2026),
  [explainer](https://github.com/WICG/email-verification),
  [draft](https://wicg.github.io/email-verification/),
  [IETF protocol](https://datatracker.ietf.org/doc/draft-hardt-email-verification)).
  Where a site and provider adopt it, the email step that the plan's email-code sign-in
  would read disappears.

## Delegated authorization for agents

These do not sign in to sites built for people; they give an agent a scoped grant
instead of the person's session. Pateat is a compatibility layer for sites without such
an interface, so they complement it rather than replace it.

- **MCP authorization.** An earlier note covers MCP for Pateat's own service
  ([feasibility](2026-10-10-feasibility.md#optional-service-authentication-and-mcp)).
  The current MCP specification (2026-07-28) uses OAuth for HTTP
  MCP servers: authorization server discovery, step-up with `insufficient_scope`, and
  checking the `iss` of authorization responses (RFC 9207). It cites the OAuth 2.1 draft
  ([spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).
- **OAuth Identity and Authorization Chaining Across Domains.** Keeps who acts for whom
  across trust domains with token exchange and JWT assertions. Revision 17 is in the RFC
  Editor queue (awaiting first editor), not yet an RFC
  ([datatracker](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/)).
- **AAuth.** An authorization protocol designed around agents; revision 11 of
  2026-09-25 is an individual Internet-Draft, not an IETF consensus document
  ([datatracker](https://datatracker.ietf.org/doc/draft-hardt-oauth-aauth-protocol/)).

## Vault exchange

FIDO's Credential Exchange Format (CXF) 1.0 is a Proposed Standard and the Credential
Exchange Protocol (CXP) a Working Draft
([FIDO](https://fidoalliance.org/download-credential-exchange-specifications/)). On
2026-09-10 Android announced moving passwords and passkeys between Google Password
Manager, 1Password, Bitwarden and Dashlane
([Google](https://blog.google/products-and-platforms/platforms/android/switch-password-managers/));
the transfer goes through Credential Manager in the CXF format, not CXP
([Android docs](https://developer.android.com/identity/sign-in/credential-transfer)).
Both are for moving a vault, not for reading one continuously, so they do not change
Pateat's Bitwarden sync.

## What each could take over

| What Pateat infers | Could be replaced by | What remains |
| --- | --- | --- |
| Finding the inputs and the sign-in entry | Correct `autocomplete`, `<login>`, WebMCP | Sites adopting them; older sites |
| Choosing password, passkey or SSO | Immediate UI, FedCM and its agent extensions | Browser and vault support; the person's choice |
| Opening an email to read a code | Email Verification | The provider session, site support, other checks |
| Judging from the page that the sign-in completed | A state the site reports | No common schema or guarantee yet |
| Acting broadly with the person's session | OAuth, MCP, delegated grants | An API to call, a scope model, consent |
| Moving vault data | CXF, CXP | Continuous access, sync and decryption stay separate |

The write-up's view is that a standard interface, where one exists, should come before a
recipe, with the AI filling the gaps only where neither exists; the owner has not
decided this. Finding a structured interface would still not be permission: which origin
receives a secret, which account is used and what may be done stay with Pateat's fixed
local checks, as today. And a run that stopped, a page that looks signed in, a sign-in
the server confirmed and an action the person allowed stay separate states.

## What this means for Pateat now

- **Immediate UI requests reach Pateat's passkey wrapper.**
  [ADR 0007](../adr/0007-existing-passkey-assertions.md#admission) says requests with
  `immediate` mediation are delegated, but Chrome now signals immediate mode with
  `uiMode: "immediate"` and no `mediation`. The wrapper reads only `mediation`
  (`snapshotGetOptions` in `apps/extension/src/passkeys/page.ts`), so a passkey-only
  request with `uiMode: "immediate"` is admitted as a modal request. A request that also
  asks for `password` is still delegated (`OTHER_CREDENTIAL_TYPES`). Such a request also
  counts for the login as a passkey request outside conditional mediation
  (`options.requested` in `apps/extension/src/passkeys/runtime.ts`, sign `s5` of ADR
  0029), and `passkey.request` logs no `mediation` for it, so the check
  [ADR 0034](../adr/0034-answer-page-passkey-requests.md) plans on that field for
  `immediate` requests would not see one. Read from the code; not tried on a site.
  Follow-up on 2026-10-14: the owner chose to keep delegating these requests, and the
  page now relays them as `immediate` mediation (ADR 0007). The official Bitwarden
  extension (`bitwarden/clients` main
  [`90b2fa3`](https://github.com/bitwarden/clients/commit/90b2fa3017a0c5587377cbabf5c788b07043e333))
  does not read `uiMode` either: its page script sends every request with `publicKey`
  and without `mediation: "conditional"` to its own window, so with it installed an
  immediate request opens that window instead of failing at once, and `password: true`
  is ignored (read from the code, not tried on a site). No Bitwarden issue, pull request
  or forum topic about Immediate UI was found on 2026-10-14.
  Follow-up on 2026-10-19: the owner chose to answer them like other get requests
  ([ADR 0052](../adr/0052-immediate-ui-stored-passkeys.md)).
- **Usable only after they settle.** Agentic Federated Login, `<login>`, WebMCP and
  Email Verification are in origin trials or drafts, which the
  [platform-feature rules](../development.md#platform-features) keep out of the
  extension. What each could replace once settled is proposed in the plan's
  [to consider](../plan.md#to-consider-not-planned) list. WebMCP has no common sign-in
  schema, so reading a site's tools as a sign-in signal would need site rules
  ([ADR 0033](../adr/0033-no-site-specific-features.md)) or the AI reading untrusted
  tool text; it is left out of that proposal until a common schema exists.
- **Nothing to do.** WebOTP (Pateat has no SMS), Login Status (not readable by
  Pateat), the delegated-authorization drafts (they need the site's API) and CXF/CXP
  (vault moves, not access).

## Corrections to the pasted write-up

- Immediate UI shipped in Chrome 149 (2026-05-12). The guide updated on 2026-10-07 is
  the UX-patterns page, not the main guide.
- The Login Status API is its own specification now; FedCM references it.
- WebMCP's declarative attributes are in Chrome's documentation only, not in the
  specification.
- Android's password manager switch uses CXF through Credential Manager, not CXP.
