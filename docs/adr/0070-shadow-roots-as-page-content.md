# ADR 0070: Shadow roots are read as part of the page

Status: proposed, not decided by the owner. Built on assumed decisions under the owner's
instruction of 2026-10-23 05:28 UTC to set the phases aside, build on best guesses as
unmerged PRs and judge them later. Implemented in the extension (local and cloud
Chromium tests only; not yet checked on the real sites or in the owner's Chrome). Amends
the observation contract in [the plan](../plan.md) and, for the passkey page,
[ADR 0053](0053-passkey-only-generation.md).

Date: 2026-10-23

## Context

The content script read only the document's own tree. A fillable field in any shadow
root marked a login page incomplete (`shadow-field`), as did another control in a shadow
root inside a login form (`shadow-control`), so inference never received such a page,
and the executor's locators could not find an element inside one anyway.

- Reddit's sign-in (`https://www.reddit.com/login/`, 2026-10-23 about 06:00 UTC, cloud
  Chromium, build `381116f`): its username, password and two one-time-code inputs each
  sit in the open shadow root of a `<faceplate-text-input>`, outside any `<form>` of the
  document. The extractor found no field and refused the page (`no-candidates`), so it
  was never generated.
- Rakuten's sign-in (`login.account.rakuten.com/sso/authorize`) was logged
  `incomplete-observation` with `shadow-control` by the real-page corpus.

The official Bitwarden extension collects and fills fields in shadow roots, open and
closed: its `DomQueryService`
([dom-query.service.ts at `dd4d858`](https://github.com/bitwarden/clients/blob/dd4d85816be0bed40c92d0890d6e7f1a497a85e8/apps/browser/src/autofill/services/dom-query.service.ts))
walks each element's `shadowRoot` and, for a custom element or an element `attachShadow`
accepts (`SHADOW_ROOT_CANDIDATE_NODE_NAMES`), the closed root that
`chrome.dom.openOrClosedShadowRoot` gives a content script.

## Decision

All of the following is assumed, not confirmed by the owner.

- Every read of the page by the content script includes every shadow root in it, open or
  closed, nested ones too: the extractor's descriptions of every kind of page, the
  locators' counts, the executor's lookups and its checks around a fill or a click, the
  sign-in checks and the account-list and entry scans. A closed root is asked for only
  on a custom element or an element `attachShadow` accepts, as Bitwarden does. A shadow
  tree is read right after its host and before the host's own children, as Bitwarden's
  tree walker visits it; a selector still matches within one tree.
- Locators do not change and no new kind is added: an `id`, `name`, `data-testid`,
  `autocomplete` token, visible name or text names an element when exactly one element
  of the whole page, shadow trees included, carries it. A recipe does not record which
  component holds a field. An inner ID that every component reuses, as Reddit's do, is
  no locator; the field's `name`, `autocomplete` token or visible name is used instead.
- A control in a shadow tree without a form owner of its own belongs to the `<form>`
  that holds its component's host, for the observation's groups, the login forms, the
  fill's one-form rule and the checks of a form's inputs. One with its own form in the
  shadow tree belongs to that form.
- Text is read as it renders: a host's shadow tree instead of its children, a slot's
  assigned nodes instead of its fallback. An ID named by `aria-labelledby`,
  `aria-describedby` or `aria-errormessage` resolves in the referring element's own
  tree, as the browser resolves it. An ancestor that hides an element (`hidden`,
  `inert`, `aria-hidden`), a landmark, a live region, a form or a link around it counts
  across shadow boundaries, through each tree's host, and so do the page's focused
  element and the page behind an open modal at the top of a shadow tree.
- The page watch observes each shadow root it finds whenever it checks the page, and the
  submit listener listens on each, as neither a document's observer nor a `submit` event
  crosses into or out of a shadow tree. Attaching a shadow root is no change an observer
  reports, so a sign-in input in a root attached with no other change is found at the
  latest when the page's offer is decided (once its DOM is quiet, ADR 0057), which then
  checks the page first. While custom elements of the page are not yet defined, the
  watch counts them every half second and checks the page when the count changes, as an
  element defined late may attach its root then; it stops once the count stays the same
  for ten seconds and starts again only for another count, so elements a page never
  defines cost nothing after that.
- Form destinations (ADR 0051): a field or submit control in a component's shadow tree
  is checked against its own form and every form that holds the component, as the
  component may submit its value with any of them. Each form's destination is checked on
  its own, so one the background allows by the vault item hides no other; a `formaction`
  counts only on the form's own controls.
- The log codes `shadow-field` and `shadow-control` are removed: a shadow tree's control
  now makes a page incomplete only for a reason that a control of the document would.

## Consequences

- A synthetic page built like Reddit's (inputs in shadow roots outside any form, each
  root reusing the inner ID `input` and labelling by it) is described with
  `{ by: "name", value: "username" }` and `{ by: "name", value: "password" }` and the
  labels read from the shadow trees, complete. The packaged-extension test's
  `?button=shadow` sign-in, with the password input in an open shadow root and the login
  button in a closed one, is generated, filled and judged signed in by the synthetic
  service in cloud Chromium. Neither Reddit nor Rakuten has been checked on the real
  site yet.
- A query reads every shadow tree, and asking an element for a closed root costs more
  than reading `shadowRoot`. One read of the page (an extraction, the page watch's
  check, the offer's decision, or the executor's observation of its targets) asks each
  element for its closed root once and looks each tree's hosts up once; a query under
  one element outside such a read asks only that element's own.
- Sites whose sign-in widgets are web components (Lit, Stencil, Salesforce Lightning and
  the like) can be generated and filled. A cookie banner's or chat widget's controls in
  a shadow root are now ordinary controls of the page: beside a login form they are left
  out as any other form's controls are, but on a page whose login has no form they join
  its fields, as such controls of the document's own tree already did: a banner's select
  away from the fields is left out (#878), and so is its check box with no locator
  unless it is required (#892); a required one makes that page incomplete
  (`unlocated-checkbox`).
- Another extension's UI in a closed shadow root on the page (a password manager's or a
  translator's) is read as well, as Bitwarden reads it; its fields outside the login
  form are left out as above.
- Frames stay separate documents, each with its own content script, as before.

## Alternatives

- Keep the gaps: Reddit and Rakuten are never generated, while Bitwarden fills both.
- Open shadow roots only: simpler, but a closed root's fields, which Bitwarden fills,
  stay invisible and its controls cannot be told from the page's own.
- A locator that names the component as well (for example the host's ID and then the
  field's): a new recipe shape that Bitwarden does not need, and the existing locators
  already name Reddit's fields once the whole page counts.
