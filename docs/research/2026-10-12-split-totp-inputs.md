# Real sites with a TOTP code split into one-digit inputs

Researched: 2026-10-12, from the repository at `33a8ac9` (main). The phase 1 row "A
TOTP code split into one-digit inputs" lost its site when Resend turned out to have
one code input. This note records which sites' authenticator-app code pages split the
code, to find a replacement; which of them the owner uses stays in the project's
files. Nobody signed in: the code pages were read from each site's public
JavaScript or HTML, fetched without an account, from open-source code, or from public
help pages. No page was rendered after a password step, so every verdict below still
needs a real-Chrome check.

## What Pateat accepts today

A split code needs 6 to 8 inputs of one form (or of no form), each with `maxlength` 1
and an attribute locator, each accepted by the TOTP fill rule
(`autocomplete=one-time-code`, or `inputmode=numeric`, `type=tel` or `type=number`
with a `maxlength` of 1 to 10; `apps/extension/src/login/inputs.ts`), and no other
code input in that form
([ADR 0027](../adr/0027-per-account-login-routes.md#implementation-choices)). An input
without a `maxlength` attribute does not count, however it is drawn. A route is chosen
as passkey, then SSO, then password, so an item with a passkey on a site whose
sign-in page offers one never reaches the code page.

## Split inputs found

| Site | Code page | Fits today's rule | Source |
| --- | --- | --- | --- |
| ニコニコ (`account.nicovideo.jp`) | 6 inputs, `type="text"`, `inputMode="numeric"`, `maxLength=1`, `autoComplete="one-time-code"`, labels 「コード1桁目」 to 「コード6桁目」; the TOTP page names the authenticator app (「認証アプリ…により発行された確認コード」); the same component serves email codes | Yes | Public bundle `account.nicovideo.jp/spa/assets/CodeInput-*.js` and its MFA route (`digits:6`, `mfaType==="totp"`) |
| Grammarly (`www.grammarly.com`) | 6 inputs, `type="text"`, `inputMode="numeric"`, `autoComplete="one-time-code"`, `data-qa="txtCodes0"` to `5`; no `maxLength`; shared by TOTP and SMS | No: no `maxlength` | Public bundle `static.grammarly.com/.../vendor.js` |
| Tigerair Taiwan (`membership.tigerairtw.com`) | One Quasar `q-input` per digit, `type="number"`, `mask="#"`; no `maxlength` seen; shared by app and email codes | Probably not: no `maxlength` | Public bundle `membership.tigerairtw.com/js/2375.*.js` |
| Luma (`luma.com`) | One input per digit, `type="text"`, `inputMode="numeric"`, `autoComplete` only on the first; no `maxLength` | No: no `maxlength` | Public login bundle (`MultiCodeInput`) |
| SmartHR (`app.smarthr.jp`) | 6 inputs `otp_digit_0` to `otp_digit_5`; no `maxlength` | No: no `maxlength` | Public bundle (`OtpForm`) |
| Uber (`auth.uber.com`) | Per-digit boxes on the SMS code page; the TOTP page is assumed to share them | Unknown | Inferred; the page answered 403 |

## One input (or one real input under drawn boxes)

Checked in public or open-source code: Supabase (`SignInMfaForm.tsx`, one `code`
input), Termius, Visit Japan Web (Cognito), Lenovo ID, Typst (in-app form; `/signin`
answered 502), Figma, JetBrains (a split component exists in the bundle but not on the
TOTP form), VRChat, Vercel, Wise, マネーフォワード ID, Qantas, Logi ID (split cells
only on phone confirmation), and Stripe (six drawn boxes over one `one-time-code`
input). XServer's help page shows one box. Inferred as one input, without seeing the
page: Docker and HashiCorp (Auth0), e-Gov, Qiita, Ably, SEGA ID, Slack (split boxes
are its email confirmation page), OpenLearning, ImmiAccount, Instagram, Reddit, Canva,
Notion, Discord, X and Nintendo. Epic Games (likely split boxes) and Service NSW
stayed unknown.

## Result

ニコニコ is the only site found whose code page fits the current split-input rule
exactly. Its sign-in is an email and password, so a login on the password route
reaches the code page. Its real-Chrome check is the next step. Grammarly,
Tigerair Taiwan, Luma and SmartHR draw one input per digit without a `maxlength`
attribute, so Pateat would not treat them as a split code today.
