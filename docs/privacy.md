# Privacy policy and Limited Use statement

Last updated: 2026-10-17. This describes the implementation in this repository for
Pateat, an unreleased Chrome extension. The current service is private to its owner;
this page does not offer public service access or claim legal or Chrome Web Store
approval. A self-hosted service has its own operator, infrastructure and retention
settings. Review this policy against the build and operator before distributing it.

## What Pateat uses and where it goes

Pateat completes configured sign-in flows with the user's Bitwarden vault. Site
access lets it inspect sign-in pages, fill approved fields, press sign-in controls
and answer eligible passkey requests. Access does not mean that every page's content
is uploaded. The current data paths are:

| Data | Destination and purpose |
| --- | --- |
| Bitwarden account setup, authentication and encrypted vault sync | The configured Bitwarden servers. Pateat decrypts the vault locally with the official OSS SDK. |
| Vault passwords, custom-field values, TOTP seeds, software passkey private keys and unlock material | Local extension processing and storage. Approved field values are filled into the configured site's page; passkey assertions go to that site's WebAuthn request. These vault secrets are excluded from the settings/recipe service and model inputs. |
| Encrypted vault cache, retained unlock key and provider access/refresh tokens | Extension-origin storage on the device, so the cache can unlock and sync across browser restarts. The retained key is usable on that device; this is not OS-keystore protection. Master passwords are not persisted in the cache. |
| Site policy, selected account references, field exclusions, settings profiles, recipe documents and revisions | The paired Pateat service, stored server-readable in Cloudflare D1, and a local extension cache for offline use. Account references and origins are metadata and can reveal which sites or accounts are configured. |
| Pairing identity and device metadata | Cloudflare Access authenticates the service login. The service records the identity's issuer and subject, a device label, pairing/last-use times and a hash of the device credential. The credential itself stays on the device after pairing. Service login does not unlock Bitwarden. |
| Sanitized page observations for recipe generation and completion judging | The paired service and Anthropic's Claude API, under the service owner's configured credentials. The service stores a request log with the sent instructions/input, validated structured result, outcome, usage and estimated cost. |
| Diagnostics | A local extension log and diagnostics page. Reports or log exports leave the device when the user copies, downloads and shares them. There is no automatic upload of the local diagnostics log. |

The extension also requests the service's health and device status and the configured
Bitwarden server's public configuration for diagnostics. Infrastructure providers
necessarily receive connection information such as IP addresses when contacted;
this policy does not promise deletion from their independent operational logs.

## Page observations and their limits

Model inputs are allowlisted page descriptions, rather than raw HTML, screenshots,
audio or video. They can include the page origin and redacted path, title, headings,
field labels, placeholders, descriptions and stable locators, sign-in controls,
account-choice text and limited text used to judge a completed sign-in. They include
allowed slot names and coarse username shape hints, rather than vault field values.
Query strings and fragments are excluded. Token-like path segments become `[id]`.
Email-like text, masked values and long digit runs are redacted; completion judging
redacts numbers of any length. Known matching usernames of at least three characters
are hidden or keep an unsafe page from being sent.

Redaction is heuristic. Names, short usernames, personal subdomains, unrecognized
path tokens or other private text in labels and locators can remain. Sign-in entry
pages do not receive the same matching-username redaction as login/judged pages.
Model requests and service-stored recipes must therefore be treated as potentially
sensitive. The precise collection rules and known limits are in
[AI input boundaries](architecture.md#declarative-recipes-and-ai), including the rule for
text behind an open modal on a judged page.

## Retention and controls

- Site exclusions and field/item policies control what Pateat may inspect or use.
  Restrict Chrome site access or disable the extension to stop its access on a site.
- Deleting a Bitwarden connection removes that connection's local vault/session
  records. Disabling automatic unlock forgets its sync session. These are local
  actions, not a Bitwarden server logout or deletion of the remote vault.
- Service device credentials expire after 90 days without use. Revoke a device in
  the service's device list, or unpair it in the extension. Revocation stops service
  access; it cannot erase a lost device's offline cache or retained unlock key.
- Local diagnostic entries normally age out after 14 days; debug entries after
  24 hours. Entry limits can evict them sooner, and pruning occurs on use. Debug
  logging expires after 24 hours. **Clear logs** deletes entries and replaces the
  pseudonym key. Downloads may reveal full site origins and paths when enabled;
  preview and review a report before sharing it.
- The service prunes inference-log rows older than 90 days when a call is logged
  and when recipes are fetched. There is no scheduled purge; an idle database may
  retain older rows until that activity occurs. Recipe history keeps the newest
  10 revisions; revocation leaves a tombstone. Other owner/settings/device metadata
  has no automatic age-based deletion in the application.
- There is no implemented self-service deletion of all service-held owner data.
  Contact the operator for deletion and its infrastructure backup policy. Revoking
  a recipe or device is not account erasure. Separately delete downloaded reports
  and browser-profile backups when no longer needed.

Pateat does not implement advertising, sale of user data, or cross-owner recipe
sharing. The current model calls serve sign-in recipe generation and completion
judging. Anthropic and Cloudflare process information through their own services;
this repository does not establish their independent retention or model-training
terms. Operators must check the terms for their actual accounts.

## Limited Use statement

Pateat's use of information received from Google APIs will adhere to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data),
including its Limited Use requirements. Pateat uses browsing/page information only
to provide the described sign-in features, local diagnostics and settings/recipe
sync. It does not use that information for advertising or sell it, and transfers
page observations only along the feature's service/model path described above.

This statement is a publication commitment, not a finding that the current build
satisfies every store requirement. Public distribution still needs the release
checks in the [plan](plan.md#phase-3-public-release), accurate store disclosures and
a policy URL appropriate to the distributed build. Store review of service-held
recipes is a separate open gate.

## Contact

For questions about this repository's implementation or a privacy request, contact
[the maintainer](https://github.com/risu729) or use the
[repository issue tracker](https://github.com/risu729/pateat/issues) without including
credentials, account identifiers or private logs. For a self-hosted installation,
contact that service's operator about its stored data.
