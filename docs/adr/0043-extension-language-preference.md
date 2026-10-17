# Extension language preference

Status: Proposed, provisional implementation choices by Codex under the owner's
instruction to proceed autonomously. The owner may revise these choices; they are not
individually confirmed or adopted. i18next with react-i18next was already chosen by the
owner on 2026-10-12 at 14:31 UTC. The infrastructure, selector, popup and chooser are
implemented; the wider translation gate remains open. Amends no ADR.

Date: 2026-10-17

## Context

The [phase 3 translation work](../plan.md#phase-3-public-release) calls for English
and Japanese extension UI and a language setting. The libraries are chosen, but
storage and the initial language were undecided. This slice adds the infrastructure,
the language setting, the toolbar popup and the passkey chooser; other UI and user
documentation still need translation.

## Decision

Provisionally, keep `system`, `en` or `ja` in the extension origin's `localStorage`
under `pateat.language`. Like the theme, this is a presentation preference per
browser profile, independent of service pairing, vault state and synced policy.
The default follows the browser's preferred languages, choosing the first supported
English or Japanese language and falling back to English. Invalid stored values
behave like the default. If storage is unavailable, a selected language lasts until
the page closes. Other open extension pages follow the `storage` event.

Bundle English and Japanese catalogs with i18next; never fetch translations from a
service. React renders interpolated vault labels and hostnames as text. Unsupported
status codes remain visible as diagnostic codes. The popup and chooser set their HTML
language and document titles before rendering and follow later changes. The settings
page remains English except for the language selector in this initial slice.

### Rollout update, 2026-10-17

The Bitwarden connection cards, vault-access controls, setup and manual verification,
custom-field review and connection notices now use bundled English and Japanese
catalogs. Existing source strings remain the translation keys. Notices retain their
source message and interpolation until render, so language changes preserve pending
operations, form drafts and focus. Account and field names, hostnames and unknown
diagnostic codes stay literal interpolated text. Sync timestamps use the selected UI
locale and the browser's time zone. This extends the same language policy; it adds no
storage, permission or login-policy choice. Other settings sections remain follow-up
work, and the complete Japanese-language acceptance gate remains open.

## Consequences

Language can be changed without pairing or changing login policy. No browser
permission, messaging contract or service API is added. Different profiles and the
service's own pages do not share the preference. Options, diagnostics, toolbar
background titles, manifest metadata and user documentation remain follow-up work;
this is not completion of the phase 3 Japanese-language gate.

## Alternatives

- A synced settings field would share the preference between devices, but couples
  presentation to service availability and changes the policy schema.
- `chrome.storage.local` could also retain a per-device choice, but would add
  asynchronous initialization for no current background translation consumer.
- English by default is predictable but does not follow the user's browser setting.
