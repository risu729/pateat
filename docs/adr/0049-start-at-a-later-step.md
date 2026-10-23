# ADR 0049: A login may start at a later step its page shows

Status: accepted by the owner on 2026-10-18 at 01:40 UTC. On 2026-10-16 at 08:32 UTC the
owner asked 「レシピは途中のページからも始められる方がいいと思うのですが、どう？
再ログインで任意のページからログアウトしてサインインが必要になりますよね？」 (recipes
should be able to start from a page in the middle too; after a logout, signing in again
can start from any page). Shown plan A below with its press rule as a choice, the owner
answered 「1 ステップ目と同じ」 (the same as a first step). Implemented (local tests and
a synthetic end-to-end test; not yet checked on a real site). Amends
[ADR 0013](0013-service-held-recipes-and-settings.md#recipe-lookup) (an attempt starts
only at a recipe's first step),
[ADR 0016](0016-recipe-generation-trigger.md#pages-where-no-recipe-starts) (a page where
a later step shows is not sent),
[ADR 0021](0021-account-choice-outside-settings.md#d-after-a-logout-choose-again-detection-l1)
D (a later step counts as the first step does, and its known gap for sites that show
only a password step after a logout),
[ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge) (a later step
releases a watched login) and [ADR 0028](0028-account-chooser-login-pages.md) (its
branches never start mid-way).

Amended on 2026-10-23 by [ADR 0062](0062-log-in-again-after-a-logout.md) (accepted and
implemented): a later step shown after a login in the tab starts an ordinary login, as
the first step does, instead of asking.

Date: 2026-10-18

## Context

Until this ADR an attempt started only when a recipe's first step was ready on the page
(ADR 0013). A site that remembers the account, or one whose session expired, often
shows its password page alone, for example the third step of this recipe:

```json
[
  { "kind": "fill", "path": "/signin/id", "fields": [{ "slot": "username", "target": { "by": "autocomplete", "value": "username" } }] },
  { "kind": "click", "path": "/signin/id", "target": { "by": "text", "value": "Next" }, "purpose": "advance" },
  { "kind": "fill", "path": "/signin/pwd", "fields": [{ "slot": "password", "target": { "by": "autocomplete", "value": "current-password" } }] },
  { "kind": "click", "path": "/signin/pwd", "target": { "by": "text", "value": "Sign in" }, "purpose": "submit" }
]
```

On main [`5c57d42`](https://github.com/risu729/pateat/commit/5c57d42) such a page did
one of these:

- on another path in a tab where Pateat had not logged in, it was sent for generation,
  which made a second recipe starting at `/signin/pwd` (one generation's cost);
- on another path after this tab's login, or on the recipe's own start path, nothing
  ran, logged as `login.refused` `not-started` with `logged-in` or `first-step-missing`.

So signing in again after a logout did nothing, as ADR 0021 D listed among its known
gaps. Cloudflare's "Sign in with another profile" form on the list's path was one case;
[#625](https://github.com/risu729/pateat/pull/625) fixed it only for a list of accounts
(ADR 0028).

## Decision

A new login may start at a later `fill` step of a recipe's `password` variant when the
page shows that step and none of the origin's recipes' first steps. The stored recipe,
the service and the AI prompts are unchanged.

1. **Steps a login may start at.** A `fill` step after the first, of any `password`
   variant (ADR 0027), on the page's path, that fills a field other than a one-time
   code, and is ready as a first step is: each target is one writable input. A `click`,
   `wait` or `assert` step never starts a login. The step is not ready while the page
   also shows a visible, writable username or email input it does not fill (a
   `type="email"` input, or one whose `autocomplete` names a username or an email),
   since such a page asks for an account too, as Cloudflare's other-profile form with
   its email and password inputs. The branches of a chooser recipe (ADR 0028) never
   start mid-way: which branch runs depends on what was pressed on the list; the
   `other-shown` start of [#625](https://github.com/risu729/pateat/pull/625) stays as it
   was.
2. **Order.** A recipe's first step ready on the page wins, also over another recipe's
   later step, so a recipe generated for `/signin/pwd` before this ADR still starts
   there. Otherwise the recipe whose later step shows starts at the earliest such step
   of the variant chosen for the account. When later steps of two recipes show, nothing
   starts, as for two first steps.
3. **Route.** The route and variant are chosen from the item as for a first step, among
   that variant's steps. The start page's passkey button (ADR 0027), which is on the
   first page, is not offered when it does not show: an item with a passkey and a
   password starts at the later step with its password. On a recipe without a passkey
   button, a passkey request the page itself makes (ADR 0034) is still answered for an
   item that also holds a password: the answer waits on the later step's page, and a
   fallback to the `password` route returns to that step. An item with a passkey and no
   password (unless the button shows, below), an item whose variant has no showing later
   step, or one that would stop before it (ADR 0036), does not start.
4. **Pressing.** The same as a login that starts at its first step: if another account
   shows on the page, the login ends `wrong-account` (and presses the recipe's
   `accountSwitch` if it has one); otherwise it fills to the end and presses. This keeps
   the 2026-10-12 07:41 UTC constraint of ADR 0021 D, that the person is not left to
   press the site's button unless Pateat knows of a login in this tab.
5. **Logout and watch (ADR 0021 D, ADR 0027).** A later step that may start a login
   counts as the first step does after a login in the tab: it is a logout and the tab
   fills without pressing and asks (the fill-only login starts at that later step),
   ends a watched login as its first step does (ADR 0027), and asks again after a login
   stopped after its submission (`stopped-login`).
6. **Generation (ADR 0016).** A page that shows a later step that may start a login is
   not sent for generation; the existing recipe logs in. A page that matches no step is
   handled as before, and recipes already generated for such pages stay.
7. **Frames and log.** Frames follow ADR 0017 as for a first step. `login.start` logs
   `startStep`, the index of the step the login started at, for a later start.

Details added in implementation, not confirmed by the owner:

- On a page that shows the start page's passkey button beside a later step, as a page
  that shows the button at each stage, the button does not count as a first step that
  holds the later start back. The account is planned with the button as on the first
  page: one whose route is the button (ADR 0027) presses it, and any other starts at the
  later step. The button alone still starts the `passkey` route.
- A visible writable username or email input blocks a later start even when it already
  holds a value (the proposal said an empty one), since its value may name another
  account.
- No later start happens while one of the recipe's signed-in markers proves a sign-in on
  the page as ADR 0029 reads it (visible once, with its `absent` elements missing), as a
  single-page app does when it asks for the password again before a sensitive action;
  the page announces again up to its limit and is logged as `login.refused`
  `stale-document` (`gave-up` once it stops).
- The content script watches at most 32 steps, first steps before later ones.
- A single-page app may show the later step in place, in the document of the first step
  (2026-10-21, [#831](https://github.com/risu729/pateat/issues/831): Cursor's sign-in
  page moves from its email step to `/password` without loading a new document). The
  page announces a step that becomes ready on another path of the document as a new
  appearance, and after a logout the first step's fill-only login no longer keeps that
  document from being filled: a document is filled once on each path (ADR 0021 D), so
  the fill-only login starts at the later step there, as it would in a new document. The
  popup's "This page" section counts the path of a later step as a recipe on the page.
  As in a new document, a value the person types into the later step before the fill
  arrives may be replaced; the guard of
  [ADR 0035](0035-page-kinds-per-site.md)'s fill-only pages is not implemented.
- A refused later start is logged as `login.refused` `no-route` with `later-variant`
  (the chosen variant shows no later step) or `password-empty:later-start` (the login
  would stop before it). Such a refusal can come after the popup offered the account,
  since the variant is known only once the account is.

## Consequences

- Signing in again after a logout or an expired session works on a site whose next
  sign-in shows only the password page, with the recipe it already has and no
  generation cost.
- A site that shows a username the person cannot compare (such as `taro99`, not an
  email or a numeric ID) and remembered another account receives the default account's
  password once; the failed login then makes the tab ask, as ADR 0021 D describes.
- A re-authentication form ("enter your password to continue") on the same path as the
  recipe's password step starts a login in a tab without one and counts as a logout in a
  tab with one. ADR 0021 D already listed this for forms shaped like a first step; a
  password-only step makes it likelier, above all in a single-page app whose whole app
  lives on one path. [ADR 0035](0035-page-kinds-per-site.md) does not prevent it, since
  such a page uses the existing `sign-in` recipe and is never sent to be judged
  `confirm`. Accepted with the recommendation. The signed-in marker check above stops a
  new login on such a page once the recipe has a marker that proves a sign-in there; a
  recipe without one, a marker learned with the password input among its `absent`
  elements (as on a site that signs in on its own path, the single-path app above), a
  prompt that hides the marker, and the logout in a tab with a login (which fills
  without pressing) are not covered.
- Not fixed: a recipe whose one `fill` step fills both the username and the password, on
  a page that later shows only the password input (the step is only partly ready), and a
  page no step of any recipe matches.

## Alternatives

- **B. Generate a separate recipe for each mid-flow page.** Send such pages for
  generation even when a recipe starts on the path. Two recipes would start on one path,
  changing ADR 0016's one recipe per start path and the `recipe-ambiguous` rule, every
  page state would cost a generation, and recipes of one site could drift apart. The
  press and re-authentication questions stay the same.
- **C. Fix each site as it shows up**, as
  [#625](https://github.com/risu729/pateat/pull/625) did for a list. That leans towards
  site-specific work, which [ADR 0033](0033-no-site-specific-features.md) rules out.
- **Press only when the page's account matches.** The other choice on the owner's card.
  On sites that show no comparable account it fills without pressing in a tab without a
  login, against the 07:41 UTC constraint.
