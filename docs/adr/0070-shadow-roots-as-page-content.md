# ADR 0070: Shadow roots are read as part of the page

Status: accepted by the owner on 2026-10-23 at 22:04 UTC, who chose to merge it once CI
passed. Built ahead of the decision under the owner's instruction of 2026-10-23 05:28
UTC to set the phases aside and build on best guesses. Earlier the same day the owner
chose to go on with it (about 11:15 UTC), to give a component's control the form that
holds the component and to read another extension's shadow roots as Bitwarden does, at
11:53 UTC to add a locator that names the hosts a field sits inside, and at 12:14 UTC to
use it only when no other locator names the field. Checked on Rakuten's real sign-in
from a cloud browser (complete, 2026-10-23 about 21:55 UTC); Reddit blocks cloud
browsers and is not yet checked on the real page. Amends the observation contract in
[the plan](../plan.md) and, for the passkey page,
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

- Every read of the page by the content script includes every shadow root in it, open or
  closed, nested ones too: the extractor's descriptions of every kind of page, the
  locators' counts, the executor's lookups and its checks around a fill or a click, the
  sign-in checks and the account-list and entry scans. A closed root is asked for only
  on a custom element or an element `attachShadow` accepts, as Bitwarden does. A shadow
  tree is read right after its host and before the host's own children, as Bitwarden's
  tree walker visits it; a selector still matches within one tree.
- An `id`, `name`, `data-testid`, `data-test`, `autocomplete` token, visible name or
  text names an element when exactly one element of the whole page, shadow trees
  included, carries it, as before; Reddit's fields are
  `{ "by": "name", "value": "password" }`. Only an element of a shadow tree that no such
  locator names gets one `within` its hosts (owner, 2026-10-23 11:53 and 12:14 UTC): an
  `id`, `name`, `data-testid`, `data-test`, `autocomplete` or visible-name locator with
  `within`, one to three hosts outermost first, each named by its `id`, `name`,
  `data-testid` or `data-test`, as
  `{ "by": "id", "value": "input", "within": [{ "by": "id", "value": "login-pw" }] }`
  for an input whose ID every component reuses. The first host is the one element of the
  page carrying its value, each later one the one element of the previous host's shadow
  tree (nested trees included), and the field the one element of the last host's tree;
  the extractor picks the fewest hosts, nearest the field first. A host's value follows
  an element's own rules (no generated or changing ID, no token, no redacted text), the
  username check, the passkey registration check and the account-text refusal read it as
  well, and text, accessible-name and link-path locators take no hosts. An inner ID
  another load may change is never looked for inside hosts; the element keeps it as the
  last resort it was. The change only adds a field to the recipe format, so stored
  recipes stay valid; the service, deployed from `main`, takes it before an extension
  sends it, and an extension older than this change refuses a recipe that carries it, as
  it refuses any recipe format it does not know.
- A control in a shadow tree without a form owner of its own belongs to the `<form>`
  that holds its component's host, for the observation's groups, the login forms, the
  fill's one-form rule, the checks of a form's inputs, the form Enter submits (ADR 0064)
  and the sign-in form a `password-form-name` locator looks in (ADR 0072). One with its
  own form in the shadow tree belongs to that form.
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
  checks the page first. For each name of a custom element the page has not defined yet,
  the page's main world waits for its definition (`customElements.whenDefined`, as the
  isolated world has no `customElements`) and the watch checks the page at the next
  frame once it is defined, as an element defined late may attach its root then; a name
  a page never defines costs nothing ([ADR 0082](0082-waits-on-signals.md)). Until
  2026-11-03 the watch counted the undefined elements every half second instead, for ten
  seconds after the count last changed.
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
  service in cloud Chromium. Rakuten's real sign-in
  (`login.account.rakuten.com/sso/authorize`), observed from a cloud browser on
  2026-10-23, is complete with `{ by: "id", value: "user_id" }` and its button
  `cta001`; Reddit's blocks cloud browsers and has not been checked on the real site.
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
  form are left out as above. No element records which extension made it, and skipping a
  root that loads a `chrome-extension://` URL would also skip a site's own field that a
  password manager decorated with its icon, so no root is skipped (owner, 2026-10-23).
  The amendment of 2026-11-04 below leaves out one kind: a closed root laid over the
  page right under the `<body>` or `<html>` element.
