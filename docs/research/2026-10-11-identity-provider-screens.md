# Identity provider screens during sign-in

Researched: 2026-10-11, from identity provider and relying party documentation only. No
site or account was signed in to. It is the research behind
[ADR 0026](../adr/0026-sign-in-through-identity-providers.md), which records the owner's
decisions; this note keeps the per-provider detail and sources that the ADR summarizes.
It grants no capability.

Each claim is marked: **[D]** documented by the vendor, **[3P]** third-party source,
**[I]** inferred and needing a live check.

## Findings

1. With an existing grant and session, most identity providers (IdPs) return to the site
   without showing a page: Google [3P], GitHub [D], Okta, Auth0 and Keycloak with stored
   consent [D], LINE [D] and Microsoft [D]. The pages that do appear are account
   choosers, "Stay signed in?" (Microsoft, Okta), LINE's 「次のアカウントでログイン」,
   and Apple's Face ID or password check.
2. The relying party (the site) can force a permission page with `prompt=consent`
   (Google, Microsoft, Auth0, Okta, LINE, Yahoo! JAPAN) [D]. That page looks the same
   as a first-time grant, so stopping on every permission page is safe but can stop
   when nothing new would be granted.
3. Some sites create an account on the first return without any page, such as Slack
   with Google Workspace sign-in
   ([Slack help](https://slack.com/intl/en-gb/help/articles/204078066-Google-Workspace-single-sign-on))
   [D]. Pages on the site cannot prove that no account is created; that has to be
   decided before the sign-in starts, by acting only on sites the user configured.
4. Pages are best recognized from a list of known screens (host, path and heading),
   stopping on everything else. A button ID alone is not enough: Microsoft's
   `idSIButton9` and Keycloak's `kc-login` are used both for accepting a grant and for
   ordinary "continue" steps.

## Per identity provider

### Google (`accounts.google.com`)

- Account chooser "Choose an account" (`/v3/signin/accountchooser`; older
  `/o/oauth2/auth/oauthchooseaccount` [I]), forced by `prompt=select_account`. Its
  footer "To continue, Google will share your name, email address… with \<app\>" can
  appear on the chooser itself, so it does not mean a new grant.
- First-time "Sign in to \<app\>" permission page (`/signin/oauth/id` or
  `/signin/oauth/consent` [I]) with Cancel and Continue; not shown again unless
  `prompt=consent`
  ([OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect))
  [D]. Extra scopes show "\<app\> wants access to your Google Account" [D]. No "You're
  signing back in to \<app\>" page was found in the documentation [I].
- One Tap and FedCM are browser UI, and the Google Identity Services button is a
  cross-origin iframe
  ([FedCM migration](https://developers.google.com/identity/gsi/web/guides/fedcm-migration))
  [D].
- Google may block sign-in from browsers "controlled through software automation" or
  with "unsupported extensions"
  ([help](https://support.google.com/accounts/answer/7675428)) [D].

### Microsoft (`login.microsoftonline.com`, `login.live.com`)

- "Pick an account" when several sessions exist or with `prompt=select_account` [D].
- "Permissions requested" (work accounts) or "Let this app access your info?" (personal
  accounts) only for new permissions or `prompt=consent`
  ([consent experience](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience))
  [D].
- "Stay signed in?" (Yes / No) after sign-in, never during a consent flow
  ([KMSI](https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-stay-signed-in-prompt))
  [D].
- Pages to stop on: "More information required", admin approval, "Are you trying to
  sign in to \<app\>?" [I].

### Apple (`appleid.apple.com`)

- First time: "Share My Email" or "Hide My Email", then Continue. This creates an
  account on the site, so it is a stop signal. Returning: only Face ID, Touch ID or the
  device passcode ([Sign in with Apple](https://support.apple.com/en-us/102379)) [D].
- The form is in an `idmsa.apple.com` iframe, and two-factor codes are used.

### GitHub

- First time "Authorize \<app\>". Returning sign-ins complete without a page. The page
  is shown again for new scopes and when an app requests more than ten tokens an hour
  ([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps))
  [D]. No "continue as" page [I].

### Okta, Auth0 and Keycloak

- Okta: permission page only if the app requires it, once per scope
  ([user consent](https://developer.okta.com/docs/guides/request-user-consent/main/))
  [D]; "Stay signed in?" [D].
- Auth0: third-party apps need consent once; its `consent` screen has Accept and
  Decline [D].
- Keycloak: "Grant Access to {client}" / 「{0}へのアクセスを許可」. The
  first-broker-login pages "Account already exists" and 「既存のアカウントに追加する」
  link accounts and are stop signals [D].

### LINE

- Returning users see 「次のアカウントでログイン」 and continue. Consent is asked again
  for new scopes, `prompt=consent`, revoked consent, and for the email address after "a
  certain period"
  ([LINE Login](https://developers.line.biz/ja/docs/line-login/integrate-line-login/))
  [D]. `bot_prompt` adds an "add friend" option, which is an extra grant.

### Yahoo! JAPAN

- `prompt=consent` 「同意画面を強制表示します。」 and `prompt=select_account`
  「ID切り替え画面」
  ([YConnect v2](https://developer.yahoo.co.jp/yconnect/v2/authorization_code/authorization.html))
  [D]. No returning confirmation page is documented [I].

## The site after the return

- Zoom shows a "Create Account" welcome or "Consolidate into Account" for new Google
  users [3P]. Slack creates the account silently [D]. Notion matches existing accounts
  by email; behaviour for new users is undocumented [I].
- Likely stop signals [I]: paths containing `signup`, `onboarding`, `welcome`,
  `register`, `link` or `consolidate`; headings such as "Create account", "Account not
  found" and "Link your account".

## What a content script cannot reach

FedCM, WebAuthn and operating system prompts are not page DOM. Clicks made by a content
script carry no user activation, so SSO in popup mode (`window.open`) and FedCM active
mode are likely blocked [I]; SSO by redirect can be automated. Google's and
Microsoft's internal paths and element IDs are undocumented and may change.
