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
  "Log in to {{host}}": "{{host}} にログイン",
  "Replace the default account for {{host}} with this one":
    "{{host}} の既定のアカウントをこのアカウントに変更する",
  "Use this account for {{host}} from now on": "今後 {{host}} ではこのアカウントを使う",
  "Matching passkeys": "一致するパスキー",
  "{{item}} in {{account}}": "{{account}} の {{item}}",
  "Unnamed item": "名前のないアイテム",
  Default: "既定",
  "Use the browser or another extension": "ブラウザーまたは別の拡張機能を使う",
  "Just once": "今回のみ",
  "Always for this site": "このサイトでは常に",
  "Pateat leaves passkeys on {{hostname}} to the browser. Undo it in Pateat's settings.":
    "{{hostname}} のパスキーは今後ブラウザーに任せます。Pateat の設定で元に戻せます。",
  "Bitwarden asks for your master password before this item is used.":
    "このアイテムは、使う前にマスターパスワードの入力が必要です (Bitwarden の再入力の設定)。",
  "Other passkeys": "ほかのパスキー",
  "Asks for the master password": "マスターパスワードが必要",
  "{{item}}, ID {{id}}": "{{item}}、ID {{id}}",
  "Saving…": "保存中…",
  "The settings changed elsewhere, so this change was not saved. The popup now shows them.":
    "別の場所で設定が変更されたため、この変更は保存されていません。ポップアップには変更後の設定を表示しています。",
  "The change could not be saved. Reopen this popup and try again.":
    "変更を保存できませんでした。このポップアップを開き直して、もう一度お試しください。",
  "The change may not have been saved. Reopen this popup to see the saved settings.":
    "変更が保存されていない可能性があります。保存された設定を確認するには、このポップアップを開き直してください。",
  "this vault item asks for the master password first; enter it in the window Pateat opens":
    "このアイテムは使う前にマスターパスワードの入力が必要です。Pateat が開くウィンドウで入力してください",
  "Enter the master password": "マスターパスワードを入力",
  "Opening the master password window…": "マスターパスワードのウィンドウを開いています…",
  "The master password window could not open. It opens only for the active tab outside incognito, one window at a time.":
    "マスターパスワードのウィンドウを開けませんでした。シークレットウィンドウ以外の表示中のタブでのみ、一度に 1 つ開きます。",
  "The master password window was closed before the vault item was used.":
    "アイテムを使う前にマスターパスワードのウィンドウが閉じられました。",
  "This page no longer waits for the master password. Reload it.":
    "このページはマスターパスワードの入力を待っていません。再読み込みしてください。",
  "The master password window could not open. Reopen this popup and try again.":
    "マスターパスワードのウィンドウを開けませんでした。このポップアップを開き直して、もう一度お試しください。",
  "Ask for the master password": "マスターパスワードを求める",
  "For vault items with Bitwarden's master password re-prompt.":
    "Bitwarden で「マスターパスワードの再入力」が有効なアイテムに適用されます。",
  "Set by a rule for {{hostname}} and its subdomains.":
    "{{hostname}} とそのサブドメインのルールで設定されています。",
  "{{hostname}} now asks for the master password.":
    "{{hostname}} ではマスターパスワードを求めるようになりました。",
  "{{hostname}} no longer asks for the master password.":
    "{{hostname}} ではマスターパスワードを求めなくなりました。",
  "Starting the login…": "ログインを開始しています…",
  "Logging in with {{name}}. It becomes the default once the login succeeds.":
    "{{name}} でログインしています。ログインに成功すると、既定のアカウントになります。",
  "Logging in with {{name}}.": "{{name}} でログインしています。",
  "The page changed, so nothing was started. Reload it to choose again.":
    "ページが変わったため、ログインを開始しませんでした。もう一度選ぶには、ページを再読み込みしてください。",
  "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab, or wait up to 10 minutes, then choose again.":
    "別のタブでこのサイトへのログインが進行中か、成功していないため、このタブではログインしませんでした。そのタブを閉じるか、最大 10 分待ってから、もう一度選んでください。",
  "Pateat could not log in with {{name}} on this page. Reload the page to choose again.":
    "このページでは {{name}} でログインできませんでした。もう一度選ぶには、ページを再読み込みしてください。",
  "This page no longer waits for an account choice.":
    "このページはアカウントの選択を待っていません。",
  "The login could not be started. Reopen this popup and try again.":
    "ログインを開始できませんでした。このポップアップを開き直して、もう一度お試しください。",
  "Loading…": "読み込み中…",
  "Pateat works on websites (HTTP and HTTPS). Open a website, then click the Pateat icon again.":
    "Pateat はウェブサイト（HTTP と HTTPS）で動作します。ウェブサイトを開いてから、もう一度 Pateat のアイコンをクリックしてください。",
  "Pateat cannot read this tab's address. It works on websites it has site access to; a page that is still loading shows this too.":
    "Pateat はこのタブのアドレスを読み取れません。Pateat が動作するのは、サイトへのアクセスが許可されたウェブサイトです。読み込み中のページでもこの表示になります。",
  "Pateat's settings could not be loaded.": "Pateat の設定を読み込めませんでした。",
  "Paused, as this is not an allowed site": "許可サイトではないため一時停止中",
  "Allow {{site}}": "{{site}} を許可",
  "{{site}} and its subdomains are now allowed sites.":
    "{{site}} とそのサブドメインを許可サイトにしました。",
  "Vault account": "保管庫のアカウント",
  "{{account}}, not available here": "{{account}}（ここでは利用できません）",
  "Finding the vault items that match this site…":
    "このサイトに一致する保管庫のアイテムを検索しています…",
  "Finding the vault items that match this site took too long. Wait a moment, then reopen this popup.":
    "このサイトに一致する保管庫のアイテムの検索に時間がかかりすぎました。少し待ってから、このポップアップを開き直してください。",
  "The matching accounts could not be listed. Reopen this popup to try again.":
    "一致するアカウントを表示できませんでした。もう一度試すには、このポップアップを開き直してください。",
  "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync.":
    "このサイトに一致する保管庫のアイテムがありません。保管庫のアイテムにこのサイトの URI またはパスキーを追加してから、同期してください。",
  "This account is unavailable. Choose another one or use the settings page.":
    "このアカウントは利用できません。別のアカウントを選ぶか、設定ページを使ってください。",
  "This vault account is connected more than once. Choose the default in the settings page.":
    "この保管庫のアカウントは複数の接続に登録されています。設定ページで既定のアカウントを選んでください。",
  "{{name}} is now the default for this site.":
    "このサイトの既定のアカウントを {{name}} に変更しました。",
  "The default account for this site was removed.": "このサイトの既定のアカウントを解除しました。",
  "Remove default": "既定を解除",
  "Checking whether this page waits for an account choice…":
    "このページがアカウントの選択を待っているか確認しています…",
  "Listing the accounts that match this page…": "このページに一致するアカウントを表示しています…",
  "Choose an account": "アカウントを選択",
  "The site did not accept a login in another tab.":
    "別のタブでのログインがサイトに受け付けられませんでした。",
  "The site did not accept the last login in this tab.":
    "このタブでの前回のログインはサイトに受け付けられませんでした。",
  "The last login on this site stopped in this tab.":
    "このタブでのこのサイトへの前回のログインは中断されました。",
  "Another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes.":
    "別のタブでこのサイトへのログインが進行中か、成功していません。そのタブを閉じるか、最大 10 分お待ちください。",
  "Account to log in with": "ログインに使うアカウント",
  "Make it the default for {{hostname}}": "{{hostname}} の既定のアカウントにする",
  "Log in": "ログイン",
  "The saved default, {{title}} ({{sub}}), is not one of these accounts.":
    "保存された既定のアカウント {{title}}（{{sub}}）は、この一覧に含まれていません。",
  "Some vaults or items could not be checked, so the site's matches may be incomplete.":
    "確認できなかった保管庫やアイテムがあるため、一致するアカウントがすべて表示されていない可能性があります。",
  "Default account": "既定のアカウント",
  "No default account. With exactly one matching item, Pateat uses that item.":
    "既定のアカウントはありません。一致するアイテムが 1 件だけの場合、Pateat はそのアイテムを使います。",
  "Some vaults or items could not be checked, so this list may be incomplete.":
    "確認できなかった保管庫やアイテムがあるため、この一覧は不完全な可能性があります。",
  "A default takes effect at the next login.":
    "既定のアカウントは次回のログインから有効になります。",
  "Use as default": "既定として使う",
  "and its subdomains": "とそのサブドメイン",
  "Change in settings for {{hostname}}": "{{hostname}} の設定を変更",
  "Change in settings": "設定で変更",
  "This tab": "このタブ",
  "Open settings": "設定を開く",
  "the site did not accept the password": "サイトがパスワードを受け付けませんでした",
  "the steps kept failing, and the retry limit was reached":
    "手順の実行が繰り返し失敗し、再試行の上限に達しました",
  "the login was already submitted as often as allowed": "ログインの送信回数が上限に達しました",
  "the page after submitting did not show whether it worked":
    "送信後のページでは成功したか分かりませんでした",
  "the page did not match the recipe": "ページがレシピと一致しませんでした",
  "the page did not respond in time": "ページが制限時間内に応答しませんでした",
  "the tab moved to another site during the login": "ログイン中にタブが別のサイトに移動しました",
  "the page moved on before submitting, or Pateat restarted":
    "送信前にページが移動したか、Pateat が再起動しました",
  "a value did not fit its input, so nothing was filled":
    "入力欄に適さない値があったため、入力しませんでした",
  "the page marked a filled input as invalid, so nothing was pressed":
    "入力した値がページで無効とされたため、ボタンを押しませんでした",
  "the page's software keyboard did not show a key Pateat pressed, so nothing more was pressed":
    "ソフトウェアキーボードで押したキーが入力欄に表示されなかったため、それ以上押しませんでした",
  "the page shows a different account from the one chosen":
    "選択したアカウントとは別のアカウントがページに表示されています",
  "the page showed another account, so the login switched accounts":
    "ページに別のアカウントが表示されたため、ログインに使うアカウントを変更しました",
  "the list of accounts does not show this account": "アカウントの一覧にこのアカウントがありません",
  "the site asks for another step, such as a code":
    "サイトが確認コードなどの追加操作を求めています",
  "the site's other step was not finished": "サイトの追加操作が完了しませんでした",
  "no later page showed that the login finished":
    "その後のページでログインの完了を確認できませんでした",
  "the login was cancelled": "ログインがキャンセルされました",
  "the settings or the vault changed during the login":
    "ログイン中に設定または保管庫が変更されました",
  "this site is already logged in": "このサイトにはすでにログインしています",
  "a passkey Pateat returned to this page is signing it in":
    "Pateat がこのページに返したパスキーでログインしています",
  "the last login on this site stopped in this tab":
    "このタブでのこのサイトへの前回のログインは中断されました",
  "the sign-in form shows, but the recipe's first step was not found":
    "ログインフォームは表示されていますが、レシピの最初の手順が見つかりませんでした",
  "the AI classified this page as a verification while signed in, or could not tell, so Pateat does not fill it; if that is wrong, revoke its recipe on the service's Sites page (/manage/sites) so the page is sent again":
    "AI がこのページをログイン中の本人確認と判定したか、判定できなかったため、Pateat は入力しません。判定が誤っている場合は、サービスのサイトページ（/manage/sites）でこのサイトのレシピを取り消すと、ページがもう一度送られます",
  "no recipe of this site starts on this page":
    "このページから始まるこのサイトのレシピがありません",
  "Pateat waits for you to choose an account": "Pateat はアカウントの選択を待っています",
  "Pateat logged in to this site twice in the last 10 minutes; choose an account to log in again":
    "Pateat は直近 10 分間にこのサイトへ 2 回ログインしました。再度ログインするにはアカウントを選んでください",
  "automatic login is paused on this site; choose an account to log in":
    "このサイトの自動ログインは一時停止中です。ログインするにはアカウントを選んでください",
  "automatic login is paused on this site": "このサイトの自動ログインは一時停止中です",
  "While this tab asks for an account, Pateat only fills the sign-in form and presses nothing; sign in when you are ready.":
    "このタブがアカウントを確認している間、Pateat はログインフォームに入力するだけで、ボタンは押しません。準備ができたらログインしてください。",
  "automatic login of this site was paused": "このサイトの自動ログインが一時停止されました",
  "Paused until {{time}}": "{{time}} まで一時停止中",
  "Pause automatic login": "自動ログインを一時停止",
  Resume: "再開",
  "Pausing…": "一時停止しています…",
  "Resuming…": "再開しています…",
  "Used in this tab": "このタブで使用中",
  "{{title}}, {{sub}}, used in this tab, default": "{{title}}、{{sub}}、このタブで使用中、既定",
  "{{title}}, {{sub}}, used in this tab": "{{title}}、{{sub}}、このタブで使用中",
  "The switch could not be started. Reopen this popup and try again.":
    "切り替えを開始できませんでした。このポップアップを開き直してもう一度お試しください。",
  "Automatic login on this site is paused for an hour.":
    "このサイトの自動ログインを 1 時間一時停止しました。",
  "Automatic login on this site resumed.": "このサイトの自動ログインを再開しました。",
  "This tab has no site to pause.": "このタブには一時停止するサイトがありません。",
  "The pause could not be saved. Try again.":
    "一時停止を保存できませんでした。もう一度お試しください。",
  "The pause could not be changed. Reopen this popup and try again.":
    "一時停止を変更できませんでした。このポップアップを開き直してもう一度お試しください。",
  "the account": "そのアカウント",
  "Switch account": "アカウントを切り替え",
  "Logs this tab out of {{hostname}}, then logs in with the account you choose.":
    "このタブで {{hostname}} からログアウトし、選んだアカウントでログインします。",
  "Switch to this account: {{title}}, {{sub}}": "このアカウントに切り替え：{{title}}、{{sub}}",
  "Switch to this account": "このアカウントに切り替え",
  "A site you log in to through another account, such as a company or Google sign-in, may log you out of that account too.":
    "会社や Google のログインなど、別のアカウントを通じてログインするサイトでは、そのアカウントからもログアウトされることがあります。",
  "Pateat: automatic login is off in private windows.":
    "Pateat：プライベートウィンドウでは自動ログインはオフです。",
  "Pateat: automatic login is off in private windows. Click to choose an account.":
    "Pateat：プライベートウィンドウでは自動ログインはオフです。クリックしてアカウントを選んでください。",
  "Pateat: the paused sites could not be read, so automatic login is paused.":
    "Pateat：一時停止中のサイトを読み取れなかったため、自動ログインを一時停止しています。",
  "automatic login is off in private windows; choose an account to log in":
    "プライベートウィンドウでは自動ログインはオフです。ログインするにはアカウントを選んでください",
  "automatic login is off in private windows": "プライベートウィンドウでは自動ログインはオフです",
  "Automatic login is off in private windows, and {{name}} has no password, so Pateat did not log in. To sign in with its passkey, use the page's own passkey sign-in button; Pateat logs in there when {{name}} is this site's only passkey or its default.":
    "プライベートウィンドウでは自動ログインはオフで、{{name}} にはパスワードがないため、Pateat はログインしませんでした。パスキーでログインするには、ページのパスキーログインボタンを押してください。{{name}} がこのサイトの唯一のパスキーか既定のときは、Pateat がそこでログインします。",
  "Automatic login is off in private windows, and {{name}} has no password, so Pateat did not log in. {{name}} was not made the default. To sign in with its passkey, use the page's own passkey sign-in button; Pateat logs in there when {{name}} is this site's only passkey or its default.":
    "プライベートウィンドウでは自動ログインはオフで、{{name}} にはパスワードがないため、Pateat はログインしませんでした。{{name}} は既定にしていません。パスキーでログインするには、ページのパスキーログインボタンを押してください。{{name}} がこのサイトの唯一のパスキーか既定のときは、Pateat がそこでログインします。",
  "Pateat: automatic login is paused here, as this is not an allowed site.":
    "Pateat：許可サイトではないため、ここでは自動ログインを一時停止しています。",
  "Pateat: automatic login is paused on this site until turned back on.":
    "Pateat：このサイトの自動ログインは再開するまで一時停止中です。",
  "Automatic login is paused on this site, and {{name}} has no password, so Pateat did not log in. To sign in with its passkey, use the page's own passkey sign-in button and choose {{name}} in Pateat's window.":
    "このサイトの自動ログインは一時停止中で、{{name}} にはパスワードがないため、Pateat はログインしませんでした。パスキーでログインするには、ページのパスキーログインボタンを押し、Pateat のウィンドウで {{name}} を選んでください。",
  "Automatic login is paused on this site, and {{name}} has no password, so Pateat did not log in. {{name}} was not made the default. To sign in with its passkey, use the page's own passkey sign-in button and choose {{name}} in Pateat's window.":
    "このサイトの自動ログインは一時停止中で、{{name}} にはパスワードがないため、Pateat はログインしませんでした。{{name}} は既定にしていません。パスキーでログインするには、ページのパスキーログインボタンを押し、Pateat のウィンドウで {{name}} を選んでください。",
  "Automatic login is paused on {{host}}, so Pateat logs in only with the passkey you choose.":
    "{{host}} の自動ログインは一時停止中のため、Pateat は選んだパスキーでのみログインします。",
  "Automatic login is off in private windows.":
    "プライベートウィンドウでは自動ログインはオフです。",
  "Paused until turned back on": "再開するまで一時停止中",
  "10 minutes": "10 分",
  "1 hour": "1 時間",
  "Until turned back on": "再開するまで",
  "Automatic login on this site is paused for 10 minutes.":
    "このサイトの自動ログインを 10 分間一時停止しました。",
  "Automatic login on this site is paused until turned back on.":
    "このサイトの自動ログインを再開するまで一時停止しました。",
  "Change automatic login in private windows in settings":
    "プライベートウィンドウでの自動ログインを設定で変更",
  "Paused by a rule that also covers other sites.": "ほかのサイトも対象のルールで一時停止中です。",
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
  "Pateat cannot use the sync service on this device":
    "このデバイスでは Pateat が同期サービスを使えません",
  "no vault item matches this site": "このサイトに一致する保管庫のアイテムがありません",
  "the vault could not be read": "保管庫を読み取れませんでした",
  "the vault connection is turned off": "保管庫の接続が無効になっています",
  "this page came right after a sign-in": "このページはログイン直後のページです",
  "the page showed no sign-in form": "ページにログインフォームが表示されていませんでした",
  "the vault item has neither a password nor a passkey":
    "保管庫のアイテムにパスワードもパスキーもありません",
  "the vault item has no password, and Pateat leaves passkey requests on this site to the browser, as listed in its settings":
    "保管庫のアイテムにパスワードがなく、設定に登録されたこのサイトでは、Pateat はパスキーのリクエストをブラウザーに任せています",
  "the vault item has no password, and the recipe has no way on without one":
    "保管庫のアイテムにパスワードがなく、パスワードなしで進める手順がレシピにありません",
  "the vault item has no password": "保管庫のアイテムにパスワードがありません",
  "the site's sign-in link": "サイトのログインリンク",
  "the site's list of accounts": "サイトのアカウント一覧",
  "the rest of the site's sign-in": "サイトのログインの続き",
  "the site's changed sign-in page": "サイトの変更されたログインページ",
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
  "The login could not be confirmed.": "ログインを確認できませんでした。",
  "Logged in.": "ログインしました。",
  "Waiting for you to finish the site's other step, such as a code.":
    "確認コードなど、サイトの追加操作の完了を待っています。",
  "The result is not known yet; the next pages are checked for it.":
    "結果はまだ不明です。次のページで結果を確認します。",
  "Logging in…": "ログイン中…",
  "no reason was recorded": "理由が記録されていません",
  "The login stopped: {{why}}.": "ログインが中断されました：{{why}}。",
  "The login did not succeed: {{why}}.": "ログインに成功しませんでした：{{why}}。",
  "The result of the login is not known: {{why}}.": "ログインの結果が分かりません：{{why}}。",
  "This recipe is not made again automatically.": "このレシピは自動では作り直されません。",
  "Pateat pressed keys on the page's software keyboard before it stopped. Reload the page before you enter the value.":
    "Pateat は中断する前にソフトウェアキーボードのキーを押しました。値を入力する前にページを再読み込みしてください。",
  "This page": "このページ",
  "Open the detailed log": "詳細ログを開く",
  matchingAccounts_one: "{{count}} 件のアカウントがこのページに一致します。",
  matchingAccounts_other: "{{count}} 件のアカウントがこのページに一致します。",
  matchingAccounts: "{{count}} 件のアカウントがこのページに一致します。",
  "{{title}}, {{sub}}, default": "{{title}}、{{sub}}（既定）",
  "{{title}}, {{sub}}": "{{title}}、{{sub}}",
  "{{text}}. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button":
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
  "The page changed, so nothing was started. {{name}} was not made the default. Reload it to choose again.":
    "ページが変わったため、ログインを開始しませんでした。{{name}} は既定のアカウントになっていません。もう一度選ぶには、ページを再読み込みしてください。",
  "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. {{name}} was not made the default. Close that tab, or wait up to 10 minutes, then choose again.":
    "別のタブでこのサイトへのログインが進行中か、成功していないため、このタブではログインしませんでした。{{name}} は既定のアカウントになっていません。そのタブを閉じるか、最大 10 分待ってから、もう一度選んでください。",
  "Pateat could not log in with {{name}} on this page. {{name}} was not made the default. Reload the page to choose again.":
    "このページでは {{name}} でログインできませんでした。{{name}} は既定のアカウントになっていません。もう一度選ぶには、ページを再読み込みしてください。",
  "This page no longer waits for an account choice. {{name}} was not made the default.":
    "このページはアカウントの選択を待っていません。{{name}} は既定のアカウントになっていません。",
  "Pateat: logged in.": "Pateat：ログインしました。",
  "Pateat: the result of the login is not known ({{reason}}). Click for details.":
    "Pateat：ログインの結果が分かりません（{{reason}}）。詳しくはクリックしてください。",
  "Pateat: the login did not succeed ({{reason}}). Click for details.":
    "Pateat：ログインに成功しませんでした（{{reason}}）。詳しくはクリックしてください。",
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
  badgeNotAllowedSite_one:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、このサイトは設定の許可サイトに入っていないため使えません。",
  badgeNotAllowedSite_other:
    "Pateat：このサイトに一致するアカウントが {{count}} 件ありますが、このサイトは設定の許可サイトに入っていないため使えません。",
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
  "Pateat: this device has not finished its first settings sync with the sync service, so this site's accounts were not counted.":
    "Pateat：このデバイスが同期サービスとの最初の設定同期を終えていないため、このサイトのアカウントを数えていません。",
  "Pateat: saved settings name a vault's account on another server, so this site's accounts were not counted.":
    "Pateat：保存済みの設定が保管庫のアカウントを別のサーバーのものとして登録しているため、このサイトのアカウントを数えていません。",
  "{{first}} {{next}}": "{{first}}{{next}}",
  "Pateat: asking the AI…": "Pateat：AI に問い合わせています…",
  "Pateat: the site did not accept the last login in this tab. Click to choose an account.":
    "Pateat：このタブでの前回のログインはサイトに受け付けられませんでした。クリックしてアカウントを選んでください。",
  "Pateat: the last login on this site stopped in this tab. Click to choose an account.":
    "Pateat：このタブでのこのサイトへの前回のログインは中断されました。クリックしてアカウントを選んでください。",
  "Pateat: {{count}} accounts match this page. Click to choose one.":
    "Pateat：{{count}} 件のアカウントがこのページに一致します。クリックして選んでください。",
  "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.":
    "Pateat：別のタブでこのサイトへのログインが進行中か、成功していません。ここでログインするには、そのタブを閉じるか、最大 10 分待ってからこのページを再読み込みしてください。",
  "Pateat: automatic login is paused on this site. Click to choose an account.":
    "Pateat：このサイトの自動ログインは一時停止中です。クリックしてアカウントを選んでください。",
  "Pateat: the site did not accept a login in another tab. Click to choose an account.":
    "Pateat：別のタブでのログインがサイトに受け付けられませんでした。クリックしてアカウントを選んでください。",
  "Pateat logged in to this site twice in 10 minutes. Click to choose an account.":
    "Pateat はこのサイトに 10 分間で 2 回ログインしました。クリックしてアカウントを選んでください。",
  "Pateat: you chose an account here without making it the default, so Pateat asks until an account is made the default. Click to choose an account.":
    "Pateat：このサイトでは既定にせずにアカウントを選んだため、いずれかのアカウントが既定になるまで確認します。クリックしてアカウントを選んでください。",
  "Pateat: automatic login is paused on this site until {{time}}.":
    "Pateat：このサイトの自動ログインは {{time}} まで一時停止中です。",
  "Automatic login is paused on this site.": "このサイトの自動ログインは一時停止中です。",
  "Pateat logged in to this site twice in the last 10 minutes, so it waits for you to choose.":
    "Pateat は直近 10 分間にこのサイトへ 2 回ログインしたため、アカウントの選択を待っています。",
  "You chose an account here without making it the default, so Pateat asks each time until an account is made the default.":
    "このサイトでは既定にせずにアカウントを選んだため、いずれかのアカウントが既定になるまで毎回確認します。",
  "{{name}} does not match this page.": "{{name}} はこのページに一致しません。",
  "Pateat is not running on this page yet. Reload it, then try again.":
    "Pateat はまだこのページで動いていません。再読み込みしてからもう一度お試しください。",
  "This page waits for an account choice. Choose the account there.":
    "このページはアカウントの選択を待っています。そちらでアカウントを選んでください。",
  "An account switch is already running in this tab.":
    "このタブではすでにアカウントの切り替えが進行中です。",
  "A login is running in this tab. Wait for it to end, then try again.":
    "このタブでログインが進行中です。終わるのを待ってからもう一度お試しください。",
  "Another tab's login or account switch on this site is running or waits for a code. Finish or close it, then try again.":
    "別のタブでこのサイトへのログインかアカウントの切り替えが進行中か、確認コードを待っています。それを終えるか閉じてから、もう一度お試しください。",
  "Pateat settings could not be read. Try again.":
    "Pateat の設定を読み込めませんでした。もう一度お試しください。",
  "Pateat needs its service to find how to log out. Pair it in the settings.":
    "ログアウトの方法を探すには Pateat のサービスが必要です。設定でペアリングしてください。",
  "Logging out to switch to {{name}}…": "{{name}} に切り替えるためにログアウトしています…",
  "Logged out. Pateat logs in with {{name}} on this site's login page in this tab.":
    "ログアウトしました。このタブのこのサイトのログインページで、Pateat が {{name}} でログインします。",
  "Pateat found no way to log out on this page, so it did not switch to {{name}}. Log out yourself, then choose the account.":
    "このページでログアウトの方法が見つからなかったため、Pateat は {{name}} に切り替えませんでした。ご自身でログアウトしてから、アカウントを選んでください。",
  "The only control Pateat found to log out may also log out other devices or close the account, so it did not switch to {{name}}. Log out yourself, then choose the account.":
    "Pateat が見つけたログアウトの操作は、他のデバイスからもログアウトするか、アカウントを閉じるおそれがあるため、{{name}} に切り替えませんでした。ご自身でログアウトしてから、アカウントを選んでください。",
  "Pateat stopped while logging out, so it did not switch to {{name}}. Check whether you are logged out, then choose the account.":
    "ログアウト中に Pateat が停止したため、{{name}} に切り替えませんでした。ログアウトしたかを確かめてから、アカウントを選んでください。",
  "The site still shows you logged in after 3 tries, so Pateat did not switch to {{name}}. Log out yourself, then choose the account.":
    "3 回試してもサイトにログインしたままと表示されるため、Pateat は {{name}} に切り替えませんでした。ご自身でログアウトしてから、アカウントを選んでください。",
  "Pateat could not log out to switch to {{name}}. Log out yourself, then choose the account.":
    "Pateat は {{name}} に切り替えるためのログアウトができませんでした。ご自身でログアウトしてから、アカウントを選んでください。",
  "This page asks for {{detail}}.": "このページは{{detail}}の入力を求めています。",
  Fill: "入力",
  Remove: "解除",
  "Personal details Pateat fills on this site": "Pateat がこのサイトで入力する個人情報",
  "Filled from {{field}}": "{{field}} から入力",
  "Filled from {{field}} (not saved yet)": "{{field}} から入力（未保存）",
  "Remove the link for {{detail}}": "{{detail}}の割り当てを解除",
  "Filling…": "入力中…",
  "Filled. Check it and submit the form; Pateat saves this choice once you are signed in.":
    "入力しました。内容を確認してフォームを送信してください。ログインに成功すると、この選択が保存されます。",
  "Nothing was filled. Reopen this popup and try again.":
    "何も入力しませんでした。このポップアップを開き直して、もう一度お試しください。",
  "Removing…": "解除中…",
  "Removed. Pateat no longer fills {{detail}} on this site.":
    "解除しました。今後このサイトでは{{detail}}を入力しません。",
  "This link was already removed.": "この割り当てはすでに解除されています。",
  "The link could not be removed. Reopen this popup and try again.":
    "割り当てを解除できませんでした。このポップアップを開き直して、もう一度お試しください。",
  "The link may not have been removed. Reopen this popup to see the links.":
    "割り当てが解除されていない可能性があります。割り当てを確認するには、このポップアップを開き直してください。",
  "your birth year and month": "生年月",
  "your birth month and day": "誕生日（月日）",
  "your birth date": "生年月日",
  "the last 4 digits of your phone number": "電話番号の下 4 桁",
  "the last 4 digits of your card number": "カード番号の下 4 桁",
  "your card's security code": "カードのセキュリティコード",
  "The page changed, so nothing was filled.": "ページが変わったため、何も入力しませんでした。",
  "This page no longer asks for it.": "このページはもうこの情報を求めていません。",
  "That field does not hold a value Pateat can use here.":
    "そのフィールドの値はここでは使えません。",
  "Pateat cannot read that field now. Unlock the vault and try again.":
    "そのフィールドを今は読み取れません。保管庫のロックを解除して、もう一度お試しください。",
  "The page did not accept the value.": "ページが値を受け付けませんでした。",
  "The master password was not entered, so nothing was read or filled.":
    "マスターパスワードが入力されなかったため、何も読み取らず入力もしていません。",
  "the answer to your secret question": "秘密の質問の答え",
  "your member or customer number": "会員番号またはお客様番号",
  "This page asks \u201C{{question}}\u201D.": "このページは「{{question}}」と尋ねています。",
  "Pateat\u2019s AI thinks this field holds the answer. Fill only if it does; Pateat then fills it whenever this question shows.":
    "Pateat の AI は、このフィールドが答えだと判断しました。正しい場合だけ「入力」を押してください。押すと、この質問が表示されるたびに Pateat が入力します。",
  "your card number": "カード番号",
  "your card's expiry date": "カードの有効期限",
  "your PIN": "暗証番号",
  "This page shows another account, so nothing was filled.":
    "このページには別のアカウントが表示されているため、何も入力しませんでした。",
  "ID {{id}}": "ID {{id}}",
  vaultsLocked_one:
    "{{count}} 個の保管庫がロック中のため、そのログインとパスキーは待機しています。",
  vaultsLocked_other:
    "{{count}} 個の保管庫がロック中のため、それらのログインとパスキーは待機しています。",
  "Unlock in settings": "設定でロック解除",
} satisfies Record<keyof typeof en, string>;
