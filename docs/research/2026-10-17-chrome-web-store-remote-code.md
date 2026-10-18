# Service-held recipes and the Chrome Web Store remote code rule

Researched: 2026-10-17, from the repository at
[`217afcf`](https://github.com/risu729/pateat/commit/217afcf) (main). The question is
the risk the [plan](../plan.md#phase-3-public-release) records for a Chrome Web Store
item: whether a reviewer counts the recipes Pateat syncs from its service as "complex
commands fetched from a remote source", and what would make that less likely. Nothing
was submitted to the store, and no reviewer was asked; every verdict below is a reading
of the sources and the code.

## Sources and what could be reached

This session's network proxy refused `developer.chrome.com`, `groups.google.com`,
`adguard.com`, `theregister.com`, `palant.info` and `blog.automa.site`. The note
therefore uses:

- **Repository copies** of the Chrome documentation in
  [GoogleChrome/developer.chrome.com](https://github.com/GoogleChrome/developer.chrome.com)
  on GitHub, read in full on 2026-10-17. The policy page's front matter is dated
  2022-11-01, and these copies can lag the live site.
- **Search summaries** of pages that could not be fetched, marked "(search summary)"
  below. Their text was not read directly, so a summary is a lead, not a quotation.
- AdGuard's README on GitHub, read in full on 2026-10-17:
  [AdguardBrowserExtension](https://github.com/AdguardTeam/AdguardBrowserExtension/blob/master/README.md)
- Pateat's own code and docs at the commit above.

The live
[policy page](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
should be read again before submitting anything.

## The rule

The repository copy of
[Additional Requirements for Manifest V3](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/webstore/program-policies/mv3-requirements/index.md)
says "the full functionality of an extension must be easily discernible from its
submitted code" and that external resources "must not contain any logic". Its common
violations are a `<script>` tag pointing outside the package, `eval()` or another way of
running a fetched string, and "Building an interpreter to run complex commands fetched
from a remote source, even if those commands are fetched as data". It still allows
"Syncing user account data with a remote server", "Fetching a remote configuration file
for A/B testing or determining enabled features, where all logic for the functionality
is contained within the extension package", fetching resources such as images, and
server-side operations on data. It ends: "If our reviewers are unable to determine the
full functionality of your extension during the review process, we may reject your
submission or remove it from the store."

The live page adds that logic from a remote source may run only through a documented
API that explicitly allows it, naming the Debugger and User Scripts APIs, that the
exemption covers only the code those APIs run, and that an extension using other ways
to run remote logic elsewhere still violates the policy (search summary).

The policy defines neither "interpreter" nor "complex". The
[troubleshooting page](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/webstore/troubleshooting/index.md)
files the rule under violation ID "Blue Argon" and repeats the same three examples. The
[Improve extension security](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/migrating/improve-security/index.md)
guide lists two accepted designs that matter here: "Configuration-driven features and
logic", where a cached remote configuration "determines which features are enabled",
and "Externalized logic with a remote service", where the extension "calls a remote web
service". The live
[Deal with remote hosted code violations](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
page defines remotely hosted code as what the browser executes from outside the package,
such as JavaScript or WebAssembly, and says data such as JSON or CSS is not included
(search summary). The
[Code Readability Requirements](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/webstore/program-policies/code-readability/index.md)
forbid obfuscation, which "also applies to any external code or resource fetched by the
extension package".

### How review works

From the repository copy of the
[review process](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/webstore/review-process/index.md):

- Review is "a combination of manual and automated systems", and enforcement depends
  on, among other things, "the discretion of the reviewer". New developers, new
  extensions, "dangerous permission requests" and significant code changes draw a
  closer look. Broad host patterns such as `https://*/*` and "a lot of code or
  hard-to-review code" are named as factors that make review take longer.
- A rejection email names the violated policy and how to appeal; appeals go through the
  One Stop Support form with the violation ID ("the reference color and element").
  Review may take longer after a rejection.
- Published items are reviewed again from time to time. A minor violation found then
  brings a warning and a deadline, a more serious one an immediate takedown. If a
  takedown stays unresolved "for several weeks, Chrome will automatically disable the
  extension" for its users, who may enable it again. Passing the first review is not a
  lasting answer.
- The
  [distribution page](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/webstore/cws-dashboard-distribution/index.md)
  says "All visibility settings have the same policy requirements and will go through
  the same review process", so a Private item limited to trusted testers is reviewed as
  a public one would be.
- The troubleshooting page also has "Functionality not working" ("Yellow Magnesium"):
  an item must do what its listing says, so a reviewer who cannot get Pateat to do
  anything may reject it on that ground instead.

## Precedent

No public case was found of a store decision on login or autofill recipes fetched as
data. Searches for workflow tools such as Automa found only its MV3 migration post,
which dropped running arbitrary code strings, and no rejection over its workflows
(search summary).

The closest precedent is AdGuard. Its README says "Due to the transition from MV2 to
MV3, we cannot update our filters remotely", so filter changes ship as extension
updates, and it requests `userScripts` "to let the user subscribe to custom filter lists
and evaluate rules from these lists", the documented API route. By the search summaries,
AdGuard's blog says Custom filters were made temporarily unavailable and the Quick Fixes
filter removed because the rule's wording is broad enough to cover ad-blocking rules,
and The Register (2025-02-07) reports five rejections, citing the remote Quick Fixes
download and later scriptlets with parameters (search summary). A scriptlet is a
function shipped in the package and named by a rule with arguments. That is structurally
what a Pateat recipe step is, so this precedent is the main reason not to call the risk
low. AdGuard's filter rules can carry much more than recipes, such as CSS selectors and
scriptlets that change a page's JavaScript.

Wladimir Palant's "Malicious extensions circumvent Google's remote code ban"
(2025-01-20) documents malicious store extensions working around the rule (search
summary). Reviewers who know such patterns have reason to distrust instruction-like
JSON from a server; this is an inference, not a reported review practice.

## What Pateat fetches today

Checked against `packages/contracts/src/login.ts`, `recipes.ts`, `sync.ts` and
`generation.ts`, `apps/extension/src/service/transport.ts` and `recipes.ts`,
`apps/extension/wxt.config.ts`, and the
[architecture](../architecture.md#declarative-recipes-and-ai):

- A stored recipe is one of three strict Valibot objects: a login recipe, an entry
  recipe ([ADR 0031](../adr/0031-sign-in-entry-pages.md)) or a chooser recipe
  ([ADR 0028](../adr/0028-account-chooser-login-pages.md)). The extension parses each
  sync response (`syncRecipeChangesSchema` in `service/transport.ts`) and its cache
  (`service/recipes.ts`) with the packaged schema, and unknown members fail. Both other
  kinds already run: an entry recipe presses one link to the page's own site, and a
  chooser recipe clicks an account in a list or a button beside it, then runs one of its
  login branches.
- A login recipe's steps are `fill`, `click`, `wait` and `assert`, at most 32 per
  route variant. It may add up to three alternative variants of the password route, a
  `passkey` route, up to 16 `passkey` or `totp` second-factor handlers, up to four
  signed-in markers, an optional rejection element and account switch, and
  `maxSubmissions` of at most 8. A chooser recipe nests up to two login recipes as
  branches.
- Elements are named only by `id`, `name`, `data-testid`, an allowlisted `autocomplete`
  token, a button's text, a field's visible name, or (markers only) a same-origin link
  path. The executor compares strings; nothing becomes a CSS selector. The schema
  comment states it: "recipes cannot supply CSS, code, URLs or values".
- What a fill types comes from the vault item through a slot binding, never from the
  recipe. A recipe is bound to one exact origin and each step to an exact path on it;
  only a signed-in marker may name another origin a login moved to
  ([ADR 0022](../adr/0022-login-attempts-per-tab-and-origin.md)).
- There are no loops, conditions, variables, expressions or jumps. Which handler runs
  is decided by packaged code from the page and the item's facts (ADR 0027).
- The judge's answer about a page after a submission is a status from a fixed set
  (`signed-in`, `rejected`, `challenge`, `unclear`, or a failure), with a new recipe
  revision when it learned a marker or a handler (`recipeCompletionResultSchema` in
  `generation.ts`). Such a revision passes the same recipe schema, and a running login
  may take it over, so recipes can change between and during logins without an
  extension update.
- The packaged code needs no remote code at all: the Bitwarden SDK's WebAssembly is
  bundled, and the extension pages' CSP is `script-src 'self' 'wasm-unsafe-eval'`.
- Recipes are generated with Claude on the owner's service
  ([ADR 0014](../adr/0014-claude-generation-provider.md)) and stored as owner-scoped
  rows in its D1 database
  ([ADR 0013](../adr/0013-service-held-recipes-and-settings.md)). The service "is not
  opened to other people", so for a store user recipes would come from a service they
  run, or from the planned mode without the service and with direct AI calls, which is
  not designed yet and might get recipes from a model API directly.

## Assessment

For the recipes being data rather than commands:

- The vocabulary is four packaged operations with bounded parameters and no control
  flow. That is closer to "a remote configuration file … where all logic for the
  functionality is contained within the extension package" than to an interpreter, and
  every behaviour a recipe can cause is visible in the package's executor.
- A recipe is the user's own data on a service the user pairs, which matches "Syncing
  user account data with a remote server". The developer does not push recipes to
  every install.
- Google's own guide offers "Externalized logic with a remote service" as an accepted
  design, which covers the service deciding what a page is.
- Recipes are plain JSON, so the readability rule for fetched resources holds.

Against it:

- The rule is written for data too ("even if those commands are fetched as data") and
  leaves "complex" undefined. Recipes are ordered steps that an executor runs one by
  one on any HTTPS site, and which button a login presses on a given site is not
  discernible from the package alone.
- AdGuard's reported scriptlet rejections show a reviewer counting a packaged function
  named by remote data, with remote parameters, as remote logic.
- Recipes written by an AI on a server can read as the server steering the extension,
  and the malicious extensions Palant describes make instruction-like data suspect.
- If the mode without the service gets recipes from a model API instead of the user's
  own service, the "user account data" argument weakens, so designing that mode reopens
  this question. Entry and chooser recipes, which press links and list entries, need
  the same explanation as login recipes.
- A reviewer without a Pateat service sees an extension that does nothing, which
  invites "Functionality not working" unless the submission explains how to test it.

The risk is real but not decisive in either direction, and the documentation cannot
settle it; only a review can. A rejection would cite "Blue Argon". A later warning or
takedown of a published item is the costlier outcome, because an unresolved takedown
ends with Chrome disabling the extension for its users.

## What would lower the risk

In order of value for the effort:

1. **Keep the vocabulary closed.** Add no control flow, expressions, variables, CSS or
   XPath selectors, URLs beyond exact same-origin paths, typed values or script names
   to the recipe schema, and treat any schema change that would add one as re-opening
   this question. The architecture already forbids "eval, remote JavaScript, arbitrary
   fetch, or model-selected secret destination"; this would extend it to
   expressiveness.
2. **Explain recipes in the submission.** State in the reviewer notes and the store
   description that recipes are the user's own settings synced from a service the user
   pairs, that they are parsed against a packaged schema, and which file holds it, with
   a link to the public source and the [Corresponding Source](../sdk-source.md) for the
   bundled WebAssembly. Say how a reviewer can see a login work. The policy's own test
   is whether reviewers can "determine the full functionality", so an explanation
   answers the rule directly.
3. **Ask the store early.** Once a store build exists and before investing in
   store-specific work, the owner could submit a Private item for trusted testers,
   which is reviewed like a public one. It uses the owner's real developer account, so
   it is the owner's call. The owner has already accepted the store-assigned ID and the
   privacy policy and Limited Use statement it needs. A rejection there costs a slower
   next review, not users.
4. **Make the package easy to read.** WXT 0.21.4 turns minification off only for its
   dev server, and the repository sets no `minify`, so a production build is minified
   by Vite's default. Minification is allowed, but the review page suggests
   "submitting your code as authored" where possible; an unminified store build costs
   size only.

Not recommended:

- **The User Scripts API.** It is the documented exemption, but it exists for scripts
  the user provides and works only after the user turns on a toggle in Chrome (search
  summary). Recipes are not user scripts, and turning them into code would give up the
  property that makes them defensible.
- **Bundling recipes in the package.** Every new site would need a store update, which
  defeats per-owner generation.

If the store still refuses, GitHub Releases stays the only channel, as the plan says,
and the appeal goes through One Stop Support with the violation ID.
