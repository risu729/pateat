import { bitwardenJa } from "./bitwarden-ja";
import { diagnosticsJa } from "./diagnostics-ja";
import { serviceJa } from "./service-ja";
import type { en } from "./en";
import { settingsJa } from "./settings-ja";

export const ja = {
  ...bitwardenJa,
  ...settingsJa,
  ...diagnosticsJa,
  ...serviceJa,
  Language: "言語",
  "Browser setting": "ブラウザーの設定に従う",
  Pateat: "Pateat",
  "Pateat passkey sign-in": "Pateat：パスキーでログイン",
  "Passkey request ended": "パスキーのリクエストが終了しました",
  "The site stopped waiting, or Pateat restarted. Close this window and try again.":
    "サイトの待機が終了したか、Pateat が再起動しました。このウィンドウを閉じて、もう一度お試しください。",
  Close: "閉じる",
  "Sign in to {{host}}": "{{host}} にログイン",
  "You logged out of this site in this tab": "このタブでこのサイトからログアウトしました",
  "Pateat signed in here from this tab before":
    "Pateat は以前このタブからこのサイトにログインしました",
  "Replace the default account for {{host}} with this one":
    "{{host}} の既定のアカウントをこのアカウントに変更する",
  "Use this account for {{host}} from now on": "今後 {{host}} ではこのアカウントを使う",
  "Matching passkeys": "一致するパスキー",
  "{{item}} in {{account}}": "{{account}} の {{item}}",
  "Unnamed item": "名前のないアイテム",
  Default: "既定",
  "Use the browser or another extension": "ブラウザーまたは別の拡張機能を使う",
  "Pateat on this site": "このサイトで Pateat を使う",
  "{{item}}, ID {{id}}": "{{item}}、ID {{id}}",
  "Saving…": "保存中…",
  "Changed elsewhere and reloaded. Nothing was changed.":
    "別の場所で設定が変更されたため、再読み込みしました。今回の変更は保存されていません。",
  "The change could not be saved": "変更を保存できませんでした",
  "The change may not have been saved. Reopen this popup to see the saved settings.":
    "変更が保存されていない可能性があります。保存された設定を確認するには、このポップアップを開き直してください。",
  "Starting the login…": "ログインを開始しています…",
  "Logging in with {{name}}. It becomes the default once the login succeeds.":
    "{{name}} でログインしています。ログインに成功すると、既定のアカウントになります。",
  "Logging in with {{name}}": "{{name}} でログインしています",
  "The page changed, so nothing was started. Reload it to choose again.":
    "ページが変わったため、ログインを開始しませんでした。もう一度選ぶには、ページを再読み込みしてください。",
  "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab or wait up to 10 minutes, then choose again.":
    "別のタブでこのサイトへのログインが進行中か、成功していないため、このタブではログインしませんでした。そのタブを閉じるか、最大 10 分待ってから、もう一度選んでください。",
  "Pateat could not log in with {{name}} on this page. Reload the page to choose again.":
    "このページでは {{name}} でログインできませんでした。もう一度選ぶには、ページを再読み込みしてください。",
  "This page is no longer waiting for a choice": "このページはアカウントの選択を待っていません",
  "The login could not be started. Reopen this popup and try again.":
    "ログインを開始できませんでした。このポップアップを開き直して、もう一度お試しください。",
  "Loading…": "読み込み中…",
  "Pateat works on websites (HTTP and HTTPS). Open a website, then click the Pateat icon again.":
    "Pateat はウェブサイト（HTTP と HTTPS）で動作します。ウェブサイトを開いてから、もう一度 Pateat のアイコンをクリックしてください。",
  "Pateat cannot read this tab's address. It works on websites it has site access to; a page that is still loading shows this too.":
    "Pateat はこのタブのアドレスを読み取れません。Pateat が動作するのは、サイトへのアクセスが許可されたウェブサイトです。読み込み中のページでもこの表示になります。",
  "Pateat settings could not be loaded": "Pateat の設定を読み込めませんでした",
  "{{hostname}} is no longer excluded": "{{hostname}} の除外を解除しました",
  "{{hostname}} is now excluded": "{{hostname}} を除外しました",
  "Vault account": "保管庫のアカウント",
  "{{account}}, not available here": "{{account}}（ここでは利用できません）",
  "Finding the vault items that match this site…":
    "このサイトに一致する保管庫のアイテムを検索しています…",
  "Finding the vault items that match this site took too long. Wait a moment, then reopen this popup":
    "このサイトに一致する保管庫のアイテムの検索に時間がかかりすぎました。少し待ってから、このポップアップを開き直してください",
  "The matching accounts could not be listed": "一致するアカウントを表示できませんでした",
  "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync":
    "このサイトに一致する保管庫のアイテムがありません。保管庫のアイテムにこのサイトの URI またはパスキーを追加してから、同期してください",
  "This account is unavailable. Choose another one or use the settings page.":
    "このアカウントは利用できません。別のアカウントを選ぶか、設定ページを使ってください。",
  "This vault account is connected more than once. Choose the default in the settings page.":
    "この保管庫のアカウントは複数の接続に登録されています。設定ページで既定のアカウントを選んでください。",
  "{{name}} is now the default for this site":
    "このサイトの既定のアカウントを {{name}} に変更しました",
  "The default account for this site was removed": "このサイトの既定のアカウントを解除しました",
  "Remove default": "既定を解除",
  "Checking whether this page waits for an account choice…":
    "このページがアカウントの選択を待っているか確認しています…",
  "Listing the accounts that match this page…": "このページに一致するアカウントを表示しています…",
  "Choose an account": "アカウントを選択",
  "You logged out of this site in another tab": "別のタブでこのサイトからログアウトしました",
  "The site did not accept the last login in this tab":
    "このタブでの前回のログインはサイトに受け付けられませんでした",
  "The last login on this site stopped in this tab":
    "このタブでのこのサイトへの前回のログインは中断されました",
  "Another tab's login to this site is running or did not succeed. Close that tab or wait up to 10 minutes.":
    "別のタブでこのサイトへのログインが進行中か、成功していません。そのタブを閉じるか、最大 5 分お待ちください。",
  "Account to log in with": "ログインに使うアカウント",
  "Make it the default for {{hostname}}": "{{hostname}} の既定のアカウントにする",
  "Log in": "ログイン",
  "The saved default, {{title}} ({{sub}}), is not one of these accounts":
    "保存された既定のアカウント {{title}}（{{sub}}）は、この一覧に含まれていません",
  "Some vaults or items could not be checked, so the site's matches may be incomplete":
    "確認できなかった保管庫やアイテムがあるため、一致するアカウントがすべて表示されていない可能性があります",
  "Default account": "既定のアカウント",
  "No default account. With exactly one matching item, Pateat uses that item":
    "既定のアカウントはありません。一致するアイテムが 1 件だけの場合、Pateat はそのアイテムを使います",
  "Some vaults or items could not be checked, so this list may be incomplete":
    "確認できなかった保管庫やアイテムがあるため、この一覧は不完全な可能性があります",
  "Takes effect at the next login": "次回のログインから有効になります",
  "Use as default": "既定として使う",
  "Excluded by a rule for other sites too":
    "ほかのサイトにも適用されるルールにより除外されています",
  "and its subdomains": "とそのサブドメイン",
  "Change in settings for {{hostname}}": "{{hostname}} の設定を変更",
  "Change in settings": "設定で変更",
  "No logins or passkey answers on this site": "このサイトではログインもパスキーの応答も行いません",
  "This tab": "このタブ",
  "Open settings": "設定を開く",
  "the site did not accept the password": "サイトがパスワードを受け付けませんでした",
  "the steps kept failing, and the retry limit was reached":
    "手順の実行が繰り返し失敗し、再試行の上限に達しました",
  "the sign-in was already submitted as often as allowed": "ログインの送信回数が上限に達しました",
  "the result after submitting could not be judged": "送信後の結果を判断できませんでした",
  "the page did not match the recipe": "ページがレシピと一致しませんでした",
  "the page did not respond in time": "ページが制限時間内に応答しませんでした",
  "the tab moved to another site during the login": "ログイン中にタブが別のサイトに移動しました",
  "the page moved before submitting, or the extension restarted":
    "送信前にページが移動したか、拡張機能が再起動しました",
  "a value did not fit its input, so nothing was filled":
    "入力欄に適さない値があったため、入力しませんでした",
  "the page marked a filled input as invalid, so nothing was pressed":
    "入力した値がページで無効とされたため、ボタンを押しませんでした",
  "the page shows another account than the chosen one":
    "選択したアカウントとは別のアカウントがページに表示されています",
  "the page showed another account, so the login switched accounts":
    "ページに別のアカウントが表示されたため、ログインに使うアカウントを変更しました",
  "the list of accounts does not show this account": "アカウントの一覧にこのアカウントがありません",
  "the site asks for another step, such as a code":
    "サイトが確認コードなどの追加操作を求めています",
  "the site's other step was not finished": "サイトの追加操作が完了しませんでした",
  "no later page showed that the sign-in finished":
    "その後のページでログインの完了を確認できませんでした",
  "the login was cancelled": "ログインがキャンセルされました",
  "the settings or the vault changed during the login":
    "ログイン中に設定または保管庫が変更されました",
  "this site is already logged in": "このサイトにはすでにログインしています",
  "the last login on this site stopped in this tab":
    "このタブでのこのサイトへの前回のログインは中断されました",
  "the sign-in form shows, but the recipe's first step was not found":
    "ログインフォームは表示されていますが、レシピの最初の手順が見つかりませんでした",
  "the AI classified this page as a verification while signed in, or could not tell, so Pateat does not fill it; if that is wrong, revoke its recipe on the service's Sites page (/manage/sites) so the page is sent again":
    "AI がこのページをログイン中の本人確認と判定したか、判定できなかったため、Pateat は入力しません。判定が誤っている場合は、サービスのサイトページ（/manage/sites）でこのサイトのレシピを取り消すと、ページがもう一度送られます",
  "no recipe of this site starts on this page":
    "このページから始まるこのサイトのレシピがありません",
  "you logged out of this site; choose an account to log in again":
    "このサイトからログアウトしました。再度ログインするにはアカウントを選んでください",
  "several accounts match; choose one to log in":
    "複数のアカウントが一致します。ログインするアカウントを選んでください",
  "another tab's login to this site is running or did not succeed":
    "別のタブでこのサイトへのログインが進行中か、成功していません",
  "another login runs in this tab": "このタブでは別のログインが進行中です",
  "Pateat already holds as many login records as it can":
    "Pateat が保持できるログイン記録の上限に達しました",
  "Pateat could not save the login's state": "ログインの状態を保存できませんでした",
  "the recipe has no way to log in with this vault item":
    "この保管庫のアイテムでログインする方法がレシピにありません",
  "the site's sign-in link was not pressed": "サイトのログインリンクを押しませんでした",
  "the chosen account changed": "選択されたアカウントが変更されました",
  "the vault item's username could not be read, so its account cannot be found on the list":
    "保管庫のアイテムのユーザー名を読み取れないため、一覧からアカウントを見つけられません",
  "another request for this page is already being sent to the AI":
    "このページの別のリクエストを AI に送信中です",
  "the AI was asked about this page within the last 10 minutes, so it is not asked again yet":
    "過去 10 分以内にこのページを AI に送信しているため、まだ再送信しません",
  "Pateat is not connected to its service": "Pateat がサービスに接続されていません",
  "no vault item matches this site": "このサイトに一致する保管庫のアイテムがありません",
  "the vault could not be read": "保管庫を読み取れませんでした",
  "the vault connection is turned off": "保管庫の接続が無効になっています",
  "this page came right after a sign-in": "このページはログイン直後のページです",
  "the page showed no sign-in form": "ページにログインフォームが表示されていませんでした",
  "the vault item has neither a password nor a passkey":
    "保管庫のアイテムにパスワードもパスキーもありません",
  "the vault item has no password, and the recipe has no way on without one":
    "保管庫のアイテムにパスワードがなく、パスワードなしで進める手順がレシピにありません",
  "the vault item has no password": "保管庫のアイテムにパスワードがありません",
  "the site's sign-in link": "サイトのログインリンク",
  "the site's list of accounts": "サイトのアカウント一覧",
  "the rest of the site's sign-in": "サイトのログインの続き",
  "the site's sign-in page": "サイトのログインページ",
  "This site has a recipe for this page.": "このサイトには、このページに対応するレシピがあります。",
  "This site has a recipe, but none starts on this page.":
    "このサイトにはレシピがありますが、このページから始まるものはありません。",
  "This site has no recipe yet.": "このサイトにはまだレシピがありません。",
  "The AI is making a recipe for {{what}}…": "AI が{{what}}のレシピを作成しています…",
  "A page was sent to the AI for {{what}}, and no answer was recorded.":
    "{{what}}のレシピ作成を AI に依頼しましたが、応答の記録がありません。",
  "The AI made a recipe for {{what}}.": "AI が{{what}}のレシピを作成しました。",
  "The AI chose not to make a recipe for {{what}} ({{reason}}).":
    "AI は{{what}}のレシピを作成しないと判断しました（{{reason}}）。",
  "The AI could not make a recipe for {{what}} ({{reason}}).":
    "AI は{{what}}のレシピを作成できませんでした（{{reason}}）。",
  "Waiting for an answer from the AI…": "AI の応答を待っています…",
  "Not sent to the AI: {{why}}.": "AI に送信しませんでした：{{why}}。",
  "Pateat did not log in: {{why}}.": "Pateat はログインしませんでした：{{why}}。",
  "No login started: {{why}}.": "ログインを開始しませんでした：{{why}}。",
  "The sign-in could not be confirmed.": "ログインを確認できませんでした。",
  "Logged in.": "ログインしました。",
  "The site did not accept the last login; choose an account to try again.":
    "サイトが前回のログインを受け付けませんでした。再試行するにはアカウントを選んでください。",
  "Logged out of this site in this tab.": "このタブでこのサイトからログアウトしました。",
  "Waiting for you to finish the site's other step, such as a code.":
    "確認コードなど、サイトの追加操作の完了を待っています。",
  "The result is not known yet; the next pages are checked for it.":
    "結果はまだ不明です。次のページで結果を確認します。",
  "Logging in…": "ログイン中…",
  "no reason was recorded": "理由が記録されていません",
  "The login stopped: {{why}}.": "ログインが中断されました：{{why}}。",
  "The login did not succeed: {{why}}.": "ログインに成功しませんでした：{{why}}。",
  "This recipe is not made again automatically.": "このレシピは自動では作り直されません。",
  "This page": "このページ",
  "Open the detailed log": "詳細ログを開く",
  matchingAccounts_one: "{{count}} 件のアカウントがこのページに一致します",
  matchingAccounts_other: "{{count}} 件のアカウントがこのページに一致します",
  matchingAccounts: "{{count}} 件のアカウントがこのページに一致します",
  "{{title}}, {{sub}}, default": "{{title}}、{{sub}}（既定）",
  "{{title}}, {{sub}}": "{{title}}、{{sub}}",
  "{{text}}. Pateat signs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button":
    "{{text}}。Pateat がパスキーでログインするのは、ユーザー名が不要なパスキーで、ページがパスキーを求めるか、レシピがパスキーのボタンを押す場合だけです",
  "the vault item has no password, and Pateat goes on to a passkey only on a recipe with one way to sign in":
    "保管庫のアイテムにパスワードがなく、Pateat がパスキーに進むのは、ログイン方法が 1 つだけのレシピの場合だけです",
  "the vault item has no password, and the recipe neither asks for one nor goes on to another page":
    "保管庫のアイテムにパスワードがなく、レシピはパスワードを求めず、別のページにも進みません",
  "the vault item has no password, and the recipe needs another value the item lacks before it":
    "保管庫のアイテムにパスワードがなく、レシピはその前に、アイテムにない別の値を必要とします",
  "the vault item has no password, and the account fills its password from another field":
    "保管庫のアイテムにパスワードがなく、このアカウントはパスワードを別のフィールドから入力します",
  "the vault item has no password, and this page asks for it":
    "保管庫のアイテムにパスワードがなく、このページはパスワードを求めています",
  "the vault item has no password, and Pateat goes on without one only in the page itself, not in a frame":
    "保管庫のアイテムにパスワードがなく、Pateat がパスワードなしで進むのはページ本体だけで、フレーム内では進みません",
  "After a logout, Pateat only fills the sign-in form and presses nothing; sign in when you are ready.":
    "ログアウト後は、Pateat はログインフォームに入力するだけで、ボタンは押しません。準備ができたらログインしてください。",
  "The page changed, so nothing was started. {{name}} was not made the default. Reload it to choose again.":
    "ページが変わったため、ログインを開始しませんでした。{{name}} は既定のアカウントになっていません。もう一度選ぶには、ページを再読み込みしてください。",
  "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. {{name}} was not made the default. Close that tab or wait up to 10 minutes, then choose again.":
    "別のタブでこのサイトへのログインが進行中か、成功していないため、このタブではログインしませんでした。{{name}} は既定のアカウントになっていません。そのタブを閉じるか、最大 10 分待ってから、もう一度選んでください。",
  "Pateat could not log in with {{name}} on this page. {{name}} was not made the default. Reload the page to choose again.":
    "このページでは {{name}} でログインできませんでした。{{name}} は既定のアカウントになっていません。もう一度選ぶには、ページを再読み込みしてください。",
  "This page is no longer waiting for a choice. {{name}} was not made the default.":
    "このページはアカウントの選択を待っていません。{{name}} は既定のアカウントになっていません。",
  "Pateat: logged in.": "Pateat：ログインしました。",
  "Pateat: the login's result is not known ({{reason}}). Open Pateat for details.":
    "Pateat：ログインの結果が分かりません（{{reason}}）。詳しくは Pateat を開いてください。",
  "Pateat: the login did not succeed ({{reason}}). Open Pateat for details.":
    "Pateat：ログインに成功しませんでした（{{reason}}）。詳しくは Pateat を開いてください。",
  badgeUsable_one: "Pateat：このサイトのアカウントは {{count}} 件です。",
  badgeUsable_other: "Pateat：このサイトのアカウントは {{count}} 件です。",
  badgeMoreExcluded_one: "ほかに {{count}} 件が設定で除外されています。",
  badgeMoreExcluded_other: "ほかに {{count}} 件が設定で除外されています。",
  badgeMoreReview_one: "ほかに {{count}} 件が設定でカスタムフィールドの確認待ちです。",
  badgeMoreReview_other: "ほかに {{count}} 件が設定でカスタムフィールドの確認待ちです。",
  badgeMoreItemsReview_one:
    "ほかに {{count}} 件が設定で除外されているか、カスタムフィールドの確認待ちです。",
  badgeMoreItemsReview_other:
    "ほかに {{count}} 件が設定で除外されているか、カスタムフィールドの確認待ちです。",
  badgeUnknown_one: "{{count}} 件のアイテムを確認できませんでした。",
  badgeUnknown_other: "{{count}} 件のアイテムを確認できませんでした。",
  badgeExcludedSite_one:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、このサイトは設定で除外されているため使えません。",
  badgeExcludedSite_other:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、このサイトは設定で除外されているため使えません。",
  badgeExcludedItems_one:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、設定で除外されているため使えません。",
  badgeExcludedItems_other:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、設定で除外されているため使えません。",
  badgeExcludedReview_one:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、設定でカスタムフィールドの確認待ちのため使えません。",
  badgeExcludedReview_other:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、設定でカスタムフィールドの確認待ちのため使えません。",
  badgeExcludedItemsReview_one:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、設定で除外されているか、カスタムフィールドの確認待ちのため使えません。",
  badgeExcludedItemsReview_other:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、設定で除外されているか、カスタムフィールドの確認待ちのため使えません。",
  "Pateat: no account for this site.": "Pateat：このサイトのアカウントはありません。",
  "Pateat: the vault is locked, so this site's accounts were not counted.":
    "Pateat：保管庫がロックされているため、このサイトのアカウントを数えていません。",
  "Pateat: the vault has not been opened since Pateat restarted, so this site's accounts were not counted.":
    "Pateat：Pateat の再起動後に保管庫を開いていないため、このサイトのアカウントを数えていません。",
  "Pateat: the vault could not be read, so this site's accounts were not counted.":
    "Pateat：保管庫を読み取れなかったため、このサイトのアカウントを数えていません。",
  "Pateat: the vault is being updated, so this site's accounts were not counted.":
    "Pateat：保管庫を更新中のため、このサイトのアカウントを数えていません。",
  "Pateat: a login or a page check was using the vault, so this site's accounts were not counted yet.":
    "Pateat：ログインまたはページの確認で保管庫を使用中のため、このサイトのアカウントをまだ数えていません。",
  "{{first}} {{next}}": "{{first}}{{next}}",
  "Pateat: asking the AI…": "Pateat：AI に問い合わせています…",
  "Pateat: you logged out of this site in this tab. Click to choose an account.":
    "Pateat：このタブでこのサイトからログアウトしました。クリックしてアカウントを選んでください。",
  "Pateat: the site did not accept the last login in this tab. Click to choose an account.":
    "Pateat：このタブでの前回のログインはサイトに受け付けられませんでした。クリックしてアカウントを選んでください。",
  "Pateat: the last login on this site stopped in this tab. Click to choose an account.":
    "Pateat：このタブでのこのサイトへの前回のログインは中断されました。クリックしてアカウントを選んでください。",
  "Pateat: you logged out of this site in another tab. Click to choose an account.":
    "Pateat：別のタブでこのサイトからログアウトしました。クリックしてアカウントを選んでください。",
  "Pateat: {{count}} accounts match this page. Click to choose one.":
    "Pateat：{{count}} 件のアカウントがこのページに一致します。クリックして選んでください。",
  "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.":
    "Pateat：別のタブでこのサイトへのログインが進行中か、成功していません。ここでログインするには、そのタブを閉じるか、最大 10 分待ってからこのページを再読み込みしてください。",
} satisfies Record<keyof typeof en, string>;