- A page's software keyboard (ADR 0067) is still looked for in the document's own tree
  only, as its locator by position walks the document's elements; a keypad drawn in a
  shadow tree is not found, and its field is described as any read-only field is. No
  such page has been seen.
- Frames stay separate documents, each with its own content script, as before.

## Alternatives

- Keep the gaps: Reddit and Rakuten are never generated, while Bitwarden fills both.
- Open shadow roots only: simpler, but a closed root's fields, which Bitwarden fills,
  stay invisible and its controls cannot be told from the page's own.
- No locator with hosts (Bitwarden needs none, and Reddit's fields have unique names):
  the owner chose to add one for fields that no other locator names.
- Hosts on every shadow tree's element: a recipe would break whenever a site rebuilt
  its components, and Reddit's recipes would change for nothing.

## Amendment 2026-11-04: another extension's overlay is no part of the page

**Problem.** On 2026-11-04 at 12:00:26 UTC in the owner's Chrome, Notion's login reached
`/` while the page was still its empty loading shell. Its judged description held only
two buttons, `{ "by": "id", "value": "claude-static-chat-button" }` and
`{ "by": "id", "value": "claude-static-close-button" }`, and the near text "Claude is
active in this tab group": the Claude in Chrome extension's indicator, not Notion's. As
the page described something, the read again of ADR 0027's amendment of 2026-11-04 did
not apply; the judge answered `unclear` and the login ended authenticated but
unconfirmed. The production request log holds 13 judge requests from 2026-10-12 to
2026-11-04 with the same two buttons among their candidates (GitHub, Oracle Cloud,
UniSuper, Microsoft, Resend, Wise and Notion). Claude in Chrome 1.0.105
(`agent-visual-indicator.js`, read from the Chrome Web Store package on 2026-11-04)
draws its indicator, its "Stop Claude" button, its cursor and its glow in one closed
shadow root on a `<div>` it strips of every attribute and keeps as the body's last child
(the `<html>` element's when there is no body).

**Decision** (Claude, 2026-11-04, built as the owner allowed on 2026-10-23 05:28 UTC; it
narrows the owner's choice of 2026-10-23 above that no root is skipped, for the reason
below):

- A closed shadow root is no part of the page when its host sits right under the
  `<body>` or the `<html>` element and is no custom element the page defined
  (`:defined`): a built-in element such as a `<div>`, or a custom element name nothing
  defined. Every read of the page leaves it out as one that has no shadow root, as the
  rest of this ADR reads every other root: the extractor's descriptions of every kind of
  page, the text near buttons and fields, the locators' counts, the executor's lookups,
  the focused element, the sign-in checks and the page watch.
- Why this shape: a content script's world has no `customElements`, so an extension's
  content script commonly draws its UI on a built-in element or an undefined name, and
  appends that host where the page's own layout does not reach, under the body or the
  `<html>` element, closed so the page's scripts cannot read it. A page's own component
  is commonly a custom element it defined, and its sign-in sits inside the page's
  layout; neither is left out. It reads only the page's structure, never a name of an
  extension, and no element or URL of one is listed.
- An open root there, a closed root anywhere deeper, and a custom element an extension
  defined from a script in the page's main world are still read, as is UI an extension
  draws without a shadow root; earlier Claude in Chrome builds drew the same
  indicator in the document's own tree, as the requests of 2026-10-12 to 2026-10-20
  show, and those are not left out.

**Consequences.**

- Notion's loading shell with only Claude in Chrome's indicator describes nothing
  (`no-candidates`), so ADR 0027's amendment of 2026-11-04 reads it again once Notion
  shows its own content, and the judge never sees the indicator's buttons on any page.
- A field in such a root is never filled, nor does it make a signed-in page still look
  signed out: Pateat never types a vault value into another extension's UI.
- A site's own closed root on a `<div>` right under the body, as a third-party widget
  may draw, is not read either; a sign-in drawn there would not be found. The rule holds
  in each frame too (ADR 0017), so a widget's frame whose sign-in sits in a closed root
  on the frame body's `<div>` is not found either. None has been seen, and no log code
  records that a root was left out. A declarative closed root on a custom element the
  page has not defined yet is left out until its definition loads.
- The owner's choice of 2026-10-23 not to skip a root that loads a `chrome-extension://`
  URL stands: this rule reads no URL and never leaves out a root inside the page's
  layout, where a password manager's icon beside a site's field sits.
